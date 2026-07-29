import type { TSchema } from "@sinclair/typebox";
import type { ParameterMetadata, RegisteredRouteMetadata } from "../types";
import { statusCode } from "../compiler/response-compiler";
import { ErrorResponseSchema } from "../errors";

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

export type OpenApiRoutesSnapshot = {
  paths: OpenApiDocument["paths"];
  hasBearerAuthentication: boolean;
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
  path: string,
): OpenApiParameter[] {
  const parameters: OpenApiParameter[] = route.parameters.flatMap(
    (parameter): OpenApiParameter[] => {
      if (
        parameter.source !== "param" &&
        parameter.source !== "query" &&
        parameter.source !== "header"
      ) {
        return [];
      }

      return [
        {
          name: parameter.name as string,
          in: parameter.source === "param" ? "path" : parameter.source,
          required: parameter.source === "param",
          schema: schemaForParameter(parameter),
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

  const declared = new Set(
    parameters
      .filter((parameter) => parameter.in === "path")
      .map((parameter) => parameter.name),
  );

  for (const match of path.matchAll(/:([^/]+)/g)) {
    const name = match[1];
    if (!declared.has(name)) {
      parameters.push({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
      });
    }
  }

  return parameters;
}

function openApiPath(path: string): string {
  return path.replace(/:([^/]+)/g, "{$1}");
}

function responseForRoute(route: RegisteredRouteMetadata): OpenApiResponse {
  const status = statusCode(route);

  if (status === 204) {
    return {
      description: "No Content",
    };
  }

  const mediaType = route.contentType ?? "application/json";

  return {
    description: "Successful response",
    content: {
      [mediaType]: route.responseSchema
        ? {
            schema: route.responseSchema,
          }
        : {},
    },
  };
}

function errorResponse(description: string): OpenApiResponse {
  return {
    description,
    content: {
      "application/json": {
        schema: ErrorResponseSchema,
      },
    },
  };
}

function errorResponsesForRoute(
  route: RegisteredRouteMetadata,
): Record<string, OpenApiResponse> {
  const responses: Record<string, OpenApiResponse> = {
    "400": errorResponse("Bad Request"),
    "500": errorResponse("Internal Server Error"),
  };
  if (route.auth || route.requiresAuth) {
    responses["401"] = errorResponse("Unauthorized");
    responses["403"] = errorResponse("Forbidden");
  }
  if (route.sqlOnEmpty === "notFound")
    responses["404"] = errorResponse("Not Found");
  return responses;
}

/** Constrói o documento OpenAPI 3.1.0 a partir das rotas registradas. */
export class OpenApiDocumentBuilder {
  private readonly paths: OpenApiDocument["paths"] = Object.create(
    null,
  ) as OpenApiDocument["paths"];

  private hasBearerAuthentication = false;

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

  /** Captura as rotas para permitir rollback durante o bootstrap. */
  snapshotRoutes(): OpenApiRoutesSnapshot {
    const paths = Object.create(null) as OpenApiDocument["paths"];
    for (const [path, item] of Object.entries(this.paths)) {
      paths[path] = { ...item };
    }

    return {
      paths,
      hasBearerAuthentication: this.hasBearerAuthentication,
    };
  }

  /** Restaura as rotas após uma falha no bootstrap. */
  restoreRoutes(snapshot: OpenApiRoutesSnapshot): void {
    for (const path of Object.keys(this.paths)) delete this.paths[path];
    Object.assign(this.paths, snapshot.paths);
    this.hasBearerAuthentication = snapshot.hasBearerAuthentication;
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
    const documentPath = openApiPath(path);
    const pathItem = this.paths[documentPath] ?? {};
    const parameters = parametersForRoute(route, path);
    const status = statusCode(route);

    const operation: OpenApiOperation = {
      operationId: `${controllerName}.${String(route.propertyKey)}`,
      tags: tags.length > 0 ? [...tags] : [controllerName],
      responses: {
        [status]: responseForRoute(route),
        ...errorResponsesForRoute(route),
      },
    };

    if (parameters.length > 0) {
      operation.parameters = parameters;
    }

    if (route.bodySchema) {
      operation.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: route.bodySchema,
          },
        },
      };
    }

    if (route.auth || route.requiresAuth) {
      this.hasBearerAuthentication = true;
      operation.security = [
        {
          bearerAuth: [],
        },
      ];
    }

    pathItem[route.method.toLowerCase()] = operation;
    this.paths[documentPath] = pathItem;
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
      paths: this.paths,
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
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self';">
    <style>body { font-family: system-ui, sans-serif; margin: 2rem; } pre { white-space: pre-wrap; }</style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script>
      fetch("${OPENAPI_DOCUMENT_PATH}")
        .then(response => response.ok ? response.json() : Promise.reject(response.status))
        .then(openApiDocument => {
          const output = document.createElement("pre");
          output.textContent = JSON.stringify(openApiDocument, null, 2);
          document.getElementById("swagger-ui").replaceChildren(output);
        })
        .catch(() => {
          document.getElementById("swagger-ui").textContent = "Unable to load OpenAPI document.";
        });
    </script>
  </body>
</html>`;
}
