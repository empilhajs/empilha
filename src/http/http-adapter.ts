import { RouteTree } from "../router/route-tree";
import { normalizeMethod, normalizePath } from "../router/path";
import {
  abortRequestScope,
  createRequestScope,
  requestContext,
  runWithRequestContext,
  type RequestScope,
} from "../context/index";
import { Container } from "../di/index";
import { JsonBodyReader, RequestBodyError } from "./request-body-reader";
import {
  HttpResponseWriter,
  type ServerResponse,
} from "./http-response-writer";
import { runMiddlewareChain } from "./middleware-chain";
import {
  type ConfiguredHandler,
  type ErrorHandler,
  type HandlerOptions,
  type MiddlewareFn,
  type ServerHandler,
  type ServerHandlerResult,
  type ServerRequest,
} from "./adapter-types";
import { isPromise, validateTimeout } from "./adapter-helpers";
import { RequestTracker } from "./request-tracker";
import {
  headersToRecord,
  parseRequestPath,
  parseRequestQuery,
  type ParsedRequestPath,
} from "./request-parsing";
import { EMPTY_STRING_RECORD } from "../utils/records";
import { withTimeout } from "../utils/timeout";
import { ApplicationLogger, type Logger } from "../utils/logger";
import { HttpServer, type NativeRouteValue } from "./http-server";
import { addRequestId } from "./request-id";
export type { ServerResponse } from "./http-response-writer";
export type {
  ErrorHandler,
  HandlerOptions,
  MiddlewareFn,
  ServerHandler,
  ServerHandlerResult,
  ServerRequest,
} from "./adapter-types";

const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type MatchedRoute = {
  handler: ServerHandler;
  params: Record<string, string>;
};

// Handlers que não declaram nenhuma dependência do request recebem este valor
// apenas para manter a assinatura do pipeline. Ele evita materializar um
// ServerRequest novo para cada ping/rota estática.
const EMPTY_SERVER_REQUEST: ServerRequest = Object.freeze({
  method: "",
  pathname: "/",
  rawQuery: EMPTY_STRING_RECORD,
  query: EMPTY_STRING_RECORD,
  headers: EMPTY_STRING_RECORD,
  rawParams: EMPTY_STRING_RECORD,
  params: EMPTY_STRING_RECORD,
  body: undefined,
});

/**
 * Adapta handlers do framework ao servidor HTTP do Bun.
 *
 * O `RouteTree` é a fonte de verdade das rotas. A entrada do servidor passa
 * pelo mesmo dispatcher usado pelo cliente de testes, preservando hooks,
 * middleware, contexto e tratamento de erros.
 */
export class HttpAdapter {
  private readonly router = new RouteTree<ServerHandler>();

  private readonly nativeRoutes: Record<string, unknown> = Object.create(null);

  private readonly middlewares: MiddlewareFn[] = [];

  private readonly responses = new HttpResponseWriter();

  private readonly bodyReader = new JsonBodyReader();

  private handlerTimeoutMs: number | null = 30_000;

  private requestConcurrency: number | null = null;

  private requestIdEnabled = true;

  private requestScopeFactory: (() => Container) | undefined;

  private readonly requests = new RequestTracker();

  private readonly server = new HttpServer(
    (request) => this.handleRequest(request),
    this.requests,
    () =>
      this.middlewares.length === 0 &&
      this.handlerTimeoutMs === null &&
      this.requestConcurrency === null &&
      !this.bodyReader.hasTimeout &&
      !this.bodyReader.hasCustomMaxBytes
        ? (this.nativeRoutes as Record<string, NativeRouteValue>)
        : undefined,
  );

  private errorHandler: ErrorHandler = async () => ({
    status: 500,
    body: JSON.stringify({ error: "Internal server error" }),
  });

  private logger: Logger = new ApplicationLogger();

  setLogger(logger: Logger): void {
    this.logger = logger;
  }

  /** Define a factory usada para criar containers de request scope. */
  setRequestScopeFactory(factory: () => Container): void {
    this.requestScopeFactory = factory;
  }

  /** Define o header `Server` aplicado pelo response writer. */
  setServerHeader(value: string): void {
    this.responses.setServerHeader(value);
  }

  /** Habilita ou desabilita o header automático `X-Request-Id`. */
  setRequestIdEnabled(enabled: boolean): void {
    this.requestIdEnabled = enabled;
    this.server.setRequestIdEnabled(enabled);
  }

  /** Adiciona um middleware global ao pipeline completo. */
  use(middleware: MiddlewareFn): void {
    this.middlewares.push(middleware);
  }

  /** Define o conversor global de erros para respostas HTTP. */
  setErrorHandler(handler: ErrorHandler): void {
    this.errorHandler = handler;
  }

  /** Valida um lote de rotas sem alterar o router ativo. */
  assertRoutesAvailable(
    routes: readonly { method: string; path: string }[],
  ): void {
    this.router.assertCanInsert(routes);
  }

  /** Captura o registro de rotas para rollback durante o bootstrap. */
  snapshotRoutes(): RouteTree<ServerHandler> {
    return this.router.snapshot();
  }

  /** Restaura o registro de rotas após uma falha no bootstrap. */
  restoreRoutes(snapshot: RouteTree<ServerHandler>): void {
    this.router.restoreAndConsume(snapshot);
  }

  /** Habilita CORS no adapter e configura o preflight. */
  enableCors(
    origin = "*",
    methods?: string,
    headers?: string,
    credentials?: boolean,
    maxAge?: number,
  ): void {
    this.responses.enableCors(origin, methods, headers, credentials, maxAge);
  }

  /** Desabilita CORS para as respostas do adapter. */
  disableCors(): void {
    this.responses.disableCors();
  }

  /** Define o limite global de leitura de bodies JSON. */
  setMaxBodyBytes(bytes: number): void {
    this.bodyReader.setMaxBytes(bytes);
  }

  /** Define o timeout dos handlers ou `null` para desabilitá-lo. */
  setHandlerTimeout(milliseconds: number | null): void {
    this.handlerTimeoutMs = validateTimeout(milliseconds, "handler");
  }

  /** Define o timeout de leitura do body ou `null`. */
  setBodyTimeout(milliseconds: number | null): void {
    this.bodyReader.setTimeout(milliseconds);
  }

  /** Define o prazo máximo para drenar requisições no shutdown. */
  setShutdownTimeout(milliseconds: number | null): void {
    this.server.setShutdownTimeout(milliseconds);
  }

  /** Limita requisições simultâneas ou remove o limite com `null`. */
  setRequestConcurrency(limit: number | null): void {
    if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
      throw new RangeError(
        "O limite de requisições deve ser um inteiro positivo ou null.",
      );
    }

    this.requestConcurrency = limit;
  }

  /** URL do servidor Bun enquanto ele estiver escutando. */
  get url(): URL | null {
    return this.server.url;
  }

  /** Porta efetiva do servidor Bun enquanto ele estiver escutando. */
  get port(): number | null {
    return this.server.port;
  }

  // -------------------------------------------------------------------------
  // Dispatch e tratamento de erros
  // -------------------------------------------------------------------------

  private withHandlerTimeout(response: Promise<Response>): Promise<Response> {
    if (this.handlerTimeoutMs === null) {
      return response;
    }

    const scope = requestContext();
    // A resposta de timeout pode ser devolvida antes do handler terminar,
    // mas o scope precisa permanecer vivo até a Promise original concluir.
    // Caso contrário, dependências request-scoped podem ser descartadas em
    // meio à execução do handler.
    scope.waitUntil(response);

    return withTimeout(response, this.handlerTimeoutMs, () => {
      abortRequestScope(scope, new Error("Handler timeout"));
      return this.responses.error(504, "Handler timeout");
    }).catch((error) => {
      this.logger.error(error, "Falha ao produzir resposta HTTP.");
      return this.responses.error(500, "Internal server error");
    });
  }

  private handleDispatchError(error: unknown): Promise<Response> {
    return this.errorHandler(error)
      .then((response) => this.responses.write(response))
      .catch((handlerError) => {
        this.logger.error(
          {
            cause: error,
            handlerError,
          },
          "O error handler HTTP falhou.",
        );
        return this.responses.error(500, "Internal server error");
      });
  }

  private dispatchHandler(
    req: ServerRequest,
    handler: ConfiguredHandler,
  ): Response | Promise<Response> {
    try {
      const result = this.middlewares.length
        ? runMiddlewareChain(
            req,
            this.middlewares,
            handler as (
              req: ServerRequest,
            ) => ServerResponse | Promise<ServerResponse>,
          )
        : handler(req);

      if (isPromise(result)) {
        return this.withHandlerTimeout(
          result
            .then((response) =>
              this.normalizeHandlerResponse(response, handler.responseType),
            )
            .catch((error) => this.handleDispatchError(error)),
        );
      }

      return this.normalizeHandlerResponse(result, handler.responseType);
    } catch (error) {
      return this.handleDispatchError(error);
    }
  }

  private normalizeHandlerResponse(
    response: ServerHandlerResult,
    responseType?: ConfiguredHandler["responseType"],
  ): Response {
    if (response instanceof Response) return response;
    if (typeof response === "string") return this.responses.text(response);

    if (responseType === "json" && response.jsonValue !== undefined) {
      return this.responses.json(
        response.status,
        response.jsonValue,
        response.headers,
      );
    }

    return this.responses.write(response);
  }

  private findRoute(method: string, path: string): MatchedRoute | null {
    return this.router.find(method, path);
  }

  private createServerRequest(
    request: Request,
    pathname: string,
    params: Record<string, string>,
    options: HandlerOptions,
    queryStart: number,
  ): ServerRequest {
    const rawQuery = options.needsQuery
      ? parseRequestQuery(request.url, queryStart)
      : EMPTY_STRING_RECORD;
    const minimalRequest = options.minimalRequest === true;
    return {
      method: request.method,
      pathname,
      rawQuery,
      // QueryParams substitui `query` por um novo objeto quando normaliza a
      // rota. Sem schema, o mapa bruto já é o mapa efetivo e não precisa de
      // uma segunda cópia por request.
      query: minimalRequest ? EMPTY_STRING_RECORD : rawQuery,
      headers: options.needsHeaders
        ? headersToRecord(request.headers)
        : EMPTY_STRING_RECORD,
      rawParams: params,
      // Params não sofre conversão no pipeline; compartilhar o mapa evita
      // outra alocação sem compartilhar estado entre requisições dinâmicas.
      params: minimalRequest ? EMPTY_STRING_RECORD : params,
      body: undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Escopo da requisição e entrada HTTP
  // -------------------------------------------------------------------------

  private handleRequestBody(
    request: Request,
    serverRequest: ServerRequest,
    handler: ConfiguredHandler,
  ): Promise<Response> {
    return this.bodyReader
      .read(request, this.bodyReader.hasTimeout ? requestContext() : undefined)
      .then((body) => {
        serverRequest.body = body;
        return this.dispatchHandler(serverRequest, handler);
      })
      .catch((error) => {
        if (error instanceof RequestBodyError) {
          return this.responses.error(error.status, error.message);
        }

        return this.handleDispatchError(error);
      });
  }

  // -------------------------------------------------------------------------
  // Pipeline de uma requisição
  // -------------------------------------------------------------------------

  /**
   * Processa uma Request sem abrir servidor de rede.
   *
   * É usado pelo `fetch` do Bun e pelo cliente de testes. A rota é encontrada
   * antes da decisão de scope para que respostas 404 e rotas stateless evitem
   * o custo de AsyncLocalStorage.
   *
   * @param request - Request nativa a ser processada.
   * @returns Response imediata ou Promise de Response.
   */
  handleRequest(request: Request): Response | Promise<Response> {
    let parsedPath: ParsedRequestPath;

    try {
      parsedPath = parseRequestPath(request.url);
    } catch {
      return this.runRequestWithoutScope(request, () =>
        this.responses.error(400, "Bad request"),
      );
    }

    if (
      request.method === "OPTIONS" &&
      this.responses.corsEnabled &&
      request.headers.has("Access-Control-Request-Method")
    ) {
      return this.runRequestWithoutScope(request, () =>
        this.responses.preflight(request),
      );
    }

    let route: MatchedRoute | null;

    try {
      route = this.findRoute(request.method, parsedPath.pathname);
    } catch {
      return this.runRequestWithoutScope(request, () =>
        this.responses.error(400, "Bad request"),
      );
    }

    if (!route) {
      return this.runRequestWithoutScope(request, () =>
        this.responses.error(404, "Not found"),
      );
    }

    return this.dispatchMatchedRequest(request, parsedPath, route);
  }

  /** Executa uma rota já encontrada pelo RouteTree ou pelo roteador do Bun. */
  private dispatchMatchedRequest(
    request: Request,
    parsedPath: ParsedRequestPath,
    route: MatchedRoute,
  ): Response | Promise<Response> {
    const handler = route.handler as ConfiguredHandler;

    // Rotas simples não precisam de AsyncLocalStorage, AbortController nem de
    // um container filho por requisição. Além de reduzir o custo normal do
    // pipeline, isso evita que cada request deixe um conjunto de objetos
    // nativos aguardando o próximo ciclo de coleta do Bun.
    //
    // O timeout padrão usa requestContext() para abortar o scope quando vence,
    // portanto ele também exige um scope. Aplicações que desabilitam o timeout
    // (como rotas estáticas e o benchmark) podem usar o caminho leve.
    if (!handler.requiresRequestContext && this.handlerTimeoutMs === null) {
      if (
        (handler.stateless || handler.synchronous) &&
        this.requestConcurrency === null
      ) {
        return this.handleRequestInContext(request, parsedPath, route);
      }

      return this.runRequestWithoutScope(request, () =>
        this.handleRequestInContext(request, parsedPath, route),
      );
    }

    const run = this.runRequestScope.bind(this);

    return run(request, () =>
      this.handleRequestInContext(request, parsedPath, route),
    );
  }

  private runRequestWithoutScope(
    _request: Request,
    callback: () => Response | Promise<Response>,
  ): Response | Promise<Response> {
    if (!this.requests.tryEnter(this.requestConcurrency)) {
      return this.responses.error(503, "Request concurrency limit reached");
    }

    try {
      const response = callback();

      if (isPromise(response)) {
        return response
          .then((value) => this.withRequestId(value))
          .finally(() => {
            this.requests.leave();
          });
      }

      this.requests.leave();
      return this.withRequestId(response);
    } catch (error) {
      this.requests.leave();
      throw error;
    }
  }

  private runRequestScope(
    request: Request,
    callback: () => Response | Promise<Response>,
  ): Response | Promise<Response> {
    if (!this.requests.tryEnter(this.requestConcurrency)) {
      return this.responses.error(503, "Request concurrency limit reached");
    }

    let scope: RequestScope;

    try {
      scope = createRequestScope(
        request,
        this.requestScopeFactory?.() ?? new Container(),
      );
    } catch (error) {
      this.requests.leave();
      throw error;
    }

    this.requests.trackScope(scope);

    try {
      const response = runWithRequestContext(scope, callback);

      const withScopeRequestId = (value: Response): Response => {
        return this.withRequestId(value, scope.requestId);
      };

      if (isPromise(response)) {
        return response
          .then(withScopeRequestId)
          .finally(() => this.requests.cleanupScope(scope));
      }

      this.requests.cleanupScope(scope);
      return withScopeRequestId(response);
    } catch (error) {
      this.requests.cleanupScope(scope);
      throw error;
    }
  }

  private withRequestId(response: Response, requestId?: string): Response {
    return this.requestIdEnabled ? addRequestId(response, requestId) : response;
  }

  private handleRequestInContext(
    request: Request,
    parsedPath: ParsedRequestPath,
    route: MatchedRoute,
  ): Response | Promise<Response> {
    const { pathname } = parsedPath;

    const handler = route.handler as ConfiguredHandler;
    const hasGlobalMiddleware = this.middlewares.length > 0;

    if (!hasGlobalMiddleware && handler.stateless) {
      return this.dispatchHandler(EMPTY_SERVER_REQUEST, handler);
    }

    let serverRequest: ServerRequest;

    try {
      serverRequest = this.createServerRequest(
        request,
        pathname,
        route.params,
        hasGlobalMiddleware
          ? {
              needsQuery: true,
              needsHeaders: true,
              needsBody: true,
            }
          : handler,
        parsedPath.queryStart,
      );
    } catch {
      return this.responses.error(400, "Bad request");
    }

    if (
      (handler.needsBody || hasGlobalMiddleware) &&
      BODY_METHODS.has(request.method)
    ) {
      return this.handleRequestBody(request, serverRequest, handler);
    }

    return this.dispatchHandler(serverRequest, handler);
  }

  // -------------------------------------------------------------------------
  // Registro de rotas e integração com Bun
  // -------------------------------------------------------------------------

  private addRoute(method: string, path: string, handler: ServerHandler): void {
    const normalizedMethod = normalizeMethod(method);

    const normalizedPath = normalizePath(path);
    this.router.insert(normalizedMethod, normalizedPath, handler);

    const configured = handler as ConfiguredHandler;
    if (
      configured.length === 0 &&
      !configured.needsRequest &&
      !configured.needsQuery &&
      !configured.needsHeaders &&
      !configured.needsBody &&
      !configured.requiresRequestContext
    ) {
      this.addNativeRoute(normalizedMethod, normalizedPath, (_request) => {
        try {
          const result = handler(undefined as never);
          if (isPromise(result)) {
            return result
              .then((response) =>
                this.normalizeHandlerResponse(
                  response,
                  configured.responseType,
                ),
              )
              .catch((error) => this.handleDispatchError(error));
          }
          return this.normalizeHandlerResponse(result, configured.responseType);
        } catch (error) {
          return this.handleDispatchError(error);
        }
      });
    }
  }

  private addNativeRoute(
    method: string,
    path: string,
    handler: NativeRouteValue,
  ): void {
    const current = this.nativeRoutes[path];
    if (current && typeof current === "object") {
      (current as Record<string, NativeRouteValue>)[method] = handler;
      return;
    }
    this.nativeRoutes[path] = { [method]: handler };
  }

  /** Registra um handler para GET. */
  get(path: string, handler: ServerHandler): void {
    this.addRoute("GET", path, handler);
  }

  /** Registra um handler para HEAD. */
  head(path: string, handler: ServerHandler): void {
    this.addRoute("HEAD", path, handler);
  }

  /** Registra um handler para OPTIONS. */
  options(path: string, handler: ServerHandler): void {
    this.addRoute("OPTIONS", path, handler);
  }

  /**
   * Registra uma resposta textual imutável no pipeline comum.
   */
  getText(path: string, body: string, headers?: Record<string, string>): void {
    if (normalizePath(path).includes(":")) {
      throw new Error("Respostas estáticas não podem usar parâmetros de rota.");
    }

    const handler: ServerHandler = () => this.responses.text(body, headers);
    Object.assign(handler, { stateless: true });
    this.get(path, handler);
  }

  /** Registra JSON imutável com serialização feita uma única vez. */
  getJson(
    path: string,
    value: unknown,
    headers?: Record<string, string>,
  ): void {
    if (normalizePath(path).includes(":")) {
      throw new Error("Respostas estáticas não podem usar parâmetros de rota.");
    }

    const body = JSON.stringify(value) ?? "null";
    const handler: ServerHandler = () => ({
      status: 200,
      body,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    });
    Object.assign(handler, { stateless: true });
    this.get(path, handler);
  }

  /**
   * Registra uma rota de texto que acessa apenas params e query.
   */
  getQueryText(
    path: string,
    handler: (
      params: Record<string, string>,
      query: Record<string, string>,
    ) => string,
    headers: Record<string, string> = {},
  ): void {
    const routeHandler: ServerHandler = (request) =>
      this.responses.text(
        handler(request.rawParams, request.rawQuery as Record<string, string>),
        headers,
      );
    Object.assign(routeHandler, {
      needsQuery: true,
      minimalRequest: true,
      synchronous: true,
    });
    this.addRoute("GET", path, routeHandler);
    this.addNativeRoute("GET", normalizePath(path), (request) => {
      try {
        const parsed = parseRequestPath(request.url);
        const params =
          (
            request as Request & {
              params?: Record<string, string>;
            }
          ).params ?? EMPTY_STRING_RECORD;
        const query = parseRequestQuery(request.url, parsed.queryStart);
        return this.responses.text(
          handler(params, query as Record<string, string>),
          headers,
        );
      } catch (error) {
        return this.handleDispatchError(error);
      }
    });
  }

  /**
   * Registra o caso comum de receber JSON e devolvê-lo como JSON. A leitura
   * continua respeitando maxBodyBytes e os erros HTTP do JsonBodyReader.
   */
  postJson(
    path: string,
    handler: (
      body: unknown,
    ) => unknown | Response | Promise<unknown | Response>,
    headers: Record<string, string> = {},
  ): void {
    const writeResult = (result: unknown | Response): Response =>
      result instanceof Response
        ? result
        : this.responses.json(200, result, headers);

    const routeHandler: ServerHandler = (request) => {
      const result = handler(request.body);
      return isPromise(result) ? result.then(writeResult) : writeResult(result);
    };
    Object.assign(routeHandler, { needsBody: true, minimalRequest: true });
    this.addRoute("POST", path, routeHandler);
  }

  /** Registra uma resposta de arquivo mantendo streaming e range do Bun. */
  getFile(
    path: string,
    file: Bun.BunFile,
    headers?: Record<string, string>,
  ): void {
    if (normalizePath(path).includes(":")) {
      throw new Error("Arquivos estáticos não podem usar parâmetros de rota.");
    }

    const handler: ServerHandler = () => this.responses.file(file, headers);
    Object.assign(handler, { stateless: true });
    this.get(path, handler);
  }

  /** Registra um handler para POST. */
  post(path: string, handler: ServerHandler): void {
    this.addRoute("POST", path, handler);
  }

  /** Registra um handler para PUT. */
  put(path: string, handler: ServerHandler): void {
    this.addRoute("PUT", path, handler);
  }

  /** Registra um handler para PATCH. */
  patch(path: string, handler: ServerHandler): void {
    this.addRoute("PATCH", path, handler);
  }

  /** Registra um handler para DELETE. */
  delete(path: string, handler: ServerHandler): void {
    this.addRoute("DELETE", path, handler);
  }

  /**
   * Inicia o servidor Bun na porta informada.
   *
   * @param port - Porta entre 0 e 65535; `0` permite porta efêmera.
   * @throws {Error} Quando o servidor já está em execução.
   * @throws {RangeError} Quando a porta é inválida.
   */
  async listen(port: number): Promise<void> {
    await this.server.listen(port);
  }

  /**
   * Para o servidor e aguarda requisições, scopes e tarefas pendentes.
   *
   * Se o shutdown timeout vencer, os scopes ativos são abortados e a Promise
   * rejeita. O adapter não libera providers do container raiz; essa decisão
   * pertence ao `Empilha.close()` após a drenagem completa.
   *
   * @throws {Error} Quando o prazo configurado é excedido.
   */
  async close(): Promise<void> {
    await this.server.close();
  }

  /** Aguarda o término de todas as requisições e tarefas rastreadas. */
  waitForIdle(): Promise<void> {
    return this.server.waitForIdle();
  }
}
