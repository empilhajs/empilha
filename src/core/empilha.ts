import { requestLogger, type MiddlewareFn, type ServerResponse } from "../http";
import {
  loadSQL,
  postgresRunner,
  type PostgresQueryRunner,
  type PostgresPool,
  type ManagedPostgresPool,
  type QueryExecutionOptions,
} from "../sql";
import {
  Container,
  CLOCK,
  REQUEST_ID_GENERATOR,
  type Constructor,
  type Clock,
  type DependencyToken,
  type Provider,
  type RequestIdGenerator,
} from "../di";
import type {
  AuthTokenHandler,
  BackgroundSchedulerOptions,
  RoleHierarchy,
} from "../runtime";
import type { GeneratedQuery } from "../sql/generated-query";
import {
  createTestClient,
  type TestClient,
} from "../application/testing/test-client";
import { tryRequestContext } from "../context";
import { ControllerRegistry } from "../application/bootstrap/controller-registry";
import { ControllerBootstrap } from "../application/bootstrap/controller-bootstrap";
import { RouteHandlerBuilder } from "../application/bootstrap/route-handler-builder";
export type {
  TestClient,
  TestRawRequestOptions,
  TestRequestOptions,
} from "../application/testing/test-client";
import {
  OPENAPI_DOCUMENT_PATH,
  OPENAPI_UI_PATH,
  type OpenApiOptions,
  openApiHtml,
} from "../openapi";
import { ApplicationContext } from "../application/services";
import {
  closeEmpilhaResources,
  type CloseHook,
} from "../application/lifecycle/framework-shutdown";
import type { ControllerInstance } from "../compiler";
import { invokeController } from "../utils/controller";
import { ApplicationRunner } from "../application/lifecycle/application-runner";
import type { HealthCheckOptions } from "../application/lifecycle/health-checks";
import { validateHttpOptions, validateTimeout } from "../http/adapter-helpers";
import { createRequestId } from "../http/request-id";
import type { Logger } from "../utils/logger";
import type {
  CorsOptions as AdapterCorsOptions,
  HttpOptions as AdapterHttpOptions,
  NativeRouteEligibility,
} from "../http/adapter-types";

export type {
  ManagedPostgresPool,
  PostgresPool,
  PostgresQueryRunner,
  QueryExecutionOptions,
};

export type PostgresOptions = {
  sql?: string;
  timeout?: number | null;
  healthCheck?: string | false;
  close?: boolean;
};

export type HttpOptions = AdapterHttpOptions & {
  disposalTimeout?: number | null;
};

export type CorsOptions = AdapterCorsOptions;

export type { HealthCheckOptions } from "../application/lifecycle/health-checks";

export type RunOptions = {
  port?: number;
  signals?: boolean;
};

export type EmpilhaRuntimeConfig = {
  server?: RunOptions;
  http?: HttpOptions;
  health?: HealthCheckOptions;
  openapi?: OpenApiOptions | false;
  middleware?: MiddlewareFn[];
  auth?: {
    hierarchy?: RoleHierarchy;
  };
  backgroundJobs?: BackgroundJobsOptions;
  onBackgroundError?: (error: unknown, route: unknown) => void | Promise<void>;
  validation?: {
    responses?: boolean;
  };
  logging?: {
    requests?: boolean;
    logger?: Logger;
  };
};

export type ControllerConstructor<TInstance extends object = object> = new (
  ...args: never[]
) => TInstance;

type StartHook = () => void | Promise<void>;
type ErrorHandler = (
  error: unknown,
  instance?: ControllerInstance,
) => Promise<ServerResponse>;

type GlobalCatchHandler = (error: unknown) => unknown | Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertConfigObject(
  value: unknown,
  name: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`A configuração ${name} deve ser um objeto.`);
  }
}

function assertRuntimeConfig(config: EmpilhaRuntimeConfig): void {
  assertConfigObject(config, "runtime");
  if (config.server !== undefined) {
    assertConfigObject(config.server, "server");
    if (config.server.port !== undefined) {
      const port = config.server.port;
      if (!Number.isInteger(port) || port < 0 || port > 65_535)
        throw new RangeError("A porta do servidor deve estar entre 0 e 65535.");
    }
    if (
      config.server.signals !== undefined &&
      typeof config.server.signals !== "boolean"
    ) {
      throw new TypeError("server.signals deve ser booleano.");
    }
  }
  if (config.http !== undefined) {
    assertConfigObject(config.http, "http");
    validateHttpOptions(config.http);
  }
  if (config.health !== undefined) assertConfigObject(config.health, "health");
  if (config.openapi !== undefined && config.openapi !== false)
    assertConfigObject(config.openapi, "openapi");
  if (config.middleware !== undefined) {
    if (
      !Array.isArray(config.middleware) ||
      config.middleware.some((middleware) => typeof middleware !== "function")
    ) {
      throw new TypeError("middleware deve ser uma lista de funções.");
    }
  }
  if (config.auth !== undefined) assertConfigObject(config.auth, "auth");
  if (config.backgroundJobs !== undefined)
    assertConfigObject(config.backgroundJobs, "backgroundJobs");
  if (
    config.onBackgroundError !== undefined &&
    typeof config.onBackgroundError !== "function"
  ) {
    throw new TypeError("onBackgroundError deve ser uma função.");
  }
  if (config.validation !== undefined) {
    assertConfigObject(config.validation, "validation");
    if (
      config.validation.responses !== undefined &&
      typeof config.validation.responses !== "boolean"
    ) {
      throw new TypeError("validation.responses deve ser booleano.");
    }
  }
  if (config.logging !== undefined) {
    assertConfigObject(config.logging, "logging");
    if (
      config.logging.requests !== undefined &&
      typeof config.logging.requests !== "boolean"
    ) {
      throw new TypeError("logging.requests deve ser booleano.");
    }
  }
}

export type BackgroundJobsOptions = BackgroundSchedulerOptions;

const activateRuntime = Symbol("empilha.application.activate");

export class ApplicationRuntime {
  private readonly context: ApplicationContext;

  private readonly http: ApplicationContext["http"];

  readonly container: Container;

  private readonly metadata: ApplicationContext["metadata"];

  private readonly lifecycle: ApplicationContext["lifecycle"];

  private readonly postgresExecutor: ApplicationContext["postgres"];

  private readonly queries: ApplicationContext["queries"];

  private validateResponses = process.env.NODE_ENV !== "production";

  private disposalTimeoutMs: number | null = 15_000;

  private readonly background: ApplicationContext["background"];

  private readonly errors: ApplicationContext["errors"];

  private readonly healthChecks: ApplicationContext["healthChecks"];

  private readonly loggerService: ApplicationContext["logger"];

  readonly events: ApplicationContext["events"];

  private readonly closeHooks: CloseHook[] = [];

  private readonly startHooks: StartHook[] = [];

  private configuredRunOptions: RunOptions | undefined;

  private readonly authorization: ApplicationContext["authorization"];

  private ready = false;

  private readonly runner: ApplicationRunner;

  private readonly openApiDocument: ApplicationContext["openApi"];

  private openApiRoutesRegistered = false;

  private readonly controllerRegistry: ControllerRegistry;

  /** Entrada Web Standards usada pelo servidor e pela testing application. */
  readonly fetch = (request: Request): Promise<Response> =>
    Promise.resolve(this.http.handleRequest(request));

  get url(): URL | null {
    return this.http.url;
  }

  constructor(container?: Container) {
    this.context = new ApplicationContext(container);
    this.http = this.context.http;
    this.container = this.context.container;
    this.metadata = this.context.metadata;
    this.lifecycle = this.context.lifecycle;
    this.postgresExecutor = this.context.postgres;
    this.queries = this.context.queries;
    this.background = this.context.background;
    this.errors = this.context.errors;
    this.healthChecks = this.context.healthChecks;
    this.loggerService = this.context.logger;
    this.events = this.context.events;
    this.authorization = this.context.authorization;
    this.openApiDocument = this.context.openApi;
    const clock: Clock = this.container.has(CLOCK)
      ? this.container.resolve(CLOCK)
      : { now: () => performance.now() };
    const requestIdGenerator: RequestIdGenerator = this.container.has(
      REQUEST_ID_GENERATOR,
    )
      ? this.container.resolve(REQUEST_ID_GENERATOR)
      : createRequestId;
    this.http.setClock(clock);
    this.http.setRequestIdGenerator(requestIdGenerator);
    this.background.setClock(clock);
    const bootstrap = new ControllerBootstrap(this.container);
    const handlerBuilder = new RouteHandlerBuilder(
      this.postgresExecutor,
      this.queries,
      this.background,
      this.authorization,
      this.events,
      clock,
      (token) => {
        const scope = tryRequestContext();
        return (scope?.container ?? this.container).resolve(token);
      },
      () => this.validateResponses,
    );
    this.controllerRegistry = new ControllerRegistry({
      http: this.http,
      metadata: this.metadata,
      openApi: this.openApiDocument,
      postgres: this.postgresExecutor,
      queries: this.queries,
      authorization: this.authorization,
      bootstrap,
      handlerBuilder,
      createErrorHandler: (controller) => this.createErrorHandler(controller),
    });
    this.http.setRequestScopeFactory(() => this.container.createScope());
    this.http.setErrorHandler((error) => this.handleAdapterError(error));
    this.runner = new ApplicationRunner({
      lifecycle: this.lifecycle,
      isReady: () => this.ready,
      listen: (port) => this.http.listen(port),
      close: () => this.close(),
      startHooks: this.startHooks,
      hasOpenApi: () => this.openApiRoutesRegistered,
      hasHealthChecks: () => this.healthChecks.hasChecks,
      getUrl: () => this.http.url,
      openApiUiPath: OPENAPI_UI_PATH,
      openApiDocumentPath: OPENAPI_DOCUMENT_PATH,
      logger: this.loggerService,
    });
  }

  private assertConfiguring(action: string): void {
    this.lifecycle.assertConfiguring(action);
  }

  // -------------------------------------------------------------------------
  // Configuração pública
  // -------------------------------------------------------------------------

  /** Aplica a configuração operacional centralizada do projeto. */
  configure(config: EmpilhaRuntimeConfig): this {
    this.assertConfiguring("configure()");
    assertRuntimeConfig(config);

    if (config.server !== undefined) this.configuredRunOptions = config.server;
    if (config.http !== undefined) this.configureHttp(config.http);
    if (config.health !== undefined) this.configureHealthChecks(config.health);
    if (config.openapi !== undefined && config.openapi !== false)
      this.openapi(config.openapi);
    for (const middleware of config.middleware ?? [])
      this.useMiddleware(middleware);
    if (config.auth?.hierarchy !== undefined)
      this.authHierarchy(config.auth.hierarchy);
    if (config.backgroundJobs !== undefined)
      this.backgroundJobs(config.backgroundJobs);
    if (config.onBackgroundError !== undefined)
      this.onBackgroundError(config.onBackgroundError);
    if (config.validation?.responses !== undefined)
      this.validateResponseSchemas(config.validation.responses);
    if (config.logging?.requests) this.useMiddleware(requestLogger());
    if (config.logging?.logger) this.logger(config.logging.logger);

    return this;
  }

  /** Define o logger usado por esta aplicação e seus serviços internos. */
  logger(logger: Logger): this {
    this.assertConfiguring("logger()");
    this.loggerService.configure(logger);
    return this;
  }

  /** Configura PostgreSQL com health check e shutdown no caso usual. */
  postgres(pool: ManagedPostgresPool, options?: PostgresOptions): this;
  postgres(pool: PostgresQueryRunner, options?: PostgresOptions): this;
  postgres(
    pool: PostgresQueryRunner | ManagedPostgresPool,
    options: PostgresOptions = {},
  ): this {
    this.assertConfiguring("postgres()");
    const managedPool = "end" in pool ? (pool as ManagedPostgresPool) : null;
    if (
      managedPool &&
      !managedPool.queryWithOptions &&
      options.timeout !== null
    ) {
      throw new Error(
        "Pools PostgreSQL gerenciados precisam implementar queryWithOptions quando o timeout está habilitado. Use @empilha/pg ou configure timeout: null.",
      );
    }
    const runner = managedPool ? postgresRunner(managedPool) : pool;
    this.postgresExecutor.setRunner(runner);

    if (options.sql) loadSQL(options.sql, this.queries);
    if (options.timeout !== undefined)
      this.postgresExecutor.setTimeout(options.timeout);
    if (options.healthCheck !== false) {
      this.healthCheck(options.healthCheck ?? "database", runner);
    }
    if (
      options.close !== false &&
      managedPool &&
      typeof managedPool.end === "function"
    ) {
      this.onClose(() => managedPool.end!());
    }

    return this;
  }

  /** Agrupa ajustes HTTP que normalmente só fogem dos padrões em produção. */
  configureHttp(options: HttpOptions): this {
    this.assertConfiguring("configureHttp()");
    validateHttpOptions(options);
    const disposalTimeout =
      options.disposalTimeout !== undefined
        ? validateTimeout(options.disposalTimeout, "descarte")
        : undefined;
    this.http.configure(options);
    if (options.exposeInternalErrors !== undefined) {
      this.errors.setExposeInternalErrors(options.exposeInternalErrors);
    }
    if (disposalTimeout !== undefined) this.disposalTimeoutMs = disposalTimeout;

    return this;
  }

  /** Configura a execução e a capacidade dos endpoints de health check. */
  configureHealthChecks(options: HealthCheckOptions): this {
    this.assertConfiguring("configureHealthChecks()");
    this.healthChecks.configure(options);
    return this;
  }

  provide<T>(
    token: DependencyToken<T>,
    provider?: Provider<T> | Constructor<T>,
  ): this {
    this.assertConfiguring("provide()");
    this.container.provide(token, provider);
    return this;
  }

  registerQuery(name: string, sql: string): this {
    this.assertConfiguring("registerQuery()");
    this.queries.register(name, sql);

    return this;
  }

  registerGeneratedQuery(query: GeneratedQuery): this {
    this.assertConfiguring("registerGeneratedQuery()");
    this.queries.registerGeneratedQuery(query);
    return this;
  }

  openapi(options?: OpenApiOptions): this {
    this.assertConfiguring("openapi()");
    this.openApiDocument.configure(options);
    this.registerOpenApiRoutes();

    return this;
  }

  /** Registra um recurso externo para ser encerrado por `app.close()`. */
  onClose(hook: CloseHook): this {
    this.lifecycle.assertBeforeClosed("onClose()");
    this.closeHooks.push(hook);
    return this;
  }

  onStart(hook: StartHook): this {
    this.lifecycle.assertBeforeListening("onStart()");
    this.startHooks.push(hook);
    return this;
  }

  validateResponseSchemas(enabled = true): this {
    this.assertConfiguring("validateResponseSchemas()");
    this.validateResponses = enabled;

    return this;
  }

  useMiddleware(middleware: MiddlewareFn): this {
    this.assertConfiguring("useMiddleware()");
    this.http.useMiddleware(middleware);

    return this;
  }

  onBackgroundError(
    handler: (error: unknown, route: unknown) => void | Promise<void>,
  ): this {
    this.assertConfiguring("onBackgroundError()");
    this.background.onError(handler);

    return this;
  }

  backgroundJobs(options: BackgroundJobsOptions): this {
    this.assertConfiguring("backgroundJobs()");
    this.background.configure(options);

    return this;
  }

  healthCheck(
    name: string,
    check:
      | ((signal?: AbortSignal) => boolean | Promise<boolean>)
      | PostgresQueryRunner,
  ): this {
    this.assertConfiguring("healthCheck()");
    this.healthChecks.add(name, check);

    return this;
  }

  auth<TPayload = unknown>(handler: AuthTokenHandler<TPayload>): this {
    this.assertConfiguring("auth()");
    this.authorization.configure(handler);

    return this;
  }

  authHierarchy(hierarchy: RoleHierarchy): this {
    this.assertConfiguring("authHierarchy()");
    this.authorization.configureHierarchy(hierarchy);

    return this;
  }

  catch(errorType: Function, handler: GlobalCatchHandler): this {
    this.errors.catch(errorType, handler);

    return this;
  }

  private createErrorHandler(controller: ControllerConstructor): ErrorHandler {
    const prototype = (
      controller as unknown as {
        prototype: object;
      }
    ).prototype;

    return this.errors.createHandler(
      prototype,
      (instance, propertyKey, error) =>
        invokeController(instance, propertyKey, [error]),
      this.metadata.getCatchHandler,
    );
  }

  private handleAdapterError(error: unknown): Promise<ServerResponse> {
    return this.errors.createHandler(Object.prototype, () => {
      throw error;
    })(error);
  }

  // -------------------------------------------------------------------------
  // Registro e compilação de controllers
  // -------------------------------------------------------------------------

  [activateRuntime](controllers: readonly ControllerConstructor[]): void {
    this.http.beginRouteTransaction();
    this.openApiDocument.beginRouteTransaction();

    this.lifecycle.activate(() => {
      try {
        for (const controller of controllers) {
          this.container.assertConstructible(controller);
        }
        this.controllerRegistry.register(controllers);
        this.healthChecks.registerRoute(this.http);
        this.ready = true;
        this.http.commitRouteTransaction();
        this.openApiDocument.commitRouteTransaction();
      } catch (error) {
        this.ready = false;
        this.http.rollbackRouteTransaction();
        this.openApiDocument.rollbackRouteTransaction();
        throw error;
      }
    });
  }

  private registerOpenApiRoutes(): void {
    if (this.openApiRoutesRegistered) {
      return;
    }

    this.http.get(OPENAPI_DOCUMENT_PATH, () => ({
      status: 200,
      body: "",
      jsonValue: this.openApiDocument.build(),
    }));

    this.http.get(OPENAPI_UI_PATH, () => ({
      status: 200,
      body: openApiHtml(),
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    }));

    this.openApiRoutesRegistered = true;
  }

  // -------------------------------------------------------------------------
  // Cliente de testes e ciclo de vida do servidor
  // -------------------------------------------------------------------------

  test(): TestClient {
    return createTestClient(this.http);
  }

  /** Expõe as decisões do fast path calculadas durante o bootstrap. */
  getNativeRouteEligibility(): readonly NativeRouteEligibility[] {
    return this.http.getNativeRouteEligibility();
  }

  /** Resolve um token já ativado no contexto da aplicação. */
  get<T>(token: DependencyToken<T>): T {
    return this.container.resolve(token);
  }

  async listen(port: number): Promise<void> {
    await this.runner.listen(port);
  }

  /** Inicia a aplicação e registra shutdown gracioso para o caso comum. */
  async run(options?: RunOptions): Promise<void> {
    const resolvedOptions = options ?? this.configuredRunOptions;
    await this.runner.run({
      port: resolvedOptions?.port,
      signals: resolvedOptions?.signals,
    });
  }

  async close(): Promise<void> {
    await this.lifecycle.close(() =>
      closeEmpilhaResources(
        this.http,
        this.container,
        this.closeHooks,
        this.disposalTimeoutMs,
      ),
    );
  }

  /** Permite usar a aplicação com `await using` em testes e bootstrap. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/** Ativação interna usada exclusivamente pelo bootstrap baseado em módulos. */
export function activateApplicationRuntime(
  runtime: ApplicationRuntime,
  controllers: readonly ControllerConstructor[],
): void {
  runtime[activateRuntime](controllers);
}
