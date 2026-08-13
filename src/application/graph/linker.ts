import {
  Container,
  type ApplicationProvider,
  type DependencyToken,
} from "../../di";
import {
  DeclarativePluginRegistry,
  type PluginHealthCheck,
  type PluginPostgresIntegration,
  type PluginRegistryResult,
  type RegisteredPlugin,
} from "../declarative-plugin";
import type { AuthTokenHandler } from "../../runtime";
import type { ApplicationGraph, GraphDiagnostic } from "./index";
import {
  moduleExports,
  providerDefinition,
  providerToken,
} from "./provider-utils";

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

export function assertValidApplicationGraph(graph: ApplicationGraph): void {
  const errors = graph.diagnostics.filter(
    (diagnostic: GraphDiagnostic) => diagnostic.severity === "error",
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
    linked = linkGraph(graph, true, { ...options, plugins: pluginResults });
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
      const values = [...pluginResults.values()];
      for (let index = values.length - 1; index >= 0; index--) {
        try {
          await values[index]?.close();
        } catch (closeError) {
          closeErrors.push(closeError);
        }
      }
    }
    if (closeErrors.length > 0) {
      throw Object.assign(
        new AggregateError(
          [error, ...closeErrors],
          "Falha ao ligar a aplicação e desfazer ativações parciais.",
        ),
        { cause: closeErrors[0] },
      );
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
          async: asyncFactories,
          multi: "multi" in definition ? definition.multi : undefined,
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
          async: asyncFactories,
          multi: "multi" in definition ? definition.multi : undefined,
          onDispose: definition.onDispose,
        });
      } else if ("useClass" in definition) {
        container.provide(definition.provide, {
          useClass: definition.useClass,
          scope: definition.scope,
          multi: "multi" in definition ? definition.multi : undefined,
          onDispose: definition.onDispose,
        });
      } else {
        container.provide(definition.provide, {
          useValue: definition.useValue,
          multi: "multi" in definition ? definition.multi : undefined,
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
      const requestScopes = new WeakMap<Container, Container>();
      for (const token of moduleExports(
        importedDefinition.definition,
        byName,
      )) {
        if (ownTokens.has(token)) continue;
        const importedScope = imported.container.scopeOf(token) ?? "singleton";
        container.provide(token, {
          useFactory: (scope) => {
            if (importedScope !== "request") {
              return asyncFactories
                ? imported.resolveAsync(token)
                : imported.resolve(token);
            }
            let sourceScope = requestScopes.get(scope);
            if (!sourceScope) {
              sourceScope = imported.container.createScope();
              requestScopes.set(scope, sourceScope);
              const requestScope = sourceScope;
              scope.addDisposeHook(async () => {
                await requestScope.dispose();
              });
            }
            return asyncFactories
              ? sourceScope.resolveAsync(token)
              : sourceScope.resolve(token);
          },
          scope: importedScope,
          async: asyncFactories,
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
  const registeredPlugins: RegisteredPlugin[] = options.plugins
    ? [...options.plugins.values()].flatMap((result) => result.plugins)
    : [];
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
