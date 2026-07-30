import type { MiddlewareFn } from "./http-adapter";
import { requestContext } from "../context";

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
 * Cria um middleware que registra método, rota, status e duração da requisição.
 *
 * @param write Função responsável por persistir ou enviar cada registro.
 * @returns Middleware pronto para `app.use()` ou `@Use()`.
 *
 * @example
 * app.use(requestLogger())
 *
 * @example
 * app.use(requestLogger((entry) => logger.info(entry)))
 */
export function requestLogger(
  write: RequestLogWriter = writeToConsole,
): MiddlewareFn {
  return async (request, next) => {
    const startedAt = performance.now();
    const response = await next();

    write({
      level: response.status >= 400 ? "error" : "info",
      requestId: requestContext().requestId,
      method: request.method,
      pathname: request.pathname,
      status: response.status,
      durationMs: Math.round(performance.now() - startedAt),
      ...(response.status >= 400 ? { error: { status: response.status } } : {}),
    });

    return response;
  };
}
