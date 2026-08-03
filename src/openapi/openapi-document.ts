import type { RegisteredRouteMetadata } from "../core/types";
import { statusCode } from "../compiler/response-compiler";
import { openApiPathVariants, parametersForRoute } from "./openapi-parameters";
import { cloneResponses, responsesForRoute } from "./openapi-responses";
import type { OpenApiOperation } from "./openapi-types";

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
