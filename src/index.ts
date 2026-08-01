export {
  Empilha,
  createTestApp,
  type ManagedPostgresPool,
  type PostgresOptions,
  type HttpOptions,
  type CorsOptions,
  type HealthCheckOptions,
  type RunOptions,
  type EmpilhaRuntimeConfig,
  type PostgresPool,
  type BackgroundJobsOptions,
  type PostgresQueryRunner,
  type QueryExecutionOptions,
  type TestClient,
  type TestRequestOptions,
  type TestRawRequestOptions,
} from "./empilha";

export { postgresRunner } from "./sql";

export {
  defineConfig,
  type DatabaseConfig,
  type EmpilhaConfig,
} from "./config";

export {
  HttpAdapter,
  type HandlerOptions,
  type MiddlewareFn,
  requestLogger,
  type RequestLog,
  type RequestLogWriter,
  type ServerHandler,
  type ServerRequest,
  type ServerResponse,
} from "./http";

export {
  AfterResponse,
  Body,
  BeforeSql,
  AfterCommit,
  Catch,
  Controller,
  Delete,
  Get,
  Head,
  Options,
  Patch,
  Post,
  Put,
  Use,
  Sql,
  Transaction,
  Result,
  NotFoundWhenEmpty,
  Status,
  Returns,
  Produces,
  Guard,
  Roles,
  Param,
  Query,
  QueryParams,
  Header,
  Request,
  Context,
  Identity,
  compileValidator,
  type Validator,
} from "./decorators";
export { definePlugin, type EmpilhaPlugin } from "./application/plugin";
export { testPostgres, type TestPostgres } from "./application/test-postgres";

export { HttpError, NotFoundError, ValidationError } from "./errors";
export { ErrorResponseSchema } from "./errors";

export {
  requestContext,
  tryRequestContext,
  waitForRequestTasks,
  type RequestScope,
} from "./context";

export {
  Container,
  Inject,
  Injectable,
  type Constructor,
  type DependencyToken,
  type InjectableOptions,
  type Provider,
  type ProviderScope,
} from "./di";

export { QueryRegistry } from "./sql";

export type { OpenApiDocument, OpenApiOptions } from "./openapi";

export type {
  ControllerOptions,
  Infer,
  SqlOptions,
  RequestContext,
} from "./types";
export { serializeJson } from "./runtime";
export type { Logger } from "./utils/logger";
export type { AuthResult, AuthTokenHandler, RoleHierarchy } from "./runtime";

export * as t from "@sinclair/typebox";
