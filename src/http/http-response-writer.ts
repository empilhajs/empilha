import { createStringRecord } from "../utils/records";

const DEFAULT_CORS_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const DEFAULT_CORS_HEADERS = "Content-Type, Authorization";

function jsonBody(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

/** Resposta intermediária produzida por handlers do framework. */
export interface ServerResponse {
  status: number;
  body: string;
  jsonValue?: unknown;
  headers?: Record<string, string>;
}

type CorsConfig = {
  origin: string;
  methods: string;
  headers: string;
};

/**
 * Converte respostas internas em `Response` nativa e aplica headers comuns.
 *
 * O writer centraliza CORS, `Server`, content type e o caminho otimizado de
 * respostas compiladas.
 */
export class HttpResponseWriter {
  private cors: CorsConfig | null = null;

  private serverHeader: string | null = null;

  private baseHeaders: Record<string, string>;

  private baseHeadersWithoutContentType: Record<string, string>;

  private baseTextHeaders: Record<string, string>;

  constructor() {
    this.baseHeaders = createStringRecord();
    this.baseHeadersWithoutContentType = createStringRecord();
    this.baseTextHeaders = createStringRecord();
    this.rebuildBaseHeaders();
  }

  get corsEnabled(): boolean {
    return this.cors !== null;
  }

  /** Habilita CORS com os valores informados ou defaults seguros. */
  enableCors(
    origin = "*",
    methods = DEFAULT_CORS_METHODS,
    headers = DEFAULT_CORS_HEADERS,
  ): void {
    this.cors = {
      origin,
      methods,
      headers,
    };
    this.rebuildBaseHeaders();
  }

  /** Desabilita a inclusão de headers CORS nas respostas. */
  disableCors(): void {
    this.cors = null;
    this.rebuildBaseHeaders();
  }

  /** Define o valor do header `Server` das respostas. */
  setServerHeader(value: string): void {
    this.serverHeader = value;
    this.rebuildBaseHeaders();
  }

  /** Cria uma resposta JSON de erro com o status informado. */
  error(status: number, message: string): Response {
    return Response.json(
      { error: message },
      {
        status,
        headers: this.buildHeaders(),
      },
    );
  }

  /** Cria a resposta 204 de um preflight CORS. */
  preflight(): Response {
    return new Response(null, {
      status: 204,
      headers: this.buildHeaders(undefined, false),
    });
  }

  /** Serializa uma resposta normal produzida pelo handler. */
  write(response: ServerResponse): Response {
    const headers = this.buildHeaders(response.headers);

    if (response.jsonValue !== undefined) {
      return new Response(jsonBody(response.jsonValue), {
        status: response.status,
        headers,
      });
    }

    return new Response(response.body, {
      status: response.status,
      headers,
    });
  }

  /** Cria uma resposta textual sem passar por `ServerResponse`. */
  text(body: string, headers?: Record<string, string>): Response {
    return new Response(body, {
      headers: headers
        ? Object.assign(createStringRecord(), this.baseTextHeaders, headers)
        : this.baseTextHeaders,
    });
  }

  /** Cria uma resposta JSON diretamente a partir do valor retornado. */
  json(
    status: number,
    value: unknown,
    headers?: Record<string, string>,
  ): Response {
    return new Response(jsonBody(value), {
      status,
      headers: this.buildHeaders(headers),
    });
  }

  /** Cria uma resposta de arquivo preservando os headers comuns do adapter. */
  file(file: Bun.BunFile, headers?: Record<string, string>): Response {
    return new Response(file, {
      // O Bun deve inferir o content type do BunFile quando a rota não
      // substitui esse header explicitamente. Aplicar application/json aqui
      // corromperia silenciosamente respostas de arquivos.
      headers: this.buildHeaders(headers, false),
    });
  }

  /**
   * Serializa uma resposta já compilada sem criar `ServerResponse` intermediária.
   *
   * @param status - Status HTTP da resposta.
   * @param body - Body textual, usado quando `jsonValue` não existe.
   * @param jsonValue - Valor que será serializado como JSON.
   * @param headers - Headers específicos da rota.
   * @returns Response nativa pronta para o runtime.
   */
  writeFast(
    status: number,
    body: string,
    jsonValue?: unknown,
    headers?: Record<string, string>,
  ): Response {
    const responseHeaders = this.buildHeaders(headers);

    if (jsonValue !== undefined) {
      return new Response(jsonBody(jsonValue), {
        status,
        headers: responseHeaders,
      });
    }

    return new Response(body, {
      status,
      headers: responseHeaders,
    });
  }

  private buildHeaders(
    additional?: Record<string, string>,
    includeContentType = true,
  ): Record<string, string> {
    const base = includeContentType
      ? this.baseHeaders
      : this.baseHeadersWithoutContentType;

    return additional
      ? Object.assign(createStringRecord(), base, additional)
      : base;
  }

  private rebuildBaseHeaders(): void {
    const common = createStringRecord();

    if (this.cors) {
      common["Access-Control-Allow-Origin"] = this.cors.origin;
      common["Access-Control-Allow-Methods"] = this.cors.methods;
      common["Access-Control-Allow-Headers"] = this.cors.headers;
    }

    if (this.serverHeader) {
      common.Server = this.serverHeader;
    }

    this.baseHeadersWithoutContentType = common;
    this.baseHeaders = {
      ...common,
      "Content-Type": "application/json",
    };
    this.baseTextHeaders = {
      ...common,
      "Content-Type": "text/plain; charset=utf-8",
    };
  }
}
