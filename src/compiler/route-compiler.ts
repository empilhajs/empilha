import { runMiddlewareChain } from "../http/middleware-chain";
import type {
  ServerHandler,
  ServerRequest,
  ServerResponse,
} from "../http/http-adapter";
import { NotFoundError } from "../errors/index";
import type {
  RouteCompilerInput,
  CompiledRoute,
  ControllerInstance,
} from "./types";
import { requestContext } from "../context";
import { normalizeQueryParams } from "../decorators/query-params";
import type { QueryClient } from "../sql/postgres-executor";
import { invokeController } from "../utils/controller";

const EMPTY_ARGS: unknown[] = [];

function compileHandler(input: RouteCompilerInput): ServerHandler {
  const {
    route,
    resolveController,
    getArgs,
    createResponse,
    authorize,
    executeSql,
    executeTransaction,
    handleError,
    middlewares,
    executeBackground,
  } = input;

  const execute = async (
    request: ServerRequest,
  ): Promise<Response | ServerResponse> => {
    let instance: ControllerInstance | undefined;

    try {
      const authFailure = await authorize(request);

      if (authFailure) {
        return authFailure;
      }

      route.bodyValidator?.(request.body);
      if (route.querySchema) {
        request.query = normalizeQueryParams(
          request.query,
          route.querySchema,
          route.queryDefaults,
        );
        route.queryValidator?.(request.query);
      }

      if (route.background) {
        return executeBackground(request, () => {
          instance = resolveController();
          return invokeController(
            instance,
            route.propertyKey,
            route.parameters.length > 0 ? getArgs(request) : EMPTY_ARGS,
          );
        });
      }

      instance = resolveController();
      const controller = instance;

      const executeRoute = async (transactionClient?: QueryClient) => {
        if (route.beforeSql !== undefined) {
          const beforeSqlArgs =
            route.beforeSql === route.propertyKey
              ? route.parameters.length > 0
                ? getArgs(request)
                : EMPTY_ARGS
              : [request];
          await invokeController(controller, route.beforeSql, beforeSqlArgs);
        }

        const sqlResult = executeSql
          ? await executeSql(request, transactionClient)
          : null;
        const sqlValue =
          route.sqlResult === "one"
            ? sqlResult?.rows[0]
            : route.sqlResult === "none"
              ? undefined
              : sqlResult?.rows;

        if (
          route.sqlOnEmpty === "notFound" &&
          (!sqlResult || sqlResult.rows.length === 0)
        ) {
          throw new NotFoundError();
        }

        request.result = sqlValue;

        const sameMethodIsBeforeSql = route.beforeSql === route.propertyKey;
        const resolvedResult = sameMethodIsBeforeSql
          ? undefined
          : await invokeController(
              controller,
              route.propertyKey,
              route.parameters.length > 0 ? getArgs(request) : EMPTY_ARGS,
            );
        const responseValue =
          route.queryName && resolvedResult === undefined
            ? sqlValue
            : resolvedResult;

        return responseValue instanceof Response
          ? responseValue
          : createResponse(responseValue);
      };

      const response =
        executeTransaction && route.transaction
          ? await executeTransaction(route.transaction, async (client) => {
              requestContext().transaction = client;
              try {
                return await executeRoute(client);
              } finally {
                delete requestContext().transaction;
              }
            })
          : await executeRoute();

      if (route.afterCommit !== undefined) {
        await invokeController(controller, route.afterCommit, [request]);
      }

      return response;
    } catch (error) {
      return handleError(error, instance);
    }
  };

  if (middlewares.length === 0) {
    return (request) => execute(request);
  }

  return async (request: ServerRequest) => {
    try {
      return await runMiddlewareChain(
        request,
        middlewares,
        (nextRequest) => execute(nextRequest) as Promise<ServerResponse>,
      );
    } catch (error) {
      return handleError(error);
    }
  };
}

/**
 * Compila a metadata de uma rota em handlers prontos para o adapter HTTP.
 *
 * O handler completo executa autorização, validação, SQL, controller,
 * middleware e tratamento de erros.
 *
 * A compilação acontece durante `Empilha.initialize()`. Nenhum controller é
 * executado nesta etapa.
 *
 * @param input - Dependências compiladas e metadata da rota.
 * @returns Handler da rota.
 *
 * @example
 * const { handler } = compileRoute(routeInput)
 */
export function compileRoute(input: RouteCompilerInput): CompiledRoute {
  return {
    handler: compileHandler(input),
  };
}
