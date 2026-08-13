import type { RegisteredRouteMetadata } from "../core/types";
import type { TSchema } from "@sinclair/typebox";
import { statusCode } from "../compiler/response-compiler";
import { openApiPathVariants, parametersForRoute } from "./openapi-parameters";
import { cloneResponses, responsesForRoute } from "./openapi-responses";
import type { OpenApiComponents, OpenApiOperation } from "./openapi-types";

/** Documento OpenAPI 3.1.0 gerado a partir dos decorators das rotas. */
export type OpenApiDocument = {
  openapi: "3.1.0";
  info: {
    title: string;
    version: string;
  };
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: OpenApiComponents;
};

/** Opções de configuração do documento OpenAPI. */
export type OpenApiOptions = {
  title?: string;
  version?: string;
};

/** Constrói o documento OpenAPI 3.1.0 a partir das rotas registradas. */
export class OpenApiDocumentBuilder {
  private readonly paths: OpenApiDocument["paths"] = Object.create(
    null,
  ) as OpenApiDocument["paths"];

  private hasBearerAuthentication = false;

  private readonly componentSchemas: Record<string, TSchema> = Object.create(
    null,
  ) as Record<string, TSchema>;

  private readonly schemaNames = new WeakMap<object, string>();

  private schemaSequence = 0;

  private routeTransaction: {
    paths: Map<string, OpenApiDocument["paths"][string] | undefined>;
    hasBearerAuthentication: boolean;
    schemas: TSchema[];
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
      schemas: [],
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
    for (const schema of transaction.schemas) {
      const name = this.schemaNames.get(schema);
      if (name) {
        delete this.componentSchemas[name];
        this.schemaNames.delete(schema);
      }
    }
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
      if (parameters.length > 0) {
        operation.parameters = parameters.map((parameter) => ({
          ...parameter,
          schema: this.referenceSchema(
            parameter.schema as TSchema,
            `${controllerName}_${String(route.propertyKey)}_${parameter.name}`,
          ),
        }));
      }
      if (route.bodySchema) {
        operation.requestBody = {
          required: true,
          content: {
            "application/json": {
              schema: this.referenceSchema(
                route.bodySchema,
                `${controllerName}_${String(route.propertyKey)}_body`,
              ),
            },
          },
        };
      }
      operation.responses = this.referenceResponseSchemas(
        operation.responses,
        `${controllerName}_${String(route.propertyKey)}`,
      );
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

    if (
      this.hasBearerAuthentication ||
      Object.keys(this.componentSchemas).length > 0
    ) {
      document.components = {
        ...(this.hasBearerAuthentication
          ? {
              securitySchemes: {
                bearerAuth: {
                  type: "http",
                  scheme: "bearer",
                  bearerFormat: "JWT",
                },
              },
            }
          : {}),
        ...(Object.keys(this.componentSchemas).length > 0
          ? { schemas: { ...this.componentSchemas } }
          : {}),
      };
    }

    return document;
  }

  private referenceResponseSchemas(
    responses: OpenApiOperation["responses"],
    hint: string,
  ): OpenApiOperation["responses"] {
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
                    media.schema
                      ? {
                          ...media,
                          schema: this.referenceSchema(
                            media.schema,
                            `${hint}_${status}`,
                          ),
                        }
                      : media,
                  ]),
                ),
              }
            : {}),
        },
      ]),
    );
  }

  private referenceSchema(schema: TSchema, hint: string): TSchema {
    if (typeof schema !== "object" || schema === null) return schema;
    if (!this.requiresComponent(schema)) return schema;
    const existing = this.schemaNames.get(schema);
    if (existing)
      return { $ref: `#/components/schemas/${existing}` } as unknown as TSchema;
    const schemaId = (schema as { $id?: unknown }).$id;
    let name = this.schemaName(typeof schemaId === "string" ? schemaId : hint);
    while (this.componentSchemas[name])
      name = this.schemaName(`${hint}_${++this.schemaSequence}`);
    this.schemaNames.set(schema, name);
    this.componentSchemas[name] = {} as TSchema;
    if (this.routeTransaction) this.routeTransaction.schemas.push(schema);
    this.componentSchemas[name] = this.rewriteSchema(schema, name, hint);
    return { $ref: `#/components/schemas/${name}` } as unknown as TSchema;
  }

  private rewriteSchema(
    schema: TSchema,
    ownName: string,
    hint: string,
  ): TSchema {
    const value = schema as Record<string, unknown>;
    const copy: Record<string, unknown> = { ...value };
    const schemaKeys = [
      "items",
      "additionalProperties",
      "contains",
      "if",
      "then",
      "else",
      "not",
      "propertyNames",
    ];
    for (const key of schemaKeys) {
      const nested = copy[key];
      if (nested && typeof nested === "object" && !Array.isArray(nested))
        copy[key] = this.referenceSchema(nested as TSchema, `${hint}_${key}`);
    }
    if (Array.isArray(copy.properties)) return copy as TSchema;
    if (copy.properties && typeof copy.properties === "object") {
      const schemaId = value.$id;
      copy.properties = Object.fromEntries(
        Object.entries(copy.properties as Record<string, unknown>).map(
          ([key, child]) => [
            key,
            typeof schemaId === "string" &&
            child &&
            typeof child === "object" &&
            (child as { $ref?: unknown }).$ref === schemaId
              ? { $ref: `#/components/schemas/${ownName}` }
              : this.referenceSchema(child as TSchema, `${hint}_${key}`),
          ],
        ),
      );
    }
    for (const key of ["oneOf", "anyOf", "allOf", "prefixItems"]) {
      if (Array.isArray(copy[key]))
        copy[key] = copy[key].map((child) =>
          this.referenceSchema(child as TSchema, `${hint}_${key}`),
        );
    }
    const schemaId = value.$id;
    if (typeof schemaId === "string" && copy.$ref === schemaId)
      copy.$ref = `#/components/schemas/${ownName}`;
    if (copy.$ref === `#/components/schemas/${ownName}`) return copy as TSchema;
    return copy as TSchema;
  }

  private requiresComponent(schema: TSchema): boolean {
    const value = schema as Record<string, unknown>;
    if (typeof value.$id === "string" && this.hasReference(value)) return true;
    return this.hasReference(value) && Boolean(value.$id);
  }

  private hasReference(value: unknown, visited = new Set<object>()): boolean {
    if (!value || typeof value !== "object") return false;
    if (visited.has(value)) return true;
    visited.add(value);
    if ("$ref" in value) return true;
    return Object.values(value).some((child) =>
      this.hasReference(child, visited),
    );
  }

  private schemaName(hint: string): string {
    const normalized = hint
      .replace(/[^A-Za-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return normalized || `Schema_${++this.schemaSequence}`;
  }
}

/** Caminho onde o JSON do OpenAPI é servido. */
export const OPENAPI_DOCUMENT_PATH = "/openapi.json";

/** Caminho onde a UI do Swagger é servida. */
export const OPENAPI_UI_PATH = "/docs";
export const OPENAPI_UI_CSS_PATH = "/docs/swagger-ui.css";
export const OPENAPI_UI_BUNDLE_PATH = "/docs/swagger-ui-bundle.js";
export const OPENAPI_UI_PRESET_PATH = "/docs/swagger-ui-standalone-preset.js";
export const OPENAPI_UI_INIT_PATH = "/docs/swagger-ui-init.js";

/** Retorna o HTML da interface Swagger UI para explorar a API. */
export function openApiHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>API Documentation</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self';">
    <link rel="stylesheet" href="${OPENAPI_UI_CSS_PATH}">
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${OPENAPI_UI_BUNDLE_PATH}"></script>
    <script src="${OPENAPI_UI_PRESET_PATH}"></script>
    <script src="${OPENAPI_UI_INIT_PATH}"></script>
  </body>
</html>`;
}

export function openApiInitializer(): string {
  return `window.onload = () => SwaggerUIBundle({
  url: "${OPENAPI_DOCUMENT_PATH}",
  dom_id: "#swagger-ui",
  deepLinking: true,
  presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
  layout: "StandaloneLayout"
});`;
}
