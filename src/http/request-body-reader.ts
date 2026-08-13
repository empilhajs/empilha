import { abortRequestScope, type RequestScope } from "../context";

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const JSON_DECODER = new TextDecoder();

/** Erro de leitura do body com status HTTP específico. */
export class RequestBodyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Lê e valida o body de uma requisição.
 *
 * A leitura é feita em chunks para respeitar o limite de bytes antes de
 * montar a string completa. O timeout cancela o reader e o request scope.
 */
export class JsonBodyReader {
  private maxBytes = DEFAULT_MAX_BODY_BYTES;

  private customMaxBytes = false;

  private timeoutMs: number | null = null;

  get hasTimeout(): boolean {
    return this.timeoutMs !== null;
  }

  get hasCustomMaxBytes(): boolean {
    return this.customMaxBytes;
  }

  /** Define o limite máximo do body em bytes. */
  setMaxBytes(bytes: number): void {
    if (!Number.isInteger(bytes) || bytes <= 0) {
      throw new RangeError("O limite do body deve ser um inteiro positivo.");
    }

    this.maxBytes = bytes;
    this.customMaxBytes = true;
  }

  /** Define o timeout de leitura ou `null` para desabilitá-lo. */
  setTimeout(milliseconds: number | null): void {
    if (
      milliseconds !== null &&
      (!Number.isInteger(milliseconds) || milliseconds <= 0)
    ) {
      throw new RangeError(
        "O timeout de body deve ser um inteiro positivo ou null.",
      );
    }

    this.timeoutMs = milliseconds;
  }

  /**
   * Lê, decodifica e faz parse do body conforme o Content-Type.
   *
   * @param request - Request cujo body será consumido.
   * @param scope - Scope usado para abortar a leitura em timeout.
   * @returns Valor produzido por `JSON.parse`, ou `undefined` para body vazio.
   * @throws {RequestBodyError} Para JSON inválido, body excedente ou timeout.
   */
  async read(request: Request, scope?: RequestScope): Promise<unknown> {
    const declaredLength = this.getDeclaredContentLength(request);

    this.assertContentLength(declaredLength);

    if (!request.body) {
      return undefined;
    }

    const contentType =
      request.headers.get("content-type") ?? "application/json";
    if (!this.supportedContentType(contentType)) {
      throw new RequestBodyError(415, "Unsupported media type");
    }

    // Content-Length é apenas uma indicação do cliente. O limite é aplicado
    // aos bytes efetivamente lidos antes de o JSON ser materializado.
    const bytes =
      this.timeoutMs !== null
        ? await this.readWithTimeout(request.body, scope)
        : await this.readChunks(request.body);
    return this.parseBody(bytes, contentType);
  }

  /** Lê sem materializar um body cujo tamanho real ainda não foi provado. */
  private async readChunks(
    body: ReadableStream<Uint8Array>,
  ): Promise<Uint8Array> {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;
        if (!value) continue;

        totalBytes += value.byteLength;
        if (totalBytes > this.maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // O erro de limite é mais relevante.
          }
          throw new RequestBodyError(413, "Payload too large");
        }

        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    if (totalBytes === 0) return new Uint8Array();

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return bytes;
  }

  private async readWithTimeout(
    body: ReadableStream<Uint8Array>,
    scope?: RequestScope,
  ): Promise<Uint8Array> {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let bodyTimedOut = false;
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        bodyTimedOut = true;
        const error = new RequestBodyError(408, "Request body timeout");

        if (scope) abortRequestScope(scope, error);
        reject(error);
        void reader.cancel(error).catch(() => {});
      }, this.timeoutMs as number);
    });

    try {
      while (true) {
        const { done, value } = await Promise.race([reader.read(), timedOut]);

        if (done) {
          break;
        }

        if (!value) {
          continue;
        }

        totalBytes += value.byteLength;

        if (totalBytes > this.maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // O erro de limite é mais relevante.
          }

          throw new RequestBodyError(413, "Payload too large");
        }

        chunks.push(value);
      }
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }

      if (!bodyTimedOut) {
        reader.releaseLock();
      }
    }

    if (totalBytes === 0) return new Uint8Array();

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return bytes;
  }

  private parseBody(bytes: Uint8Array, contentType: string): unknown {
    if (bytes.byteLength === 0) return undefined;

    const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
    const text = JSON_DECODER.decode(bytes).replace(/^\uFEFF/, "");

    if (mediaType === "text/plain" || mediaType.startsWith("text/")) {
      return text;
    }

    if (mediaType === "application/x-www-form-urlencoded") {
      const result: Record<string, string | string[]> = Object.create(null);
      for (const [key, value] of new URLSearchParams(text)) {
        const previous = result[key];
        if (previous === undefined) result[key] = value;
        else if (Array.isArray(previous)) previous.push(value);
        else result[key] = [previous, value];
      }
      return result;
    }

    if (mediaType === "multipart/form-data") {
      const form = new Request("http://empilha/body", {
        method: "POST",
        headers: { "content-type": contentType },
        body: bytes.buffer as ArrayBuffer,
      });
      return form.formData().then((data) => {
        const result: Record<
          string,
          FormDataEntryValue | FormDataEntryValue[]
        > = Object.create(null);
        for (const [key, value] of data.entries()) {
          const previous = result[key];
          if (previous === undefined) result[key] = value;
          else if (Array.isArray(previous)) previous.push(value);
          else result[key] = [previous, value];
        }
        return result;
      });
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new RequestBodyError(400, "Invalid JSON body");
    }
  }

  private supportedContentType(contentType: string): boolean {
    const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
    return (
      mediaType === "application/json" ||
      mediaType === "application/x-www-form-urlencoded" ||
      mediaType === "multipart/form-data" ||
      mediaType.startsWith("text/")
    );
  }

  private getDeclaredContentLength(request: Request): number | null {
    const contentLength = request.headers.get("content-length");

    if (contentLength === null) return null;

    const declaredLength = Number(contentLength);
    return Number.isFinite(declaredLength) && declaredLength >= 0
      ? declaredLength
      : null;
  }

  private assertContentLength(declaredLength: number | null): void {
    if (declaredLength !== null && declaredLength > this.maxBytes) {
      throw new RequestBodyError(413, "Payload too large");
    }
  }
}
