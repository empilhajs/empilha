import type { DependencyToken } from "../../di";
import {
  getControllerCatchHandlers,
  getControllerOptions,
  getControllerPath,
  getControllerRoutes,
} from "../../core/metadata";
import { joinPaths } from "../../router";
import {
  isModuleDefinition,
  type ModuleController,
  type ModuleDefinition,
} from "../../modules";
import {
  diagnoseDeclarativePlugins,
  isDeclarativePlugin,
} from "../declarative-plugin";
import { compileNamedSQL } from "../../sql";
import type { GeneratedQuery } from "../../sql/generated-query";
import {
  assertGeneratedQueryBindingTypes,
  assertGeneratedQueryBindings,
  assertRouteSqlBindings,
} from "../bootstrap/sql-binding-validation";
import {
  exportedTokens,
  providerDependencies,
  providerScope,
  providerToken,
} from "./provider-utils";
import {
  collectVisibleQueries,
  findAsyncRequestFactory,
  findVisibleProvider,
  requiresRequestScope,
} from "./visibility";

export {
  assertValidApplicationGraph,
  linkApplicationGraph,
  linkApplicationGraphAsync,
  type ApplicationLinkOptions,
  type LinkedApplication,
  type ModuleRuntime,
} from "./linker";

export type GraphDiagnostic = {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly module?: string;
  readonly subject?: Readonly<{
    module?: string;
    controller?: string;
    method?: string;
  }>;
  readonly source?: Readonly<{
    readonly file: string;
    readonly line?: number;
    readonly column?: number;
  }>;
  readonly related?: readonly Readonly<{
    readonly file: string;
    readonly line?: number;
    readonly column?: number;
  }>[];
  readonly found?: readonly string[];
  readonly hint?: string;
};

export type CompiledModule = Readonly<{
  readonly name: string;
  readonly definition: ModuleDefinition;
  readonly imports: readonly string[];
  readonly controllers: readonly ModuleController[];
  readonly providers: readonly DependencyToken[];
  readonly exports: readonly DependencyToken[];
  readonly queries: readonly GeneratedQuery[];
  readonly plugins: readonly unknown[];
}>;

export type ApplicationGraph = Readonly<{
  readonly root: string;
  readonly modules: readonly CompiledModule[];
  readonly diagnostics: readonly GraphDiagnostic[];
}>;

export type ApplicationGraphBuildOptions = Readonly<{
  /** Permite registrar queries nomeadas no setup de uma testing application. */
  readonly allowRuntimeQueries?: boolean;
}>;

function queryLabel(query: GeneratedQuery): string {
  return `"${query.id}" (${query.source})`;
}

function routePattern(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      const parameter = segment.match(/^:([A-Za-z_]\w*)(<.+>)?(\?)?$/);
      if (parameter) return `:param${parameter[2] ?? ""}${parameter[3] ?? ""}`;
      if (segment.startsWith("*") && /^\*[A-Za-z_]\w*$/.test(segment))
        return "*param";
      return segment;
    })
    .join("/");
}

function routeShape(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      if (/^:[A-Za-z_]\w*(<.+>)?(\?)?$/.test(segment)) return ":segment";
      if (/^\*[A-Za-z_]\w*$/.test(segment)) return ":segment";
      return segment;
    })
    .join("/");
}

function pluginProvides(plugin: unknown, capability: string): boolean {
  if (!isDeclarativePlugin(plugin)) return false;
  return Boolean(
    plugin.descriptor.provides?.some(
      (provided) =>
        (typeof provided === "string" ? provided : provided.name) ===
        capability,
    ),
  );
}

function moduleProvidesCapability(
  module: ModuleDefinition,
  capability: string,
  visited = new Set<ModuleDefinition>(),
): boolean {
  if (visited.has(module)) return false;
  visited.add(module);
  return (
    module.plugins.some((plugin) => pluginProvides(plugin, capability)) ||
    module.imports.some((imported) =>
      moduleProvidesCapability(imported, capability, visited),
    )
  );
}

/** Compila declarações de módulos em um grafo readonly e diagnosticável. */
export class ApplicationGraphBuilder {
  build(
    root: ModuleDefinition,
    options: ApplicationGraphBuildOptions = {},
  ): ApplicationGraph {
    const diagnostics: GraphDiagnostic[] = [];
    const modules: CompiledModule[] = [];
    const byName = new Map<string, ModuleDefinition>();
    const visiting: ModuleDefinition[] = [];
    const compiled = new Set<ModuleDefinition>();
    const queryOwners = new Map<string, string>();
    const routeOwners = new Map<
      string,
      { module: string; controller: string; path: string }
    >();
    const routePatternOwners = new Map<
      string,
      { module: string; controller: string; path: string }
    >();
    const routeShapeOwners = new Map<
      string,
      { module: string; controller: string; path: string; pattern: string }
    >();
    const operationOwners = new Map<string, { module: string; path: string }>();
    const schemaOwners = new Map<
      string,
      { module: string; controller: string; method: string; schema: object }
    >();

    const visit = (module: ModuleDefinition): void => {
      const cycleStart = visiting.indexOf(module);
      if (cycleStart >= 0) {
        const cycle = [...visiting.slice(cycleStart), module]
          .map((item) => item.name)
          .join(" → ");
        diagnostics.push({
          code: "E_MODULE_IMPORT_CYCLE",
          severity: "error",
          module: module.name,
          message: `Ciclo de imports: ${cycle}`,
          hint: "Remova um dos imports ou extraia o contrato compartilhado para um terceiro módulo.",
        });
        return;
      }
      const previous = byName.get(module.name);
      if (previous && previous !== module) {
        diagnostics.push({
          code: "E_MODULE_DUPLICATE",
          severity: "error",
          module: module.name,
          message: `O módulo "${module.name}" foi declarado por duas instâncias.`,
          hint: "Reutilize a mesma instância do módulo configurado.",
        });
        return;
      }
      byName.set(module.name, module);
      if (compiled.has(module)) return;
      visiting.push(module);
      for (const imported of module.imports) visit(imported);
      visiting.pop();
      for (const query of module.queries) {
        const owner = queryOwners.get(query.id);
        if (owner) {
          diagnostics.push({
            code: "E_QUERY_DUPLICATE",
            severity: "error",
            module: module.name,
            message: `A query ${queryLabel(query)} também foi declarada pelo módulo "${owner}".`,
            hint: "Mova a query para um único módulo compartilhado.",
          });
        } else queryOwners.set(query.id, module.name);
      }
      const visibleQueries = new Map<string, GeneratedQuery>();
      for (const [id, query] of collectVisibleQueries(module))
        visibleQueries.set(id, query);
      for (const diagnostic of diagnoseDeclarativePlugins(module.plugins)) {
        diagnostics.push({
          code: diagnostic.code,
          severity: "error",
          module: module.name,
          subject: { module: module.name },
          message: diagnostic.message,
          hint: diagnostic.hint,
        });
      }
      for (const controller of module.controllers) {
        const prototype = controller.prototype as Record<PropertyKey, unknown>;
        const controllerOptions = getControllerOptions(controller);
        for (const [errorType, methodKey] of getControllerCatchHandlers(
          controller,
        )) {
          const validErrorType =
            typeof errorType === "function" &&
            (errorType === Error || errorType.prototype instanceof Error);
          const validHandler =
            typeof prototype[methodKey] === "function" &&
            (prototype[methodKey] as Function).length >= 1;
          if (!validErrorType || !validHandler) {
            diagnostics.push({
              code: "E_CATCHER_INVALID",
              severity: "error",
              module: module.name,
              subject: {
                module: module.name,
                controller: controller.name,
                method: String(methodKey),
              },
              message: `O catcher ${controller.name}.${String(methodKey)} possui assinatura inválida para ${typeof errorType === "function" ? errorType.name : String(errorType)}.`,
              hint: "Use uma classe que estenda Error e um método existente que receba o erro como primeiro argumento.",
            });
          }
        }
        for (const route of getControllerRoutes(controller)) {
          const fullPath = joinPaths(
            getControllerPath(controller) ?? "",
            route.path,
          );
          const owner = {
            module: module.name,
            controller: controller.name,
            path: fullPath,
          };
          const operationId = `${controller.name || "Controller"}.${String(route.propertyKey)}`;
          const previousOperation = operationOwners.get(operationId);
          if (previousOperation && previousOperation.path !== fullPath) {
            diagnostics.push({
              code: "E_OPENAPI_OPERATION_ID_DUPLICATE",
              severity: "error",
              module: module.name,
              subject: {
                module: module.name,
                controller: controller.name,
                method: String(route.propertyKey),
              },
              message: `O operationId "${operationId}" é usado pela rota ${previousOperation.path} e novamente por ${fullPath}.`,
              hint: "Renomeie o controller ou o método para produzir operation IDs únicos no documento OpenAPI.",
            });
          } else {
            operationOwners.set(operationId, {
              module: module.name,
              path: fullPath,
            });
          }
          const schemas = [
            route.responseSchema,
            ...Object.values(route.responses ?? {}),
            route.bodySchema,
            route.headerSchema,
            route.identitySchema,
            ...route.parameters.map((parameter) => parameter.schema),
          ];
          for (const schema of schemas) {
            if (!schema || typeof schema !== "object") continue;
            const id = (schema as { $id?: unknown }).$id;
            if (typeof id !== "string" || !id) continue;
            const previousSchema = schemaOwners.get(id);
            if (previousSchema && previousSchema.schema !== schema) {
              diagnostics.push({
                code: "E_OPENAPI_SCHEMA_DUPLICATE",
                severity: "error",
                module: module.name,
                subject: {
                  module: module.name,
                  controller: controller.name,
                  method: String(route.propertyKey),
                },
                message: `O schema OpenAPI "${id}" foi declarado por ${previousSchema.controller}.${previousSchema.method} e novamente por ${controller.name}.${String(route.propertyKey)}.`,
                hint: "Compartilhe a mesma instância do schema ou use IDs OpenAPI distintos.",
              });
            } else {
              schemaOwners.set(id, {
                module: module.name,
                controller: controller.name,
                method: String(route.propertyKey),
                schema,
              });
            }
          }
          const routeKey = `${route.method} ${fullPath}`;
          const previousRoute = routeOwners.get(routeKey);
          if (previousRoute) {
            diagnostics.push({
              code: "E_ROUTE_DUPLICATE",
              severity: "error",
              module: module.name,
              subject: {
                module: module.name,
                controller: controller.name,
                method: String(route.propertyKey),
              },
              message: `A rota ${route.method} ${fullPath} foi declarada por ${previousRoute.controller} e ${controller.name}.`,
              hint: "Mantenha apenas um controller para a combinação de método e caminho.",
            });
          } else {
            routeOwners.set(routeKey, owner);
          }

          const patternKey = `${route.method} ${routePattern(fullPath)}`;
          const previousPattern = routePatternOwners.get(patternKey);
          if (previousPattern && previousPattern.path !== fullPath) {
            diagnostics.push({
              code: "E_ROUTE_PARAM_CONFLICT",
              severity: "error",
              module: module.name,
              subject: {
                module: module.name,
                controller: controller.name,
                method: String(route.propertyKey),
              },
              message: `A rota ${route.method} ${fullPath} possui a mesma estrutura de ${previousPattern.path}, mas usa nomes de parâmetros diferentes.`,
              hint: "Use o mesmo nome de parâmetro em todas as rotas estrutururalmente equivalentes.",
            });
          } else {
            routePatternOwners.set(patternKey, owner);
          }

          const shapeKey = `${route.method} ${routeShape(fullPath)}`;
          const pattern = routePattern(fullPath);
          const previousShape = routeShapeOwners.get(shapeKey);
          if (
            previousShape &&
            previousShape.path !== fullPath &&
            previousShape.pattern !== pattern
          ) {
            diagnostics.push({
              code: "E_ROUTE_SPECIFICITY_AMBIGUOUS",
              severity: "error",
              module: module.name,
              subject: {
                module: module.name,
                controller: controller.name,
                method: String(route.propertyKey),
              },
              message: `As rotas ${route.method} ${previousShape.path} e ${fullPath} possuem restrições variáveis diferentes e podem aceitar a mesma requisição.`,
              hint: "Use uma única rota ou torne as expressões mutuamente exclusivas.",
            });
          } else {
            routeShapeOwners.set(shapeKey, { ...owner, pattern });
          }

          if (
            route.background &&
            (route.queryName !== undefined ||
              route.queryArtifact !== undefined ||
              route.sqlResult !== undefined ||
              route.beforeSql !== undefined ||
              route.afterCommit !== undefined ||
              route.transaction !== undefined)
          ) {
            diagnostics.push({
              code: "E_RESPONSE_SOURCE_CONFLICT",
              severity: "error",
              module: module.name,
              subject: {
                module: module.name,
                controller: controller.name,
                method: String(route.propertyKey),
              },
              message: `A rota ${controller.name}.${String(route.propertyKey)} combina uma resposta em background com fontes SQL ou lifecycle concorrentes.`,
              hint: "Separe a rota HTTP da tarefa de background ou remova SQL, hooks e transação da rota.",
            });
          }
          for (const [kind, propertyKey] of [
            ["BeforeSql", route.beforeSql],
            ["AfterCommit", route.afterCommit],
          ] as const) {
            if (
              propertyKey !== undefined &&
              typeof prototype[propertyKey] !== "function"
            ) {
              diagnostics.push({
                code: "E_LIFECYCLE_HOOK_INVALID",
                severity: "error",
                module: module.name,
                subject: {
                  module: module.name,
                  controller: controller.name,
                  method: String(route.propertyKey),
                },
                message: `A rota ${controller.name}.${String(route.propertyKey)} referencia ${kind}("${String(propertyKey)}"), mas esse método não existe no controller.`,
                hint: `Declare o método ${String(propertyKey)} no controller ou remova o decorator ${kind}.`,
              });
            }
          }
          if (route.afterCommit !== undefined && !route.transaction) {
            diagnostics.push({
              code: "E_LIFECYCLE_HOOK_INVALID",
              severity: "error",
              module: module.name,
              subject: {
                module: module.name,
                controller: controller.name,
                method: String(route.propertyKey),
              },
              message: `A rota ${controller.name}.${String(route.propertyKey)} usa AfterCommit sem transação.`,
              hint: "Declare @Transaction() na rota ou remova @AfterCommit().",
            });
          }
          const authenticationRequired =
            route.requiresAuth === true ||
            typeof route.auth === "string" ||
            Array.isArray(route.auth) ||
            controllerOptions?.auth !== undefined;
          if (
            authenticationRequired &&
            !moduleProvidesCapability(module, "auth/handler")
          ) {
            diagnostics.push({
              code: "E_AUTH_CAPABILITY_MISSING",
              severity: "error",
              module: module.name,
              subject: {
                module: module.name,
                controller: controller.name,
                method: String(route.propertyKey),
              },
              message: `A rota ${controller.name}.${String(route.propertyKey)} exige autenticação, mas nenhum plugin visível fornece auth/handler.`,
              hint: "Instale um plugin de autenticação no módulo ou remova @Roles/@Identity/Guard configurado no controller.",
            });
          }
          if (
            route.transaction !== undefined &&
            !moduleProvidesCapability(module, "postgres/query-runner")
          ) {
            diagnostics.push({
              code: "E_TRANSACTION_CAPABILITY_MISSING",
              severity: "error",
              module: module.name,
              subject: {
                module: module.name,
                controller: controller.name,
                method: String(route.propertyKey),
              },
              message: `A rota ${controller.name}.${String(route.propertyKey)} usa transação, mas nenhum plugin visível fornece postgres/query-runner.`,
              hint: "Instale @empilha/pg ou outro plugin que forneça postgres/query-runner.",
            });
          }
          if (
            route.sqlResult !== undefined &&
            route.queryName === undefined &&
            route.queryArtifact === undefined
          ) {
            diagnostics.push({
              code: "E_RESULT_WITHOUT_SQL",
              severity: "error",
              module: module.name,
              subject: {
                module: module.name,
                controller: controller.name,
                method: String(route.propertyKey),
              },
              message: `A rota ${controller.name}.${String(route.propertyKey)} usa @Result("${route.sqlResult}"), mas não possui @Sql().`,
              hint: "Associe uma query SQL antes de declarar sua cardinalidade.",
            });
          }
          const artifact = route.queryArtifact;
          if (!artifact) {
            if (
              route.queryName !== undefined &&
              !options.allowRuntimeQueries &&
              !visibleQueries.has(route.queryName)
            ) {
              diagnostics.push({
                code: "E_QUERY_NOT_FOUND",
                severity: "error",
                module: module.name,
                subject: {
                  module: module.name,
                  controller: controller.name,
                  method: String(route.propertyKey),
                },
                message: `A rota ${controller.name}.${String(route.propertyKey)} referencia a query "${route.queryName}", mas ela não foi declarada no grafo.`,
                hint: "Use um query artifact gerado ou declare a query no módulo proprietário.",
              });
            }
            continue;
          }
          if (artifact.sql !== undefined) {
            try {
              const compiledSql = compileNamedSQL(artifact.sql);
              assertGeneratedQueryBindings(route, compiledSql.bindings);
              const typed = compileNamedSQL(artifact.sql, {
                includeTypes: true,
              });
              assertGeneratedQueryBindingTypes(route, typed.bindingTypes);
              assertRouteSqlBindings(
                route,
                route.sqlParams ?? compiledSql.bindings,
                fullPath,
              );
            } catch (error) {
              diagnostics.push({
                code: "E_SQL_BINDING_INVALID",
                severity: "error",
                module: module.name,
                subject: {
                  module: module.name,
                  controller: controller.name,
                  method: String(route.propertyKey),
                },
                message: `Contrato inválido da query "${artifact.id}" na rota ${route.method} ${fullPath} (origem SQL: ${artifact.source}): ${String(error)}`,
                hint: "Regere o artifact e alinhe bindings, schemas e casts do SQL.",
              });
            }
          }
          const visible = visibleQueries.get(artifact.id);
          if (!visible) {
            diagnostics.push({
              code: "E_QUERY_NOT_VISIBLE",
              severity: "error",
              module: module.name,
              subject: {
                module: module.name,
                controller: controller.name,
                method: String(route.propertyKey),
              },
              message: `A rota ${controller.name}.${String(route.propertyKey)} usa a query ${queryLabel(artifact)}, mas ela não é visível no módulo "${module.name}".`,
              hint: "Declare a query no módulo ou importe o módulo que a possui.",
            });
          } else if (visible !== artifact) {
            diagnostics.push({
              code: "E_QUERY_ARTIFACT_MISMATCH",
              severity: "error",
              module: module.name,
              subject: {
                module: module.name,
                controller: controller.name,
                method: String(route.propertyKey),
              },
              message: `A rota ${controller.name}.${String(route.propertyKey)} referencia a query "${artifact.id}", mas o catálogo visível possui outra origem ou definição.`,
              hint: "Use a mesma instância do artefato declarado no módulo.",
            });
          }
        }
      }
      const tokens = module.providers.map(providerToken);
      if (tokens.some((token) => token === undefined))
        diagnostics.push({
          code: "E_PROVIDER_TOKEN_MISSING",
          severity: "error",
          module: module.name,
          message: "Todo provider de módulo precisa declarar um token.",
          hint: "Use uma forma declarativa de provider com a propriedade provide.",
        });
      const providerTokens = tokens.filter(
        (token): token is DependencyToken => token !== undefined,
      );
      const exports = module.exports.filter(
        (entry): entry is DependencyToken => !isModuleDefinition(entry),
      );
      for (const exported of exports) {
        if (
          !providerTokens.includes(exported) &&
          !module.controllers.includes(exported as ModuleController)
        )
          diagnostics.push({
            code: "E_MODULE_INVALID_EXPORT",
            severity: "error",
            module: module.name,
            message: `O módulo exporta um token que não pertence ao módulo: ${String((exported as { description?: string }).description ?? exported)}.`,
            hint: "Declare o provider no módulo ou remova o token de exports.",
          });
      }
      const ownProviderTokens = new Set(providerTokens);
      const importedOwners = new Map<DependencyToken, string[]>();
      for (const imported of module.imports) {
        for (const token of exportedTokens(imported)) {
          const owners = importedOwners.get(token) ?? [];
          if (!owners.includes(imported.name)) owners.push(imported.name);
          importedOwners.set(token, owners);
        }
      }
      for (const [token, owners] of importedOwners) {
        if (owners.length < 2 || ownProviderTokens.has(token)) continue;
        diagnostics.push({
          code: "E_PROVIDER_TOKEN_AMBIGUOUS",
          severity: "error",
          module: module.name,
          message: `O token "${String((token as { description?: string }).description ?? token)}" é exportado por múltiplos imports: ${owners.join(", ")}.`,
          hint: "Exporte o token por apenas um módulo ou declare um provider local explícito.",
        });
      }
      const reportedScopes = new Set<string>();
      const requiresRequest = requiresRequestScope;
      const reportedProviderCycles = new Set<string>();
      const reportedMissingDependencies = new Set<string>();
      const inspectProviderDependencies = (
        owner: ModuleDefinition,
        token: DependencyToken,
        stack: readonly DependencyToken[] = [],
      ): void => {
        const cycleIndex = stack.indexOf(token);
        if (cycleIndex >= 0) {
          const cycle = [...stack.slice(cycleIndex), token]
            .map((item) =>
              String((item as { description?: string }).description ?? item),
            )
            .join(" → ");
          if (!reportedProviderCycles.has(cycle)) {
            reportedProviderCycles.add(cycle);
            diagnostics.push({
              code: "E_PROVIDER_CYCLE",
              severity: "error",
              module: owner.name,
              message: `Ciclo de providers: ${cycle}.`,
              hint: "Quebre o ciclo com um token de fronteira ou reorganize as dependências.",
            });
          }
          return;
        }

        const resolved = findVisibleProvider(owner, token);
        if (!resolved) {
          const missing = String(
            (token as { description?: string }).description ?? token,
          );
          if (!reportedMissingDependencies.has(missing)) {
            reportedMissingDependencies.add(missing);
            diagnostics.push({
              code: "E_PROVIDER_DEPENDENCY_MISSING",
              severity: "error",
              module: owner.name,
              message: `O provider depende do token "${missing}", mas nenhum provider visível o declara.`,
              hint: "Declare o provider no módulo ou importe o módulo que o exporta.",
            });
          }
          return;
        }

        // Providers owned by an imported module are checked when that module
        // is visited. Their private dependencies must be resolved in that
        // module, not against the consumer's visibility boundary.
        if (resolved.owner !== owner) return;

        const nextStack = [...stack, token];
        for (const dependency of providerDependencies(resolved.provider))
          inspectProviderDependencies(owner, dependency, nextStack);
      };
      for (const provider of module.providers) {
        const token = providerToken(provider);
        if (token !== undefined) inspectProviderDependencies(module, token);
      }
      // Controllers are assigned request scope automatically when their
      // dependency graph requires it; only explicit module providers can
      // accidentally capture a request-scoped value in a singleton.
      for (const provider of module.providers) {
        if (providerScope(provider) !== "singleton") continue;
        for (const dependency of providerDependencies(provider)) {
          if (!requiresRequest(module, dependency)) continue;
          const key = `${module.name}:${String(providerToken(provider))}:${String(dependency)}`;
          if (reportedScopes.has(key)) continue;
          reportedScopes.add(key);
          diagnostics.push({
            code: "E_SCOPE_INVALID",
            severity: "error",
            module: module.name,
            message: `O provider singleton "${String((providerToken(provider) as { description?: string }).description ?? providerToken(provider))}" depende de "${String((dependency as { description?: string }).description ?? dependency)}", que requer request scope.`,
            hint: "Torne o provider request/transient ou remova a dependência request-scoped do singleton.",
          });
        }
      }
      const reportedAsyncControllerDependencies = new Set<string>();
      for (const controller of module.controllers) {
        const dependencies = providerDependencies(controller);
        if (dependencies.length === 0) continue;
        if (!requiresRequest(module, controller)) continue;
        for (const dependency of dependencies) {
          const found = findAsyncRequestFactory(module, dependency);
          if (found === undefined) continue;
          const key = `${module.name}:${controller.name}:${String(found.token)}`;
          if (reportedAsyncControllerDependencies.has(key)) continue;
          reportedAsyncControllerDependencies.add(key);
          diagnostics.push({
            code: "E_ASYNC_REQUEST_FACTORY",
            severity: "error",
            module: module.name,
            subject: { module: module.name, controller: controller.name },
            message: `O controller request-scoped "${controller.name}" depende da factory assíncrona request-scoped "${String((found.token as { description?: string }).description ?? found.token)}", que não pode ser resolvida de forma síncrona por controllers.`,
            hint: "Use uma factory síncrona, torne o provider singleton (se for seguro) ou resolva-o explicitamente com resolveAsync() fora do controller.",
          });
        }
      }
      modules.push(
        Object.freeze({
          name: module.name,
          definition: module,
          imports: Object.freeze(module.imports.map((item) => item.name)),
          controllers: module.controllers,
          providers: Object.freeze(providerTokens),
          exports: Object.freeze(exports),
          queries: module.queries,
          plugins: module.plugins,
        }),
      );
      compiled.add(module);
    };

    visit(root);
    const orderedDiagnostics = [...diagnostics].sort((left, right) =>
      `${left.module ?? ""}:${left.code}:${left.message}`.localeCompare(
        `${right.module ?? ""}:${right.code}:${right.message}`,
      ),
    );
    return Object.freeze({
      root: root.name,
      modules: Object.freeze(modules),
      diagnostics: Object.freeze(orderedDiagnostics),
    });
  }
}
