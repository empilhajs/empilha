import { ErrorResponseSchema } from "../errors";
import type { RegisteredRouteMetadata } from "../core/types";
import type { OpenApiResponse } from "./openapi-types";

const NO_CONTENT_RESPONSE: OpenApiResponse = Object.freeze({
  description: "No Content",
});
const JSON_RESPONSE_NO_SCHEMA: OpenApiResponse = Object.freeze({
  description: "Successful response",
  content: { "application/json": {} },
});

function responseForRoute(
  route: RegisteredRouteMetadata,
  status: number,
  schema = route.responses?.[String(status)] ?? route.responseSchema,
): OpenApiResponse {
  if (status === 204) return NO_CONTENT_RESPONSE;
  const mediaType = route.contentType ?? "application/json";
  if (!schema) {
    if (mediaType === "application/json") return JSON_RESPONSE_NO_SCHEMA;
    return { description: "Successful response", content: { [mediaType]: {} } };
  }
  return {
    description: "Successful response",
    content: { [mediaType]: { schema } },
  };
}

function errorResponse(description: string): OpenApiResponse {
  return {
    description,
    content: {
      "application/problem+json": { schema: ErrorResponseSchema },
    },
  };
}

const BASE_ERROR_RESPONSES = Object.freeze({
  "400": errorResponse("Bad Request"),
  "408": errorResponse("Request Timeout"),
  "413": errorResponse("Payload Too Large"),
  "415": errorResponse("Unsupported Media Type"),
  "500": errorResponse("Internal Server Error"),
  "503": errorResponse("Service Unavailable"),
  "504": errorResponse("Gateway Timeout"),
});

function errorResponsesForRoute(
  route: RegisteredRouteMetadata,
): Record<string, OpenApiResponse> {
  const responses: Record<string, OpenApiResponse> = {
    ...BASE_ERROR_RESPONSES,
  };
  if (route.auth || route.requiresAuth) {
    responses["401"] = errorResponse("Unauthorized");
    responses["403"] = errorResponse("Forbidden");
  }
  if (route.sqlOnEmpty === "notFound")
    responses["404"] = errorResponse("Not Found");
  return responses;
}

const responsesCache = new Map<
  string,
  WeakMap<object, Record<string, OpenApiResponse>>
>();
const responsesWithoutSchemaCache = new Map<
  string,
  Record<string, OpenApiResponse>
>();

export function cloneResponses(
  responses: Record<string, OpenApiResponse>,
): Record<string, OpenApiResponse> {
  return Object.fromEntries(
    Object.entries(responses).map(([status, response]) => [
      status,
      {
        ...response,
        ...(response.content
          ? {
              content: Object.fromEntries(
                Object.entries(response.content).map(([mediaType, media]) => [
                  mediaType,
                  { ...media },
                ]),
              ),
            }
          : {}),
      },
    ]),
  );
}

export function responsesForRoute(
  route: RegisteredRouteMetadata,
  status: number,
): Record<string, OpenApiResponse> {
  if (route.responses) {
    const responses: Record<string, OpenApiResponse> = {
      ...errorResponsesForRoute(route),
      [String(status)]: responseForRoute(route, status),
    };
    for (const [declaredStatus, schema] of Object.entries(route.responses))
      responses[declaredStatus] = responseForRoute(
        route,
        Number(declaredStatus),
        schema,
      );
    return responses;
  }
  const mediaType = route.contentType ?? "application/json";
  const key = `${status}|${mediaType}|${route.auth || route.requiresAuth ? 1 : 0}|${route.sqlOnEmpty === "notFound" ? 1 : 0}`;
  if (route.responseSchema) {
    let bySchema = responsesCache.get(key);
    if (!bySchema) {
      bySchema = new WeakMap();
      responsesCache.set(key, bySchema);
    }
    const schema = route.responseSchema as object;
    const cached = bySchema.get(schema);
    if (cached) return cached;
    const responses = {
      [status]: responseForRoute(route, status),
      ...errorResponsesForRoute(route),
    };
    bySchema.set(schema, responses);
    return responses;
  }
  const cached = responsesWithoutSchemaCache.get(key);
  if (cached) return cached;
  const responses = {
    [status]: responseForRoute(route, status),
    ...errorResponsesForRoute(route),
  };
  responsesWithoutSchemaCache.set(key, responses);
  return responses;
}
