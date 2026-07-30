import type {
  ServerHandler,
  HandlerOptions,
  MiddlewareFn,
  ServerRequest,
} from "../http";
import {
  compileArgGetters,
  compileResponseFactory,
  compileRoute,
} from "../compiler";
import type { ControllerResolver, ErrorHandler } from "../compiler/types";
import {
  compileNamedSQL,
  compileSqlBinding,
  type PostgresExecutor,
  type QueryRegistry,
  type QueryClient,
  type QueryResult,
} from "../sql";
import { requestContext } from "../context";
import type { RegisteredRouteMetadata } from "../types";
import { BackgroundScheduler, AuthorizationService } from "../runtime";
import {
  assertRouteSqlBindings,
  collectSqlSources,
} from "./sql-binding-validation";
import { configureRouteRequest } from "./route-request-requirements";

export type ControllerRegistrationContext = {
  controllerName: string;
  prefix: string;
  resolveController: ControllerResolver;
  handleError: ErrorHandler;
  middlewares: readonly MiddlewareFn[];
  tags: readonly string[];
  auth?: true | string | readonly string[];
  requiresRequestScope: boolean;
};

export type RouteCompilation = {
  handler: ServerHandler & HandlerOptions;
  requiresRequestContext: boolean;
};

export class RouteHandlerBuilder {
  constructor(
    private readonly postgres: PostgresExecutor,
    private readonly queries: QueryRegistry,
    private readonly background: BackgroundScheduler,
    private readonly authorization: AuthorizationService,
    private readonly getPluginService: (name: string) => unknown,
    private readonly validateResponses: () => boolean,
  ) {}

  compile(
    context: ControllerRegistrationContext,
    route: RegisteredRouteMetadata,
    fullPath: string,
  ): RouteCompilation {
    const getArgs = compileArgGetters(route, this.getPluginService);
    const createResponse = compileResponseFactory(
      route,
      this.validateResponses(),
    );
    const registeredSql = route.queryName
      ? this.queries.get(route.queryName)
      : "";
    const scopedMiddlewares = [
      ...context.middlewares,
      ...(route.middlewares ?? []),
    ];
    const executeSql = this.createSqlExecutor(
      route,
      registeredSql,
      getArgs,
      fullPath,
    );
    const compiled = compileRoute({
      resolveController: context.resolveController,
      route,
      getArgs,
      createResponse,
      authorize: this.authorization.createGuard(route.auth, route.requiresAuth),
      executeSql,
      executeTransaction: route.transaction
        ? (transaction, work) =>
            this.postgres.transaction(
              transaction,
              work,
              requestContext().signal,
            )
        : null,
      handleError: context.handleError,
      middlewares: scopedMiddlewares,
      executeBackground: (request, invoke) => {
        const scope = requestContext();
        const task = this.background.schedule(scope, route, invoke);
        if (!task) {
          return {
            status: 503,
            body: '{"error":"AfterResponse queue is full"}',
          };
        }
        scope.waitUntil(task);
        return { status: 202, body: "{}" };
      },
    });
    const sqlSources = collectSqlSources(registeredSql);
    const hasScopedMiddleware = scopedMiddlewares.length > 0;
    const configured = configureRouteRequest(
      compiled.handler,
      route,
      sqlSources,
      hasScopedMiddleware,
    );
    const requiresRequestContext =
      context.requiresRequestScope ||
      hasScopedMiddleware ||
      Boolean(route.queryName) ||
      Boolean(route.transaction) ||
      Boolean(route.background) ||
      Boolean(route.auth) ||
      route.requiresAuth === true ||
      route.parameters.some(
        (parameter) =>
          parameter.source === "context" || parameter.source === "auth",
      );

    return { handler: configured, requiresRequestContext };
  }

  private createSqlExecutor(
    route: RegisteredRouteMetadata,
    rawSql: string,
    getArgs: (request: ServerRequest) => unknown[],
    path: string,
  ) {
    if (!route.queryName) return null;
    const compiledSql = compileNamedSQL(rawSql);
    const bindings = route.sqlParams ?? compiledSql.bindings;
    assertRouteSqlBindings(route, bindings, path);
    const namedGetters = compiledSql.bindings.map(compileSqlBinding);
    const explicitGetters = route.sqlParams?.map(compileSqlBinding);

    return async (
      request: ServerRequest,
      client?: QueryClient,
    ): Promise<QueryResult> => {
      const params = explicitGetters
        ? explicitGetters.map((get) => get(request))
        : compiledSql.named
          ? namedGetters.map((get) => get(request))
          : getArgs(request);

      return client
        ? this.postgres.executeOnClient(
            client,
            compiledSql.sql,
            params,
            requestContext().signal,
            route.queryName,
          )
        : this.postgres.execute(
            compiledSql.sql,
            params,
            requestContext().signal,
            route.queryName,
          );
    };
  }
}
