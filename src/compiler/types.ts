import type {
  ServerHandler,
  ServerRequest,
  ServerResponse,
  MiddlewareFn,
} from "../http/http-adapter";
import type { RegisteredRouteMetadata } from "../types";
import type { QueryClient } from "../sql/postgres-executor";

export type ControllerInstance = Record<PropertyKey, unknown>;
export type ControllerResolver = () => ControllerInstance;
export type ArgumentCompiler = (request: ServerRequest) => unknown[];
export type ResponseFactory = (value: unknown) => ServerResponse;
export type AuthorizationGuard = (
  request: ServerRequest,
) => Promise<ServerResponse | null>;
export type SqlExecutor = (
  request: ServerRequest,
  client?: QueryClient,
) => Promise<{ rows: unknown[] }>;
export type TransactionExecutor = <T>(
  transaction: "read" | "write",
  work: (client: QueryClient) => Promise<T>,
) => Promise<T>;
export type ErrorHandler = (
  error: unknown,
  instance?: ControllerInstance,
) => Promise<ServerResponse>;
export type BackgroundExecutor = (
  request: ServerRequest,
  invoke: () => unknown,
) => ServerResponse;

export type RouteCompilerInput = {
  resolveController: ControllerResolver;
  route: RegisteredRouteMetadata;
  getArgs: ArgumentCompiler;
  createResponse: ResponseFactory;
  authorize: AuthorizationGuard;
  executeSql: SqlExecutor | null;
  executeTransaction?: TransactionExecutor | null;
  handleError: ErrorHandler;
  middlewares: readonly MiddlewareFn[];
  executeBackground: BackgroundExecutor;
};

export type CompiledRoute = {
  handler: ServerHandler;
};
