export {
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
} from "./core/empilha";

export { compileNamedSQL, postgresRunner } from "./sql";

export {
  defineConfig,
  type DatabaseConfig,
  type EmpilhaConfig,
} from "./core/config";

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
  Responses,
  Produces,
  Guard,
  Roles,
  Param,
  Query,
  HeaderParams,
  QueryParams,
  Header,
  Request,
  Context,
  Identity,
  compileValidator,
  type Validator,
} from "./decorators";
export {
  testPostgres,
  type TestPostgres,
  type TestPostgresCall,
  type TestPostgresTransaction,
} from "./application/testing/test-postgres";

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
export {
  CLOCK,
  REQUEST_ID_GENERATOR,
  createToken,
  type Clock,
  type RequestIdGenerator,
  type Token,
} from "./di";
export type { ApplicationProvider } from "./di";

export { QueryRegistry } from "./sql";
export {
  defineModule,
  isModuleDefinition,
  type ModuleDefinition,
  type ModuleController,
  type ModuleOptions,
  type ModuleProvider,
} from "./modules";
export {
  createDoctorReport,
  diagnoseApplication,
  formatDoctorReport,
  verifyGeneratedQueryManifest,
  DIAGNOSTIC_SCHEMA_VERSION,
  type DoctorReport,
} from "./diagnostics";
export {
  DeclarativePluginRegistry,
  defineDeclarativePlugin,
  isDeclarativePlugin,
  type DeclarativePlugin,
  type DeclarativePluginContext,
  type DeclarativePluginDescriptor,
  type DeclarativePostgresOptions,
  type PluginHealthCheck,
  type PluginCapability,
  type PluginCapabilityContract,
  type PluginCapabilityDeclaration,
  type PluginCapabilityRequirement,
  type PluginDiagnostic,
  type PluginPostgresIntegration,
  type PluginRegistryResult,
  type RegisteredPlugin,
} from "./application/declarative-plugin";
export {
  createGeneratedQueryManifest,
  defineGeneratedQuery,
  hashSQL,
  verifyGeneratedQuerySQL,
  type GeneratedQuery,
  type GeneratedQueryCardinality,
  type GeneratedQueryInput,
  type GeneratedQueryInputOf,
  type GeneratedQueryManifest,
  type GeneratedQueryManifestEntry,
  type GeneratedQueryOptions,
  type GeneratedQueryVerification,
} from "./sql/generated-query";
export {
  createApplication,
  createTestApplication,
  type ApplicationInspection,
  type CreateApplicationOptions,
  type EmpilhaApplication,
  type TestApplicationBuilder,
  type TestApplicationOptions,
} from "./application/application";

export type { OpenApiDocument, OpenApiOptions } from "./openapi";

export type {
  ControllerOptions,
  Infer,
  IdentityAccess,
  SqlOptions,
  RequestContext,
} from "./core/types";
export type { Static, TSchema } from "@sinclair/typebox";
export { serializeJson } from "./runtime";
export type { Logger } from "./utils/logger";
export {
  ApplicationEvents,
  observableError,
  type ApplicationEventListener,
  type ApplicationEventMap,
  type ApplicationEventName,
  type BackgroundCompletedEvent,
  type QueryCompletedEvent,
  type RequestCompletedEvent,
} from "./runtime";
export type { AuthResult, AuthTokenHandler, RoleHierarchy } from "./runtime";

export * as t from "@sinclair/typebox";
