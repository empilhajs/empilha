import type { HandlerOptions, ServerHandler } from "../http";
import type { RegisteredRouteMetadata } from "../types";
import {
  usesSqlBindingSource,
  type RequestDataSource,
} from "./sql-binding-validation";

export function configureRouteRequest(
  handler: ServerHandler,
  route: RegisteredRouteMetadata,
  sqlSources: Set<RequestDataSource>,
  hasScopedMiddleware: boolean,
): ServerHandler & HandlerOptions {
  const configured = handler as ServerHandler & HandlerOptions;
  const hasFullRequest =
    route.parameters.some((parameter) => parameter.source === "request") ||
    hasScopedMiddleware;

  configured.needsRequest =
    hasFullRequest ||
    route.parameters.length > 0 ||
    Boolean(route.queryName) ||
    Boolean(route.transaction) ||
    Boolean(route.background) ||
    Boolean(route.auth) ||
    route.requiresAuth === true ||
    route.beforeSql !== undefined ||
    route.afterCommit !== undefined ||
    Boolean(route.querySchema) ||
    Boolean(route.bodySchema) ||
    Boolean(route.bodyValidator) ||
    sqlSources.size > 0;

  configured.needsQuery =
    hasFullRequest ||
    route.parameters.some((parameter) => parameter.source === "query") ||
    Boolean(route.querySchema) ||
    sqlSources.has("query") ||
    usesSqlBindingSource(route, "query");
  configured.needsHeaders =
    hasFullRequest ||
    Boolean(route.auth) ||
    Boolean(route.requiresAuth) ||
    route.parameters.some((parameter) => parameter.source === "header") ||
    sqlSources.has("header") ||
    usesSqlBindingSource(route, "header") ||
    sqlSources.has("auth") ||
    sqlSources.has("identity") ||
    usesSqlBindingSource(route, "auth") ||
    usesSqlBindingSource(route, "identity");
  configured.needsBody =
    hasFullRequest ||
    route.parameters.some((parameter) => parameter.source === "body") ||
    Boolean(route.bodySchema) ||
    Boolean(route.bodyValidator) ||
    sqlSources.has("body") ||
    usesSqlBindingSource(route, "body");

  if (route.contentType?.startsWith("text/")) {
    configured.responseType = "text";
  } else {
    configured.responseType = "json";
  }

  return configured;
}
