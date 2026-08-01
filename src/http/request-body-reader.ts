import { abortRequestScope, type RequestScope } from "../context/index";

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
 * Lê e valida o body JSON de uma requisição.
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
   * Lê, decodifica e faz parse do body JSON.
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

    const contentType = request.headers.get("content-type");
    if (
      contentType !== null &&
      !/^application\/json(?:\s*;|\s*$)/i.test(contentType)
    ) {
      throw new RequestBodyError(415, "Unsupported media type");
    }

    if (this.timeoutMs !== null) {
      return this.readWithTimeout(request.body, scope);
    }

    // O Bun possui um caminho nativo muito rápido para JSON pequeno quando o
    // Content-Length já prova que o limite será respeitado. Sem esse dado, a
    // leitura precisa materializar o body para verificar o limite.
    if (
      !this.customMaxBytes &&
      declaredLength !== null &&
      declaredLength > 0 &&
      declaredLength <= this.maxBytes
    ) {
      try {
        return await request.json();
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new RequestBodyError(400, "Invalid JSON body");
        }
        throw error;
      }
    }

    return this.readChunks(request.body);
  }

  /** Lê sem materializar um body cujo tamanho real ainda não foi provado. */
  private async readChunks(body: ReadableStream<Uint8Array>): Promise<unknown> {
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

    if (totalBytes === 0) return undefined;

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return this.parseJson(JSON_DECODER.decode(bytes));
  }

  private async readWithTimeout(
    body: ReadableStream<Uint8Array>,
    scope?: RequestScope,
  ): Promise<unknown> {
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

    if (totalBytes === 0) {
      return undefined;
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return this.parseJson(JSON_DECODER.decode(bytes));
  }

  private parseJson(text: string): unknown {
    try {
      return JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
    } catch {
      throw new RequestBodyError(400, "Invalid JSON body");
    }
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
