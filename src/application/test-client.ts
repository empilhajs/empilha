import { serializeJson } from "../runtime/error-pipeline";
import { HttpAdapter } from "../http/http-adapter";

/** Opções de headers usadas pelo cliente de testes. */
export type TestRequestOptions = {
  headers?: HeadersInit;
};

/** Opções de uma requisição crua, incluindo body já serializado. */
export type TestRawRequestOptions = TestRequestOptions & {
  body?: BodyInit | null;
};

/**
 * Cliente HTTP em memória usado pelos testes do framework.
 *
 * As chamadas passam pelo mesmo `HttpAdapter` usado pelo servidor, mas não
 * abrem uma porta nem dependem da rede. Métodos `post`, `put` e `patch`
 * serializam automaticamente o body como JSON.
 */
export type TestClient = {
  get(path: string, options?: TestRequestOptions): Promise<Response>;
  post(
    path: string,
    body?: unknown,
    options?: TestRequestOptions,
  ): Promise<Response>;
  put(
    path: string,
    body?: unknown,
    options?: TestRequestOptions,
  ): Promise<Response>;
  patch(
    path: string,
    body?: unknown,
    options?: TestRequestOptions,
  ): Promise<Response>;
  delete(
    path: string,
    body?: unknown,
    options?: TestRequestOptions,
  ): Promise<Response>;
  request(
    method: string,
    path: string,
    options?: TestRawRequestOptions,
  ): Promise<Response>;
};

function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * Cria um cliente de testes ligado a um adapter HTTP.
 *
 * @param http - Adapter que receberá as requisições em memória.
 * @returns Cliente com métodos HTTP e `request()` genérico.
 *
 * @example
 * const response = await app.test().get("/users/10")
 * expect(response.status).toBe(200)
 */
export function createTestClient(http: HttpAdapter): TestClient {
  const request = (
    method: string,
    path: string,
    body?: unknown,
    options?: TestRequestOptions,
  ): Promise<Response> => {
    const hasBody = body !== undefined;
    const init: RequestInit = {
      method,
      headers: options?.headers,
    };

    if (hasBody) {
      const headers = new Headers(options?.headers);
      headers.set("content-type", "application/json");
      init.headers = headers;
      init.body = serializeJson(body);
    }

    return Promise.resolve(
      http.handleRequest(
        new Request(`http://test${normalizePath(path)}`, init),
      ),
    );
  };

  const rawRequest = (
    method: string,
    path: string,
    options?: TestRawRequestOptions,
  ): Promise<Response> =>
    Promise.resolve(
      http.handleRequest(
        new Request(`http://test${normalizePath(path)}`, {
          method,
          headers: options?.headers,
          body: options?.body,
        }),
      ),
    );

  return {
    get: (path, options) => request("GET", path, undefined, options),
    post: (path, body, options) => request("POST", path, body, options),
    put: (path, body, options) => request("PUT", path, body, options),
    patch: (path, body, options) => request("PATCH", path, body, options),
    delete: (path, body, options) => request("DELETE", path, body, options),
    request: (method, path, options) => rawRequest(method, path, options),
  };
}
