import type { HttpResponseWriter } from "./http-response-writer";
import type { ServerHandler } from "./adapter-types";
import { normalizePath } from "../router/path";
import { parseRequestPath, parseRequestQuery } from "./request-parsing";
import { serializeJson } from "../utils/serialize-json";
import { isPromise } from "./adapter-helpers";

export type ConvenienceRouteContext = {
  readonly responses: HttpResponseWriter;
  readonly addRoute: (
    method: string,
    path: string,
    handler: ServerHandler,
  ) => void;
  readonly addNativeRoute: (
    method: string,
    path: string,
    handler: (request: Request) => Response | Promise<Response>,
  ) => void;
  readonly maxQueryBytes: number;
  readonly maxQueryParameters: number;
  readonly handleDispatchError: (error: unknown) => Promise<Response>;
};

function assertStaticPath(path: string, resource: string): string {
  const normalized = normalizePath(path);
  if (normalized.includes(":")) {
    throw new Error(`${resource} não podem usar parâmetros de rota.`);
  }
  return normalized;
}

export function registerTextRoute(
  context: ConvenienceRouteContext,
  path: string,
  body: string,
  headers?: Record<string, string>,
): void {
  assertStaticPath(path, "Respostas estáticas");
  const handler: ServerHandler = () => context.responses.text(body, headers);
  Object.assign(handler, { stateless: true });
  context.addRoute("GET", path, handler);
}

export function registerJsonRoute(
  context: ConvenienceRouteContext,
  path: string,
  value: unknown,
  headers?: Record<string, string>,
): void {
  assertStaticPath(path, "Respostas estáticas");
  const body = serializeJson(value);
  const handler: ServerHandler = () => ({
    status: 200,
    body,
    headers: { "Content-Type": "application/json", ...headers },
  });
  Object.assign(handler, { stateless: true });
  context.addRoute("GET", path, handler);
}

export function registerQueryTextRoute(
  context: ConvenienceRouteContext,
  path: string,
  handler: (
    params: Record<string, string>,
    query: Record<string, string>,
  ) => string,
  headers: Record<string, string> = {},
): void {
  const routeHandler: ServerHandler = (request) =>
    context.responses.text(
      handler(request.rawParams, request.rawQuery as Record<string, string>),
      headers,
    );
  Object.assign(routeHandler, {
    needsQuery: true,
    minimalRequest: true,
    synchronous: true,
  });
  context.addRoute("GET", path, routeHandler);
  context.addNativeRoute("GET", normalizePath(path), (request) => {
    try {
      const parsed = parseRequestPath(request.url);
      const params =
        (request as Request & { params?: Record<string, string> }).params ??
        Object.create(null);
      const query = parseRequestQuery(request.url, parsed.queryStart, {
        maxBytes: context.maxQueryBytes,
        maxParameters: context.maxQueryParameters,
      });
      return context.responses.text(
        handler(params, query as Record<string, string>),
        headers,
      );
    } catch (error) {
      return context.handleDispatchError(error);
    }
  });
}

export function registerPostJsonRoute(
  context: ConvenienceRouteContext,
  path: string,
  handler: (body: unknown) => unknown | Response | Promise<unknown | Response>,
  headers: Record<string, string> = {},
): void {
  const writeResult = (result: unknown | Response): Response =>
    result instanceof Response
      ? result
      : context.responses.json(200, result, headers);
  const routeHandler: ServerHandler = (request) => {
    const result = handler(request.body);
    return isPromise(result) ? result.then(writeResult) : writeResult(result);
  };
  Object.assign(routeHandler, { needsBody: true, minimalRequest: true });
  context.addRoute("POST", path, routeHandler);
}

export function registerFileRoute(
  context: ConvenienceRouteContext,
  path: string,
  file: Bun.BunFile,
  headers?: Record<string, string>,
): void {
  assertStaticPath(path, "Arquivos estáticos");
  const handler: ServerHandler = () => context.responses.file(file, headers);
  Object.assign(handler, { stateless: true });
  context.addRoute("GET", path, handler);
}
