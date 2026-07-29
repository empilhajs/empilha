import { type MiddlewareFn, type ServerResponse } from "./http";
import {
  loadSQL,
  postgresRunner,
  type PostgresQueryRunner,
  type PostgresPool,
  type ManagedPostgresPool,
  type QueryExecutionOptions,
} from "./sql";
import { type Constructor, type DependencyToken, type Provider } from "./di";
import type {
  AuthTokenHandler,
  BackgroundSchedulerOptions,
  RoleHierarchy,
} from "./runtime";
import { createTestClient, type TestClient } from "./application/test-client";
import { isEmpilhaPlugin, type EmpilhaPlugin } from "./application/plugin";
import { ControllerRegistry } from "./application/controller-registry";
import { ControllerBootstrap } from "./application/controller-bootstrap";
import { RouteHandlerBuilder } from "./application/route-handler-builder";
export type {
  TestClient,
  TestRawRequestOptions,
  TestRequestOptions,
} from "./application/test-client";
import {
  OPENAPI_DOCUMENT_PATH,
  OPENAPI_UI_PATH,
  type OpenApiOptions,
  openApiHtml,
} from "./openapi";
import { ApplicationContext } from "./application/services";
import {
  closeEmpilhaResources,
  type CloseHook,
} from "./application/framework-shutdown";
import type { ControllerInstance } from "./compiler";
import { invokeController } from "./utils/controller";

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

export type HttpOptions = {
  cors?: string | false;
  serverHeader?: string;
  maxBodyBytes?: number;
  bodyTimeout?: number | null;
  handlerTimeout?: number | null;
  maxConcurrentRequests?: number | null;
  shutdownTimeout?: number | null;
};

export type RunOptions = {
  port: number;
  signals?: boolean;
};

export type EmpilhaRuntimeConfig = {
  server?: RunOptions;
  http?: HttpOptions;
  openapi?: OpenApiOptions | false;
  middleware?: MiddlewareFn[];
  plugins?: EmpilhaPlugin[];
  auth?: {
    hierarchy?: RoleHierarchy;
  };
  backgroundJobs?: BackgroundJobsOptions;
  onBackgroundError?: (error: unknown, route: unknown) => void | Promise<void>;
  validation?: {
    responses?: boolean;
  };
};

export type ControllerConstructor = abstract new (...args: never[]) => object;

type LifecycleHook = (controllers: readonly ControllerConstructor[]) => void;
type StartHook = () => void | Promise<void>;
type ErrorHandler = (
  error: unknown,
  instance?: ControllerInstance,
) => Promise<ServerResponse>;

type GlobalCatchHandler = (error: unknown) => unknown | Promise<unknown>;

export type BackgroundJobsOptions = BackgroundSchedulerOptions;

export class Empilha {
  private readonly context = new ApplicationContext();

  private readonly http = this.context.http;

  readonly container = this.context.container;

  private readonly metadata = this.context.metadata;

  private readonly lifecycle = this.context.lifecycle;

  private readonly postgresExecutor = this.context.postgres;

  private readonly queries = this.context.queries;

  private validateResponses = process.env.NODE_ENV !== "production";

  private readonly background = this.context.background;

  private readonly errors = this.context.errors;

  private readonly healthChecks = this.context.healthChecks;

  private readonly closeHooks: CloseHook[] = [];

  private readonly beforeValidateHooks: LifecycleHook[] = [];

  private readonly afterInitializeHooks: LifecycleHook[] = [];

  private readonly startHooks: StartHook[] = [];

  private configuredRunOptions: RunOptions | undefined;

  private readonly authorization = this.context.authorization;

  private controllersRegistered = false;

  private validatedControllers: readonly ControllerConstructor[] | undefined;

  private readonly openApiDocument = this.context.openApi;

  private readonly pluginServices = this.context.pluginServices;

  private openApiRoutesRegistered = false;

  private readonly controllerRegistry: ControllerRegistry;

  constructor() {
    const bootstrap = new ControllerBootstrap(this.container);
    const handlerBuilder = new RouteHandlerBuilder(
      this.postgresExecutor,
      this.queries,
      this.background,
      this.authorization,
      (name) => this.getPluginService(name),
      () => this.validateResponses,
    );
    this.controllerRegistry = new ControllerRegistry({
      http: this.http,
      metadata: this.metadata,
      openApi: this.openApiDocument,
      postgres: this.postgresExecutor,
      authorization: this.authorization,
      bootstrap,
      handlerBuilder,
      createErrorHandler: (controller) => this.createErrorHandler(controller),
    });
    this.http.setRequestScopeFactory(() => this.container.createScope());
    this.http.setErrorHandler((error) => this.handleAdapterError(error));
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

    if (config.server !== undefined) this.configuredRunOptions = config.server;
    if (config.http !== undefined) this.configureHttp(config.http);
    if (config.openapi !== undefined && config.openapi !== false)
      this.openapi(config.openapi);
    for (const middleware of config.middleware ?? []) this.use(middleware);
    for (const plugin of config.plugins ?? []) this.use(plugin);
    if (config.auth?.hierarchy !== undefined)
      this.authHierarchy(config.auth.hierarchy);
    if (config.backgroundJobs !== undefined)
      this.backgroundJobs(config.backgroundJobs);
    if (config.onBackgroundError !== undefined)
      this.onBackgroundError(config.onBackgroundError);
    if (config.validation?.responses !== undefined)
      this.validateResponseSchemas(config.validation.responses);

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
    this.postgresExecutor.setRunner(
      "end" in pool ? postgresRunner(pool as PostgresPool) : pool,
    );

    if (options.sql) loadSQL(options.sql, this.queries);
    if (options.timeout !== undefined)
      this.postgresExecutor.setTimeout(options.timeout);
    if (options.healthCheck !== false) {
      this.healthCheck(options.healthCheck ?? "database", pool);
    }
    if (
      options.close !== false &&
      "end" in pool &&
      typeof pool.end === "function"
    ) {
      this.onClose(() => pool.end!());
    }

    return this;
  }

  /** Agrupa ajustes HTTP que normalmente só fogem dos padrões em produção. */
  configureHttp(options: HttpOptions): this {
    if (options.cors === false) this.http.disableCors();
    else if (options.cors !== undefined) this.http.enableCors(options.cors);
    if (options.serverHeader !== undefined)
      this.http.setServerHeader(options.serverHeader);
    if (options.maxBodyBytes !== undefined)
      this.http.setMaxBodyBytes(options.maxBodyBytes);
    if (options.bodyTimeout !== undefined)
      this.http.setBodyTimeout(options.bodyTimeout);
    if (options.handlerTimeout !== undefined)
      this.http.setHandlerTimeout(options.handlerTimeout);
    if (options.maxConcurrentRequests !== undefined)
      this.http.setRequestConcurrency(options.maxConcurrentRequests);
    if (options.shutdownTimeout !== undefined)
      this.http.setShutdownTimeout(options.shutdownTimeout);

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

  openapi(options?: OpenApiOptions): this {
    this.openApiDocument.configure(options);
    this.registerOpenApiRoutes();

    return this;
  }

  /** Registra um recurso externo para ser encerrado por `app.close()`. */
  onClose(hook: CloseHook): this {
    this.closeHooks.push(hook);
    return this;
  }

  onBeforeValidate(hook: LifecycleHook): this {
    this.assertConfiguring("onBeforeValidate()");
    this.beforeValidateHooks.push(hook);
    return this;
  }

  onAfterInitialize(hook: LifecycleHook): this {
    this.assertConfiguring("onAfterInitialize()");
    this.afterInitializeHooks.push(hook);
    return this;
  }

  onStart(hook: StartHook): this {
    if (this.lifecycle.phase === "closed") {
      throw new Error("onStart() não pode ser chamado após app.close().");
    }
    this.startHooks.push(hook);
    return this;
  }

  validateResponseSchemas(enabled = true): this {
    this.validateResponses = enabled;

    return this;
  }

  use(input: MiddlewareFn | EmpilhaPlugin): this {
    this.assertConfiguring("use()");
    if (isEmpilhaPlugin(input)) {
      input.install(this);
      return this;
    }

    this.http.use(input);

    return this;
  }

  registerPluginService(name: string, service: unknown): void {
    this.assertConfiguring("registerPluginService()");
    if (this.pluginServices.has(name)) {
      throw new Error(`O serviço de plugin "${name}" já foi registrado.`);
    }
    this.pluginServices.set(name, service);
  }

  private getPluginService(name: string): unknown {
    const service = this.pluginServices.get(name);
    if (service === undefined) {
      throw new Error(`O serviço de plugin "${name}" não foi registrado.`);
    }
    return service;
  }

  onBackgroundError(
    handler: (error: unknown, route: unknown) => void | Promise<void>,
  ): this {
    this.background.onError(handler);

    return this;
  }

  backgroundJobs(options: BackgroundJobsOptions): this {
    this.background.configure(options);

    return this;
  }

  healthCheck(
    name: string,
    check:
      | ((signal?: AbortSignal) => boolean | Promise<boolean>)
      | PostgresQueryRunner,
  ): this {
    this.healthChecks.add(name, check);
    if (this.controllersRegistered) this.healthChecks.registerRoute(this.http);

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

  validate(controllers: ControllerConstructor[]): this {
    this.lifecycle.validate(() => {
      for (const hook of this.beforeValidateHooks) hook(controllers);
      for (const controller of controllers) {
        this.container.assertConstructible(controller);
      }
    });

    this.validatedControllers = [...controllers];

    return this;
  }

  initialize(controllers: ControllerConstructor[]): this {
    if (this.lifecycle.phase === "configuring") {
      this.validate(controllers);
    } else if (
      this.lifecycle.phase === "validated" &&
      (this.validatedControllers?.length !== controllers.length ||
        this.validatedControllers.some(
          (controller, index) => controller !== controllers[index],
        ))
    ) {
      throw new Error(
        "initialize() deve receber os mesmos controllers usados em validate().",
      );
    }

    const httpSnapshot = this.http.snapshotRoutes();
    const openApiSnapshot = this.openApiDocument.snapshotRoutes();

    this.lifecycle.initialize(() => {
      try {
        this.controllerRegistry.initialize(controllers);
        this.healthChecks.registerRoute(this.http);
        this.controllersRegistered = true;
        for (const hook of this.afterInitializeHooks) hook(controllers);
      } catch (error) {
        this.controllersRegistered = false;
        this.http.restoreRoutes(httpSnapshot);
        this.openApiDocument.restoreRoutes(openApiSnapshot);
        throw error;
      }
    });

    return this;
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

  async listen(port: number): Promise<void> {
    if (!this.controllersRegistered) {
      throw new Error("Chame app.initialize([...]) antes de app.listen().");
    }

    await this.lifecycle.listen(
      () => this.http.listen(port),
      this.startHooks,
      () => this.close(),
    );
  }

  /** Inicia a aplicação e registra shutdown gracioso para o caso comum. */
  async run(options?: RunOptions): Promise<void> {
    const resolvedOptions = options ?? this.configuredRunOptions;
    if (!resolvedOptions) {
      throw new Error(
        "Configure server.port ou passe { port } para app.run().",
      );
    }

    await this.listen(resolvedOptions.port);

    if (resolvedOptions.signals !== false) {
      let shutdownPromise: Promise<void> | undefined;
      const shutdown = () => {
        shutdownPromise ??= this.close().catch((error: unknown) => {
          console.error("Falha ao encerrar a aplicação:", error);
          process.exitCode = 1;
        });
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    }

    const baseUrl = `http://localhost:${resolvedOptions.port}`;
    console.log(`🚀 API: ${baseUrl}`);
    if (this.openApiRoutesRegistered) {
      console.log(`📚 Docs: ${baseUrl}${OPENAPI_UI_PATH}`);
      console.log(`📄 OpenAPI: ${baseUrl}${OPENAPI_DOCUMENT_PATH}`);
    }
    if (this.healthChecks.hasChecks)
      console.log(`❤️ Health: ${baseUrl}/health`);
  }

  async close(): Promise<void> {
    await this.lifecycle.close(() =>
      closeEmpilhaResources(this.http, this.container, this.closeHooks),
    );
  }
}

/** Cria uma aplicação inicializada para testes, sem abrir uma porta HTTP. */
export function createTestApp(
  controllers: ControllerConstructor[],
  configure?: (app: Empilha) => void,
): Empilha {
  const app = new Empilha();
  configure?.(app);
  return app.initialize(controllers);
}
