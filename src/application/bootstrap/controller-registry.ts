import type {
  HandlerOptions,
  HttpAdapter,
  ServerHandler,
  ServerResponse,
} from "../../http";
import { joinPaths } from "../../router";
import type { MetadataRegistry } from "../../core/metadata";
import type { RegisteredRouteMetadata, HttpMethod } from "../../core/types";
import type { OpenApiDocumentBuilder } from "../../openapi";
import type { ControllerInstance } from "../../compiler/types";
import type { PostgresExecutor } from "../../sql";
import type { QueryRegistry } from "../../sql";
import type { AuthorizationService } from "../../runtime";
import { Type } from "@sinclair/typebox";
import { ControllerBootstrap } from "./controller-bootstrap";
import {
  RouteHandlerBuilder,
  type ControllerRegistrationContext,
} from "./route-handler-builder";

export type ControllerConstructor<TInstance extends object = object> = new (
  ...args: never[]
) => TInstance;

type ErrorHandler = (
  error: unknown,
  instance?: ControllerInstance,
) => Promise<ServerResponse>;

function routeMethodName(
  method: HttpMethod,
): "get" | "post" | "put" | "patch" | "delete" {
  return method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";
}

type Dependencies = {
  http: HttpAdapter;
  metadata: MetadataRegistry;
  openApi: OpenApiDocumentBuilder;
  postgres: PostgresExecutor;
  queries: QueryRegistry;
  authorization: AuthorizationService;
  bootstrap: ControllerBootstrap;
  handlerBuilder: RouteHandlerBuilder;
  createErrorHandler: (controller: ControllerConstructor) => ErrorHandler;
};

type PreparedRoute = {
  context: ControllerRegistrationContext;
  route: RegisteredRouteMetadata;
  fullPath: string;
  handler: ServerHandler & HandlerOptions;
  requiresRequestContext: boolean;
  controller: ControllerConstructor;
};

export class ControllerRegistry {
  constructor(private readonly deps: Dependencies) {}

  register(controllers: readonly ControllerConstructor[]): void {
    this.deps.metadata.snapshot(controllers);
    const prepared: PreparedRoute[] = [];

    for (const controller of controllers) {
      prepared.push(...this.prepareController(controller));
    }

    for (const item of prepared) {
      this.deps.openApi.addRoute(
        item.context.controllerName,
        item.fullPath,
        item.route,
        item.context.tags,
      );
      item.handler.requiresRequestContext = item.requiresRequestContext;
      this.deps.http[routeMethodName(item.route.method)](
        item.fullPath,
        item.handler,
      );
    }
  }

  private prepareController(
    controller: ControllerConstructor,
  ): PreparedRoute[] {
    const { bootstrap, metadata, createErrorHandler } = this.deps;
    bootstrap.provideController(controller);
    const controllerType = controller as unknown as Function;
    const options = metadata.getControllerOptions(controllerType);
    const context: ControllerRegistrationContext = {
      controllerName: controllerType.name || "Controller",
      prefix: metadata.getControllerPath(controllerType) ?? "",
      resolveController: bootstrap.createResolver(controller),
      handleError: createErrorHandler(controller),
      middlewares: metadata.getControllerMiddlewares(controllerType),
      tags: options?.tags ?? [],
      auth: options?.auth,
      requiresRequestScope: bootstrap.requiresRequestContext(controller),
    };

    const prepared: PreparedRoute[] = [];

    for (const route of metadata.getControllerRoutes(controllerType)) {
      try {
        const fullPath = joinPaths(context.prefix, route.path);
        const effectiveRoute = {
          ...route,
          auth:
            route.auth ?? (context.auth === true ? undefined : context.auth),
          requiresAuth: route.requiresAuth || context.auth === true,
        };

        if (
          effectiveRoute.responseSchema === undefined &&
          effectiveRoute.queryArtifact?.row !== undefined &&
          effectiveRoute.sqlResult !== "none"
        ) {
          effectiveRoute.responseSchema =
            effectiveRoute.sqlResult === "many"
              ? Type.Array(effectiveRoute.queryArtifact.row)
              : effectiveRoute.queryArtifact.row;
        }

        if (effectiveRoute.queryArtifact) {
          this.deps.queries.registerGeneratedQuery(
            effectiveRoute.queryArtifact,
          );
          const expected =
            effectiveRoute.queryArtifact.cardinality === "exec"
              ? "none"
              : effectiveRoute.queryArtifact.cardinality;
          if (effectiveRoute.sqlResult !== expected) {
            throw new Error(
              `A query gerada "${effectiveRoute.queryArtifact.id}" declara cardinalidade "${effectiveRoute.queryArtifact.cardinality}", ` +
                `mas a rota usa @Result("${effectiveRoute.sqlResult ?? "ausente"}").`,
            );
          }
        }

        this.assertRouteHooks(controller, effectiveRoute);
        this.assertAuthorization(effectiveRoute);
        if (
          effectiveRoute.afterCommit !== undefined &&
          !effectiveRoute.transaction
        ) {
          throw new Error(
            `A rota ${route.method} ${String(route.propertyKey)} usa ` +
              "AfterCommit, mas não possui uma transação configurada.",
          );
        }
        if (effectiveRoute.transaction) {
          this.deps.postgres.assertTransactionSupport();
        }

        const compiled = this.deps.handlerBuilder.compile(
          context,
          effectiveRoute,
          fullPath,
        );
        prepared.push({
          controller,
          context,
          route: effectiveRoute,
          fullPath,
          handler: compiled.handler,
          requiresRequestContext: compiled.requiresRequestContext,
        });
      } catch (error) {
        const endpoint = `${context.controllerName}.${String(route.propertyKey)} (${route.method} ${joinPaths(context.prefix, route.path)})`;
        throw new Error(`Falha ao registrar ${endpoint}: ${String(error)}`, {
          cause: error,
        });
      }
    }

    return prepared;
  }

  private assertRouteHooks(
    controller: ControllerConstructor,
    route: RegisteredRouteMetadata,
  ): void {
    const prototype = controller.prototype as Record<PropertyKey, unknown>;
    const endpoint = `${String(route.propertyKey)} (${route.method} ${route.path})`;

    if (
      route.sqlResult !== undefined &&
      route.queryName === undefined &&
      route.queryArtifact === undefined
    ) {
      throw new Error(
        `A rota ${endpoint} usa @Result("${route.sqlResult}"), mas não possui @Sql(). ` +
          "Associe uma query SQL antes de declarar sua cardinalidade.",
      );
    }

    for (const [kind, propertyKey] of [
      ["BeforeSql", route.beforeSql],
      ["AfterCommit", route.afterCommit],
    ] as const) {
      if (
        propertyKey !== undefined &&
        typeof prototype[propertyKey] !== "function"
      ) {
        throw new Error(
          `A rota ${endpoint} referencia ${kind}("${String(propertyKey)}"), ` +
            "mas esse método não existe no controller.",
        );
      }
    }

    if (
      route.background &&
      (route.queryName !== undefined ||
        route.beforeSql !== undefined ||
        route.afterCommit !== undefined ||
        route.transaction !== undefined)
    ) {
      throw new Error(
        `A rota ${endpoint} combina AfterResponse com SQL, hooks ou transação. ` +
          "Esses recursos não podem ser executados em background.",
      );
    }
  }

  private assertAuthorization(route: RegisteredRouteMetadata): void {
    if (
      (typeof route.auth === "string" ||
        Array.isArray(route.auth) ||
        route.requiresAuth) &&
      !this.deps.authorization.isConfigured()
    ) {
      throw new Error(
        `A rota ${route.method} ${String(route.propertyKey)} exige autenticação, ` +
          "mas app.auth() não foi configurado.",
      );
    }
  }
}
