import type { TSchema } from "@sinclair/typebox";
import type { ParameterMetadata, RegisteredRouteMetadata } from "../core/types";
import { statusCode } from "../compiler/response-compiler";
import { ErrorResponseSchema } from "../errors";
import {
  parseRoutePattern,
  type PatternSegment,
} from "../router/route-pattern";

type OpenApiSchema =
  | TSchema
  | {
      type: "string" | "number" | "boolean";
    };

type OpenApiParameter = {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  schema: OpenApiSchema;
};

function parametersForQuerySchema(
  route: RegisteredRouteMetadata,
): OpenApiParameter[] {
  const schema = route.querySchema as
    | (TSchema & {
        properties?: Record<string, TSchema>;
        required?: string[];
      })
    | undefined;
  if (!schema?.properties) return [];

  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, property]) => ({
    name,
    in: "query",
    required: required.has(name) && route.queryDefaults?.[name] === undefined,
    schema: {
      ...property,
      ...(route.queryDefaults?.[name] !== undefined
        ? { default: route.queryDefaults[name] }
        : {}),
    },
  }));
}

function parametersForHeaderSchema(
  route: RegisteredRouteMetadata,
): OpenApiParameter[] {
  const schema = route.headerSchema as
    | (TSchema & {
        properties?: Record<string, TSchema>;
        required?: string[];
      })
    | undefined;
  if (!schema?.properties) return [];

  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, property]) => ({
    name,
    in: "header",
    required: required.has(name),
    schema: property,
  }));
}

type OpenApiResponse = {
  description: string;
  content?: Record<
    string,
    {
      schema?: TSchema;
    }
  >;
};

type OpenApiOperation = {
  operationId: string;
  tags: string[];
  parameters?: OpenApiParameter[];
  requestBody?: {
    required: true;
    content: {
      "application/json": {
        schema: TSchema;
      };
    };
  };
  responses: Record<string, OpenApiResponse>;
  security?: Array<{
    bearerAuth: [];
  }>;
};

/** Documento OpenAPI 3.1.0 gerado a partir dos decorators das rotas. */
export type OpenApiDocument = {
  openapi: "3.1.0";
  info: {
    title: string;
    version: string;
  };
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: {
    securitySchemes: {
      bearerAuth: {
        type: "http";
        scheme: "bearer";
        bearerFormat: "JWT";
      };
    };
  };
};

/** Opções de configuração do documento OpenAPI. */
export type OpenApiOptions = {
  title?: string;
  version?: string;
};

function schemaForParameter(parameter: ParameterMetadata): OpenApiSchema {
  if (parameter.schema) {
    return parameter.schema;
  }

  if (parameter.type === Number) {
    return {
      type: "number",
    };
  }

  if (parameter.type === Boolean) {
    return {
      type: "boolean",
    };
  }

  return {
    type: "string",
  };
}

function parametersForRoute(
  route: RegisteredRouteMetadata,
  segments: readonly PatternSegment[],
  omittedOptionalParameter?: string,
): OpenApiParameter[] {
  if (
    route.parameters.length === 0 &&
    route.querySchema === undefined &&
    route.headerSchema === undefined &&
    !segments.some((segment) => segment.kind !== "static")
  ) {
    return [];
  }

  const routeParameters = new Map(
    segments.flatMap((segment) =>
      segment.kind === "param" || segment.kind === "wildcard"
        ? [[segment.name, segment] as const]
        : [],
    ),
  );
  const parameters: OpenApiParameter[] = route.parameters.flatMap(
    (parameter): OpenApiParameter[] => {
      if (
        parameter.source !== "param" &&
        parameter.source !== "query" &&
        parameter.source !== "header"
      ) {
        return [];
      }

      const name = parameter.name as string;
      if (parameter.source === "param" && name === omittedOptionalParameter) {
        return [];
      }
      const segment = routeParameters.get(name);
      const schema = schemaForParameter(parameter);
      return [
        {
          name,
          in: parameter.source === "param" ? "path" : parameter.source,
          required: parameter.source === "param",
          schema:
            segment?.kind === "param" && segment.expressionSource
              ? ({
                  ...schema,
                  pattern: segment.expressionSource,
                } as OpenApiSchema)
              : schema,
        },
      ];
    },
  );

  const declaredQueries = new Set(
    parameters
      .filter((parameter) => parameter.in === "query")
      .map((parameter) => parameter.name),
  );
  for (const parameter of parametersForQuerySchema(route)) {
    if (!declaredQueries.has(parameter.name)) parameters.push(parameter);
  }

  const declaredHeaders = new Set(
    parameters
      .filter((parameter) => parameter.in === "header")
      .map((parameter) => parameter.name),
  );
  for (const parameter of parametersForHeaderSchema(route)) {
    if (!declaredHeaders.has(parameter.name)) parameters.push(parameter);
  }

  const declared = new Set(
    parameters
      .filter((parameter) => parameter.in === "path")
      .map((parameter) => parameter.name),
  );

  for (const segment of segments) {
    if (segment.kind === "static") continue;
    const name = segment.name;
    if (name === omittedOptionalParameter) continue;
    if (!declared.has(name)) {
      parameters.push({
        name,
        in: "path",
        required: true,
        schema: {
          type: "string",
          ...(segment.kind === "param" && segment.expressionSource
            ? { pattern: segment.expressionSource }
            : {}),
        } as OpenApiSchema,
      });
    }
  }

  return parameters;
}

type OpenApiPathVariant = {
  path: string;
  segments: PatternSegment[];
  omittedOptionalParameter?: string;
};

function openApiPathVariants(path: string): OpenApiPathVariant[] {
  const segments = parseRoutePattern(path);
  const render = (items: readonly PatternSegment[]): string =>
    `/${items
      .map((segment) =>
        segment.kind === "static" ? segment.value : `{${segment.name}}`,
      )
      .join("/")}`;
  const optional = segments.at(-1);
  if (optional?.kind !== "param" || !optional.optional) {
    return [{ path: render(segments), segments }];
  }
  return [
    {
      path: render(segments.slice(0, -1)),
      segments,
      omittedOptionalParameter: optional.name,
    },
    { path: render(segments), segments },
  ];
}

const NO_CONTENT_RESPONSE: OpenApiResponse = Object.freeze({
  description: "No Content",
});

const JSON_RESPONSE_NO_SCHEMA: OpenApiResponse = Object.freeze({
  description: "Successful response",
  content: {
    "application/json": {},
  },
});

function responseForRoute(
  route: RegisteredRouteMetadata,
  status: number,
  schema = route.responses?.[String(status)] ?? route.responseSchema,
): OpenApiResponse {
  if (status === 204) {
    return NO_CONTENT_RESPONSE;
  }

  const mediaType = route.contentType ?? "application/json";

  if (!schema) {
    if (mediaType === "application/json") return JSON_RESPONSE_NO_SCHEMA;
    return {
      description: "Successful response",
      content: {
        [mediaType]: {},
      },
    };
  }

  return {
    description: "Successful response",
    content: {
      [mediaType]: {
        schema,
      },
    },
  };
}

function errorResponse(description: string): OpenApiResponse {
  return {
    description,
    content: {
      "application/problem+json": {
        schema: ErrorResponseSchema,
      },
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

function cloneResponses(
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

function responsesForRoute(
  route: RegisteredRouteMetadata,
  status: number,
): Record<string, OpenApiResponse> {
  if (route.responses) {
    const responses: Record<string, OpenApiResponse> = {
      ...errorResponsesForRoute(route),
      [String(status)]: responseForRoute(route, status),
    };
    for (const [declaredStatus, schema] of Object.entries(route.responses)) {
      responses[declaredStatus] = responseForRoute(
        route,
        Number(declaredStatus),
        schema,
      );
    }
    return responses;
  }
  const mediaType = route.contentType ?? "application/json";
  const hasAuth = route.auth || route.requiresAuth ? 1 : 0;
  const notFound = route.sqlOnEmpty === "notFound" ? 1 : 0;
  const key = `${status}|${mediaType}|${hasAuth}|${notFound}`;

  const cached = route.responseSchema
    ? getCachedResponsesWithSchema(key, route, status)
    : getCachedResponsesWithoutSchema(key, route, status);
  return cached;
}

function getCachedResponsesWithSchema(
  key: string,
  route: RegisteredRouteMetadata,
  status: number,
): Record<string, OpenApiResponse> {
  let bySchema = responsesCache.get(key);
  if (!bySchema) {
    bySchema = new WeakMap();
    responsesCache.set(key, bySchema);
  }

  const schema = route.responseSchema as object;
  let responses = bySchema.get(schema);
  if (!responses) {
    responses = {
      [status]: responseForRoute(route, status),
      ...errorResponsesForRoute(route),
    };
    bySchema.set(schema, responses);
  }
  return responses;
}

function getCachedResponsesWithoutSchema(
  key: string,
  route: RegisteredRouteMetadata,
  status: number,
): Record<string, OpenApiResponse> {
  let responses = responsesWithoutSchemaCache.get(key);
  if (!responses) {
    responses = {
      [status]: responseForRoute(route, status),
      ...errorResponsesForRoute(route),
    };
    responsesWithoutSchemaCache.set(key, responses);
  }
  return responses;
}

/** Constrói o documento OpenAPI 3.1.0 a partir das rotas registradas. */
export class OpenApiDocumentBuilder {
  private readonly paths: OpenApiDocument["paths"] = Object.create(
    null,
  ) as OpenApiDocument["paths"];

  private hasBearerAuthentication = false;

  private routeTransaction: {
    paths: Map<string, OpenApiDocument["paths"][string] | undefined>;
    hasBearerAuthentication: boolean;
  } | null = null;

  private info: Required<OpenApiOptions> = {
    title: "Empilha API",
    version: "1.0.0",
  };

  /** Atualiza título e versão do documento sem apagar rotas já registradas. */
  configure(options: OpenApiOptions = {}): void {
    this.info = {
      title: options.title?.trim() || this.info.title,
      version: options.version?.trim() || this.info.version,
    };
  }

  beginRouteTransaction(): void {
    if (this.routeTransaction !== null) {
      throw new Error("Já existe uma transação OpenAPI ativa.");
    }
    this.routeTransaction = {
      paths: new Map(),
      hasBearerAuthentication: this.hasBearerAuthentication,
    };
  }

  commitRouteTransaction(): void {
    this.routeTransaction = null;
  }

  rollbackRouteTransaction(): void {
    const transaction = this.routeTransaction;
    this.routeTransaction = null;
    if (!transaction) return;

    for (const [path, previous] of transaction.paths) {
      if (previous === undefined) delete this.paths[path];
      else this.paths[path] = previous;
    }
    this.hasBearerAuthentication = transaction.hasBearerAuthentication;
  }

  /**
   * Registra uma rota no documento OpenAPI.
   *
   * @param controllerName - Nome do controller usado como tag.
   * @param path - Caminho da rota no formato do router (`:param`).
   * @param route - Metadados completos da rota registrada.
   */
  addRoute(
    controllerName: string,
    path: string,
    route: RegisteredRouteMetadata,
    tags: readonly string[] = [],
  ): void {
    const status = statusCode(route);
    for (const variant of openApiPathVariants(path)) {
      const pathItem = this.paths[variant.path] ?? {};
      if (
        this.routeTransaction &&
        !this.routeTransaction.paths.has(variant.path)
      ) {
        this.routeTransaction.paths.set(
          variant.path,
          this.paths[variant.path]
            ? { ...this.paths[variant.path] }
            : undefined,
        );
      }
      const parameters = parametersForRoute(
        route,
        variant.segments,
        variant.omittedOptionalParameter,
      );
      const operation: OpenApiOperation = {
        operationId:
          `${controllerName}.${String(route.propertyKey)}` +
          (variant.omittedOptionalParameter ? ".withoutOptional" : ""),
        tags: tags.length > 0 ? [...tags] : [controllerName],
        responses: responsesForRoute(route, status),
      };
      if (parameters.length > 0) operation.parameters = parameters;
      if (route.bodySchema) {
        operation.requestBody = {
          required: true,
          content: {
            "application/json": { schema: route.bodySchema },
          },
        };
      }
      if (route.auth || route.requiresAuth) {
        this.hasBearerAuthentication = true;
        operation.security = [{ bearerAuth: [] }];
      }
      pathItem[route.method.toLowerCase()] = operation;
      this.paths[variant.path] = pathItem;
    }
  }

  /**
   * Finaliza e retorna o documento OpenAPI 3.1.0.
   *
   * @returns O documento completo com paths, info e security schemes.
   */
  build(): OpenApiDocument {
    const document: OpenApiDocument = {
      openapi: "3.1.0",
      info: this.info,
      paths: Object.fromEntries(
        Object.entries(this.paths).map(([path, pathItem]) => [
          path,
          Object.fromEntries(
            Object.entries(pathItem).map(([method, operation]) => [
              method,
              {
                ...operation,
                responses: cloneResponses(operation.responses),
              },
            ]),
          ),
        ]),
      ) as OpenApiDocument["paths"],
    };

    if (this.hasBearerAuthentication) {
      document.components = {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
          },
        },
      };
    }

    return document;
  }
}

/** Caminho onde o JSON do OpenAPI é servido. */
export const OPENAPI_DOCUMENT_PATH = "/openapi.json";

/** Caminho onde a UI do Swagger é servida. */
export const OPENAPI_UI_PATH = "/docs";

/** Retorna o HTML da interface Swagger UI para explorar a API. */
export function openApiHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>API Documentation</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data:; connect-src 'self';">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.11.10/swagger-ui.css">
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.11.10/swagger-ui-bundle.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.11.10/swagger-ui-standalone-preset.js"></script>
    <script>
      window.onload = () => SwaggerUIBundle({
        url: "${OPENAPI_DOCUMENT_PATH}",
        dom_id: "#swagger-ui",
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: "StandaloneLayout"
      });
    </script>
  </body>
</html>`;
}
