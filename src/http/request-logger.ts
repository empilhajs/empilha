import type { MiddlewareFn } from "./http-adapter";
import { tryRequestContext } from "../context";
import { createRequestId } from "./request-id";

export type RequestLog = {
  level: "info" | "error";
  requestId: string;
  method: string;
  pathname: string;
  status: number;
  durationMs: number;
  error?: {
    status: number;
  };
};

export type RequestLogWriter = (entry: RequestLog) => void;

function writeToConsole(entry: RequestLog): void {
  console.info(JSON.stringify(entry));
}

/**
 * Cria um middleware que registra método, rota, status, duração e falhas da
 * requisição sem incluir headers, body ou mensagens de erro sensíveis.
 *
 * @param write Função responsável por persistir ou enviar cada registro.
 * @returns Middleware pronto para `app.useMiddleware()` ou `@Use()`.
 *
 * @example
 * app.useMiddleware(requestLogger())
 *
 * @example
 * app.useMiddleware(requestLogger((entry) => logger.info(entry)))
 */
export function requestLogger(
  write: RequestLogWriter = writeToConsole,
): MiddlewareFn {
  return async (request, next) => {
    const startedAt = performance.now();
    const requestId =
      tryRequestContext()?.requestId ??
      request.headers["x-request-id"] ??
      createRequestId();
    try {
      const response = await next();

      write({
        level: response.status >= 400 ? "error" : "info",
        requestId,
        method: request.method,
        pathname: request.pathname,
        status: response.status,
        durationMs: Math.round(performance.now() - startedAt),
        ...(response.status >= 400
          ? { error: { status: response.status } }
          : {}),
      });

      return response;
    } catch (error) {
      write({
        level: "error",
        requestId,
        method: request.method,
        pathname: request.pathname,
        status: 500,
        durationMs: Math.round(performance.now() - startedAt),
        error: { status: 500 },
      });
      throw error;
    }
  };
}
