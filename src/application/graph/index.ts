import {
  Container,
  type ApplicationProvider,
  type Constructor,
  type DependencyToken,
  type ProviderScope,
} from "../../di";
import {
  getDependencies,
  getInjectableScope,
} from "../../di/dependency-metadata";
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
  type ModuleProvider,
} from "../../modules";
import {
  DeclarativePluginRegistry,
  diagnoseDeclarativePlugins,
  isDeclarativePlugin,
  type PluginHealthCheck,
  type PluginPostgresIntegration,
  type PluginRegistryResult,
  type RegisteredPlugin,
} from "../declarative-plugin";
import type { AuthTokenHandler } from "../../runtime";
import { compileNamedSQL } from "../../sql";
import type { GeneratedQuery } from "../../sql/generated-query";
import {
  assertGeneratedQueryBindingTypes,
  assertGeneratedQueryBindings,
  assertRouteSqlBindings,
} from "../bootstrap/sql-binding-validation";

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

function providerToken(provider: ModuleProvider): DependencyToken | undefined {
  if (
    typeof provider === "function" ||
    (typeof provider === "object" &&
      provider !== null &&
      "description" in provider)
  )
    return provider as DependencyToken;
  return (provider as ApplicationProvider).provide;
}

function providerDefinition(
  provider: ModuleProvider,
): ApplicationProvider | undefined {
  if (
    typeof provider === "function" ||
    (typeof provider === "object" &&
      provider !== null &&
      "description" in provider)
  ) {
    return {
      provide: provider as DependencyToken,
      useClass: provider as Constructor,
    };
  }
  return provider as ApplicationProvider;
}

function isProviderDeclaration(
  provider: ModuleProvider,
): provider is ApplicationProvider {
  return (
    typeof provider === "object" && provider !== null && "provide" in provider
  );
}

function providerScope(provider: ModuleProvider): ProviderScope {
  if (!isProviderDeclaration(provider)) {
    return typeof provider === "function"
      ? (getInjectableScope(provider) ?? "singleton")
      : "singleton";
  }
  if ("scope" in provider && provider.scope) return provider.scope;
  if ("useClass" in provider)
    return getInjectableScope(provider.useClass) ?? "singleton";
  return "singleton";
}

function providerDependencies(
  provider: ModuleProvider,
): readonly DependencyToken[] {
  if (!isProviderDeclaration(provider)) {
    return typeof provider === "function" ? getDependencies(provider) : [];
  }
  if ("useClass" in provider) return getDependencies(provider.useClass);
  if ("useFactory" in provider) return provider.inject;
  if ("useExisting" in provider) return [provider.useExisting];
  return [];
}

function exportedTokens(module: ModuleDefinition): DependencyToken[] {
  const tokens: DependencyToken[] = [];
  const visit = (entry: ModuleExportLike): void => {
    if (isModuleDefinition(entry)) {
      for (const nested of entry.exports) visit(nested);
    } else tokens.push(entry);
  };
  for (const entry of module.exports) visit(entry);
  return [...new Set(tokens)];
}

type ModuleExportLike = DependencyToken | ModuleDefinition;

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
      const collectVisibleQueries = (
        current: ModuleDefinition,
        visited = new Set<ModuleDefinition>(),
      ): void => {
        if (visited.has(current)) return;
        visited.add(current);
        for (const query of current.queries)
          visibleQueries.set(query.id, query);
        for (const imported of current.imports)
          collectVisibleQueries(imported, visited);
      };
      collectVisibleQueries(module);
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
            route.querySchema,
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
      const findVisibleProvider = (
        current: ModuleDefinition,
        token: DependencyToken,
        visited = new Set<ModuleDefinition>(),
      ): ModuleProvider | undefined => {
        if (visited.has(current)) return undefined;
        visited.add(current);
        const local = current.providers.find(
          (candidate) => providerToken(candidate) === token,
        );
        if (local !== undefined) return local;
        if (current.controllers.includes(token as ModuleController))
          return token as ModuleController;
        for (const imported of current.imports) {
          if (!exportedTokens(imported).includes(token)) continue;
          const provider = findVisibleProvider(imported, token, visited);
          if (provider !== undefined) return provider;
        }
        return undefined;
      };
      const requiresRequest = (
        current: ModuleDefinition,
        token: DependencyToken,
        stack = new Set<DependencyToken>(),
      ): boolean => {
        if (stack.has(token)) return false;
        const provider = findVisibleProvider(current, token);
        if (provider === undefined) return false;
        const nextStack = new Set(stack).add(token);
        return (
          providerScope(provider) === "request" ||
          providerDependencies(provider).some((dependency) =>
            requiresRequest(current, dependency, nextStack),
          )
        );
      };
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

        const provider = findVisibleProvider(owner, token);
        if (!provider) {
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
        if (
          !owner.providers.some(
            (candidate) => providerToken(candidate) === token,
          )
        )
          return;

        const nextStack = [...stack, token];
        for (const dependency of providerDependencies(provider))
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

export function assertValidApplicationGraph(graph: ApplicationGraph): void {
  const errors = graph.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  );
  if (errors.length === 0) return;
  const summary = errors
    .map((error) => `[${error.code}] ${error.message}`)
    .join("\n");
  throw new AggregateError(
    errors.map((error) => new Error(`[${error.code}] ${error.message}`)),
    `O grafo da aplicação contém ${errors.length} erro(s).\n${summary}`,
  );
}

export type ModuleRuntime = Readonly<{
  readonly name: string;
  readonly container: Container;
  readonly tokens: readonly DependencyToken[];
  readonly resolve: <T>(token: DependencyToken<T>) => T;
  readonly resolveAsync: <T>(token: DependencyToken<T>) => Promise<T>;
}>;

export type LinkedApplication = Readonly<{
  readonly graph: ApplicationGraph;
  readonly modules: ReadonlyMap<string, ModuleRuntime>;
  readonly root: ModuleRuntime;
  readonly integrations: Readonly<{
    readonly postgres: readonly PluginPostgresIntegration[];
    readonly auth: readonly AuthTokenHandler[];
    readonly healthChecks: readonly PluginHealthCheck[];
  }>;
  readonly close: () => Promise<void>;
}>;

export type ApplicationLinkOptions = {
  readonly overrides?: ReadonlyMap<DependencyToken, ApplicationProvider>;
  readonly plugins?: ReadonlyMap<string, PluginRegistryResult>;
};

function moduleExports(
  module: ModuleDefinition,
  byName: ReadonlyMap<string, CompiledModule>,
): DependencyToken[] {
  const tokens: DependencyToken[] = [];
  for (const exported of module.exports) {
    if (isModuleDefinition(exported)) {
      const imported = byName.get(exported.name);
      if (imported) tokens.push(...imported.exports);
    } else tokens.push(exported);
  }
  return [...new Set(tokens)];
}

/** Liga providers em containers isolados, expondo somente exports importados. */
export function linkApplicationGraph(
  graph: ApplicationGraph,
  options: ApplicationLinkOptions = {},
): LinkedApplication {
  if (graph.modules.some((module) => module.plugins.length > 0)) {
    throw new Error(
      "Módulos com plugins declarativos devem ser ligados com linkApplicationGraphAsync().",
    );
  }
  return linkGraph(graph, false, options);
}

/** Liga o grafo aguardando factories assíncronas antes do bootstrap HTTP. */
export async function linkApplicationGraphAsync(
  graph: ApplicationGraph,
  options: ApplicationLinkOptions = {},
): Promise<LinkedApplication> {
  const pluginResults = new Map<string, PluginRegistryResult>();
  let linked: LinkedApplication | undefined;
  try {
    for (const module of graph.modules) {
      if (module.plugins.length === 0) continue;
      const result = await new DeclarativePluginRegistry().activate(
        module.plugins,
      );
      pluginResults.set(module.name, result);
      if (result.diagnostics.length > 0) {
        throw new AggregateError(
          result.diagnostics.map(
            (diagnostic) =>
              new Error(`[${diagnostic.code}] ${diagnostic.message}`),
          ),
          `Falha ao ativar plugins do módulo "${module.name}".`,
        );
      }
    }
    linked = linkGraph(graph, true, {
      ...options,
      plugins: pluginResults,
    });
    for (const runtime of linked.modules.values()) {
      for (const token of runtime.tokens) {
        if (runtime.container.scopeOf(token) === "request") continue;
        await runtime.resolveAsync(token);
      }
    }
    return linked;
  } catch (error) {
    const closeErrors: unknown[] = [];
    if (linked) {
      try {
        await linked.close();
      } catch (closeError) {
        closeErrors.push(closeError);
      }
    } else {
      const pluginValues = [...pluginResults.values()];
      for (let index = pluginValues.length - 1; index >= 0; index--) {
        const result = pluginValues[index];
        try {
          await result.close();
        } catch (closeError) {
          closeErrors.push(closeError);
        }
      }
    }
    if (closeErrors.length > 0) {
      const failure = Object.assign(
        new AggregateError(
          [error, ...closeErrors],
          "Falha ao ligar a aplicação e desfazer ativações parciais.",
        ),
        { cause: closeErrors[0] },
      );
      throw failure;
    }
    throw error;
  }
}

function linkGraph(
  graph: ApplicationGraph,
  asyncFactories: boolean,
  options: ApplicationLinkOptions,
): LinkedApplication {
  assertValidApplicationGraph(graph);
  const byName = new Map(graph.modules.map((module) => [module.name, module]));
  const runtimes = new Map<string, ModuleRuntime>();

  for (const compiled of graph.modules) {
    const container = new Container();
    const ownTokens = new Set<DependencyToken>();
    const pluginProviders =
      options.plugins
        ?.get(compiled.name)
        ?.plugins.flatMap((plugin) => plugin.providers) ?? [];
    for (const provider of [
      ...compiled.definition.providers,
      ...pluginProviders,
    ]) {
      const token = providerToken(provider);
      const definition =
        (token !== undefined && options.overrides?.get(token)) ??
        providerDefinition(provider);
      if (!definition) continue;
      ownTokens.add(definition.provide);
      if ("useExisting" in definition) {
        container.provide(definition.provide, {
          useFactory: (scope) =>
            asyncFactories
              ? scope.resolveAsync(definition.useExisting)
              : scope.resolve(definition.useExisting),
          scope: definition.scope,
        });
      } else if ("useFactory" in definition) {
        container.provide(definition.provide, {
          useFactory: (scope) => {
            if (asyncFactories)
              return Promise.all(
                definition.inject.map((dependency) =>
                  scope.resolveAsync(dependency),
                ),
              ).then((dependencies) =>
                definition.useFactory(...(dependencies as never[])),
              );
            return definition.useFactory(
              ...(definition.inject.map((dependency) =>
                scope.resolve(dependency),
              ) as never[]),
            );
          },
          scope: definition.scope,
          onDispose: definition.onDispose,
        });
      } else if ("useClass" in definition) {
        container.provide(definition.provide, {
          useClass: definition.useClass,
          scope: definition.scope,
          onDispose: definition.onDispose,
        });
      } else {
        container.provide(definition.provide, {
          useValue: definition.useValue,
          onDispose: definition.onDispose,
        });
      }
    }
    for (const controller of compiled.controllers) {
      if (!container.has(controller)) {
        container.provide(controller, {
          useClass: controller,
          scope: container.requiresRequestScope(controller)
            ? "request"
            : "singleton",
        });
      }
    }
    for (const importedName of compiled.imports) {
      const imported = runtimes.get(importedName);
      const importedDefinition = byName.get(importedName);
      if (!imported || !importedDefinition) continue;
      for (const token of moduleExports(
        importedDefinition.definition,
        byName,
      )) {
        if (ownTokens.has(token)) continue;
        container.provide(token, {
          useFactory: () =>
            asyncFactories
              ? imported.resolveAsync(token)
              : imported.resolve(token),
        });
      }
    }
    const runtime: ModuleRuntime = Object.freeze({
      name: compiled.name,
      container,
      tokens: container.tokens(),
      resolve: <T>(token: DependencyToken<T>) => container.resolve(token),
      resolveAsync: <T>(token: DependencyToken<T>) =>
        container.resolveAsync(token),
    });
    runtimes.set(compiled.name, runtime);
  }

  const root = runtimes.get(graph.root);
  if (!root) throw new Error(`Módulo raiz "${graph.root}" não foi compilado.`);
  const pluginResults = options.plugins ? [...options.plugins.values()] : [];
  const registeredPlugins: RegisteredPlugin[] = pluginResults.flatMap(
    (result) => result.plugins,
  );
  let closed = false;
  return Object.freeze({
    graph,
    modules: runtimes,
    root,
    integrations: Object.freeze({
      postgres: Object.freeze(
        registeredPlugins.flatMap((plugin) =>
          plugin.postgres ? [plugin.postgres] : [],
        ),
      ),
      auth: Object.freeze(
        registeredPlugins.flatMap((plugin) =>
          plugin.auth ? [plugin.auth] : [],
        ),
      ),
      healthChecks: Object.freeze(
        registeredPlugins.flatMap((plugin) => plugin.healthChecks),
      ),
    }),
    close: async () => {
      if (closed) return;
      closed = true;
      const errors: unknown[] = [];
      const values = [...runtimes.values()];
      for (let index = values.length - 1; index >= 0; index--) {
        try {
          await values[index]?.container.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      const pluginValues = [...(options.plugins?.values() ?? [])];
      for (let index = pluginValues.length - 1; index >= 0; index--) {
        try {
          await pluginValues[index]?.close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0)
        throw new AggregateError(
          errors,
          "Falha ao encerrar o grafo da aplicação.",
        );
    },
  });
}
