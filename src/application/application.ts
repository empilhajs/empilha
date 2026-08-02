import {
  activateApplicationRuntime,
  ApplicationRuntime,
  type EmpilhaRuntimeConfig,
} from "../core/empilha";
import {
  ApplicationGraphBuilder,
  assertValidApplicationGraph,
  linkApplicationGraphAsync,
  type ApplicationGraph,
  type LinkedApplication,
} from "./graph";
import type { ApplicationProvider, DependencyToken } from "../di";
import type { ModuleDefinition } from "../modules";
import { defineModule } from "../modules";
import {
  defineDeclarativePlugin,
  isDeclarativePlugin,
} from "./declarative-plugin";
import { getControllerPath, getControllerRoutes } from "../core/metadata";
import { joinPaths } from "../router";
import { verifyGeneratedQueryManifest } from "../diagnostics";
import {
  type GeneratedQuery,
  type GeneratedQueryManifest,
  type PostgresQueryRunner,
} from "../sql";
import type { NativeRouteEligibility } from "../http";

export type EmpilhaApplication = ApplicationRuntime & {
  readonly graph: ApplicationGraph;
  readonly modules: ReadonlyMap<string, ApplicationModuleInspection>;
  readonly inspect: () => ApplicationInspection;
  readonly queryManifest?: GeneratedQueryManifest;
};

export type ApplicationModuleInspection = Readonly<{
  readonly name: string;
  readonly tokens: readonly DependencyToken[];
}>;

export type ApplicationInspection = Readonly<{
  readonly modules: ApplicationGraph["modules"];
  readonly providers: readonly {
    module: string;
    tokens: readonly DependencyToken[];
  }[];
  readonly queries: readonly { module: string; count: number }[];
  readonly routes: readonly {
    module: string;
    controller: string;
    method: string;
    path: string;
    query?: string;
  }[];
  readonly diagnostics: ApplicationGraph["diagnostics"];
  readonly nativeRoutes: readonly NativeRouteEligibility[];
  readonly queryManifest?: GeneratedQueryManifest;
}>;

export type CreateApplicationOptions = {
  readonly configure?: (app: ApplicationRuntime) => void;
  readonly runtime?: EmpilhaRuntimeConfig;
  readonly queryManifest?: GeneratedQueryManifest;
  readonly verifyQueryManifest?: boolean;
};

export type TestApplicationOptions = CreateApplicationOptions & {
  readonly postgres?: PostgresQueryRunner;
};

export type TestApplicationBuilder = {
  overrideProvider<T>(token: DependencyToken<T>): ProviderOverride<T>;
  overridePlugin(plugin: unknown | string): PluginOverride;
  compile(): Promise<EmpilhaApplication>;
};

export type ProviderOverride<T> = {
  useValue(value: T): TestApplicationBuilder;
  useFactory(
    factory: (...dependencies: never[]) => T | Promise<T>,
    inject?: readonly DependencyToken[],
  ): TestApplicationBuilder;
};

export type PluginOverride = {
  use(plugin: unknown): TestApplicationBuilder;
  remove(): TestApplicationBuilder;
};

type PluginReplacement = {
  readonly target: unknown | string;
  readonly replacement: unknown | null;
};

function pluginMatches(plugin: unknown, target: unknown | string): boolean {
  if (plugin === target) return true;
  return (
    typeof target === "string" &&
    isDeclarativePlugin(plugin) &&
    plugin.descriptor.name === target
  );
}

function applyPluginOverrides(
  root: ModuleDefinition,
  replacements: readonly PluginReplacement[],
): ModuleDefinition {
  const cache = new Map<ModuleDefinition, ModuleDefinition>();
  const visiting = new Set<ModuleDefinition>();
  const clone = (module: ModuleDefinition): ModuleDefinition => {
    const existing = cache.get(module);
    if (existing) return existing;
    if (visiting.has(module)) return module;
    visiting.add(module);
    const next = defineModule({
      name: module.name,
      imports: module.imports.map(clone),
      controllers: module.controllers,
      providers: module.providers,
      queries: module.queries,
      plugins: module.plugins.flatMap((plugin) => {
        const override = replacements.find(({ target }) =>
          pluginMatches(plugin, target),
        );
        if (!override) return [plugin];
        return override.replacement === null ? [] : [override.replacement];
      }),
      exports: module.exports,
    });
    visiting.delete(module);
    cache.set(module, next);
    return next;
  };
  return clone(root);
}

function addTestPostgresIntegration(
  root: ModuleDefinition,
  runner: PostgresQueryRunner | undefined,
): ModuleDefinition {
  if (!runner) return root;
  const plugin = defineDeclarativePlugin({
    name: `${root.name}/test-postgres`,
    version: "1.0.0",
    provides: ["postgres/query-runner"],
    register(context) {
      context.postgres(runner, { healthCheck: false });
    },
  });
  return defineModule({
    name: root.name,
    imports: root.imports,
    controllers: root.controllers,
    providers: root.providers,
    exports: root.exports,
    queries: root.queries,
    plugins: [...root.plugins, plugin],
  });
}

function createReadonlyMap<K, V>(
  entries: readonly (readonly [K, V])[],
): ReadonlyMap<K, V> {
  const map = new Map(entries);
  let publicMap: ReadonlyMap<K, V>;
  publicMap = Object.freeze({
    get: (key: K) => map.get(key),
    has: (key: K) => map.has(key),
    get size() {
      return map.size;
    },
    entries: () => map.entries(),
    keys: () => map.keys(),
    values: () => map.values(),
    forEach: (callback: (value: V, key: K, owner: ReadonlyMap<K, V>) => void) =>
      map.forEach((value, key) => callback(value, key, publicMap)),
    [Symbol.iterator]: () => map[Symbol.iterator](),
  }) as ReadonlyMap<K, V>;
  return publicMap;
}

function attachApplicationMetadata(
  app: EmpilhaApplication,
  graph: ApplicationGraph,
  linked: LinkedApplication,
  queryManifest?: GeneratedQueryManifest,
): EmpilhaApplication {
  const publicModules = createReadonlyMap(
    [...linked.modules.values()].map(
      (module) =>
        [
          module.name,
          Object.freeze({
            name: module.name,
            tokens: Object.freeze([...module.tokens]),
          }),
        ] as const,
    ),
  );
  const inspectionBase = {
    modules: graph.modules,
    providers: Object.freeze(
      [...linked.modules.values()].map((module) => ({
        module: module.name,
        tokens: module.tokens,
      })),
    ),
    queries: Object.freeze(
      graph.modules.map((module) => ({
        module: module.name,
        count: module.queries.length,
      })),
    ),
    routes: Object.freeze(
      graph.modules.flatMap((module) =>
        module.controllers.flatMap((controller) => {
          const prefix = getControllerPath(controller) ?? "";
          return getControllerRoutes(controller).map((route) =>
            Object.freeze({
              module: module.name,
              controller: controller.name || "Controller",
              method: route.method,
              path: joinPaths(prefix, route.path),
              ...(route.queryName ? { query: route.queryName } : {}),
            }),
          );
        }),
      ),
    ),
    diagnostics: graph.diagnostics,
    queryManifest,
  };
  const inspect = (): ApplicationInspection =>
    Object.freeze({
      ...inspectionBase,
      nativeRoutes: app.getNativeRouteEligibility(),
    });
  Object.defineProperties(app, {
    graph: { value: graph, enumerable: true },
    modules: { value: publicModules, enumerable: true },
    inspect: { value: inspect, enumerable: true },
    queryManifest: { value: queryManifest, enumerable: true },
  });
  app.onClose(linked.close);
  return app;
}

function assertQueryManifest(
  manifest: GeneratedQueryManifest | undefined,
  verify: boolean | undefined,
): void {
  if (!manifest || !verify) return;
  const diagnostics = verifyGeneratedQueryManifest(manifest);
  if (diagnostics.length === 0) return;
  throw new AggregateError(
    diagnostics.map(
      (diagnostic) => new Error(`[${diagnostic.code}] ${diagnostic.message}`),
    ),
    "O manifest de queries está desatualizado.",
  );
}

function registerModuleQueries(
  app: EmpilhaApplication,
  graph: ApplicationGraph,
): void {
  const queries = new Map<string, GeneratedQuery>();
  for (const module of graph.modules) {
    for (const query of module.queries) queries.set(query.id, query);
  }
  for (const query of queries.values()) app.registerGeneratedQuery(query);
}

async function rollbackFailedBootstrap(
  app: EmpilhaApplication,
  bootstrapError: unknown,
): Promise<never> {
  try {
    await app.close();
  } catch (closeError) {
    throw Object.assign(
      new AggregateError(
        [bootstrapError, closeError],
        "Falha no bootstrap e ao desfazer recursos ativados.",
      ),
      { cause: closeError },
    );
  }
  throw bootstrapError;
}

/**
 * Compila um módulo e inicializa sua aplicação HTTP sem abrir uma porta.
 *
 * O container do módulo raiz é entregue ao dispatcher existente; assim,
 * providers declarados no grafo e controllers percorrem o mesmo ciclo de vida
 * da aplicação que será usado por `listen()` e `fetch()`.
 */
export async function createApplication(
  root: ModuleDefinition,
  options: CreateApplicationOptions = {},
): Promise<EmpilhaApplication> {
  assertQueryManifest(options.queryManifest, options.verifyQueryManifest);
  const graph = new ApplicationGraphBuilder().build(root);
  assertValidApplicationGraph(graph);
  const linked: LinkedApplication = await linkApplicationGraphAsync(graph);
  const app = new ApplicationRuntime(
    linked.root.container,
  ) as EmpilhaApplication;
  attachApplicationMetadata(app, graph, linked, options.queryManifest);
  try {
    registerModuleQueries(app, graph);
    for (const integration of linked.integrations.postgres)
      app.postgres(integration.runner, integration.options);
    for (const handler of linked.integrations.auth) app.auth(handler);
    for (const healthCheck of linked.integrations.healthChecks)
      app.healthCheck(healthCheck.name, healthCheck.check);
    options.configure?.(app);
    if (options.runtime) app.configure(options.runtime);

    const controllers = graph.modules.flatMap((module) => module.controllers);
    const uniqueControllers = [...new Set(controllers)];
    activateApplicationRuntime(app, uniqueControllers);
    return app;
  } catch (error) {
    return rollbackFailedBootstrap(app, error);
  }
}

/** Cria um builder que compila o mesmo módulo de produção com overrides. */
export function createTestApplication(
  root: ModuleDefinition,
  options: TestApplicationOptions = {},
): TestApplicationBuilder {
  const overrides = new Map<DependencyToken, ApplicationProvider>();
  const pluginReplacements: PluginReplacement[] = [];
  let compiled = false;
  const assertBuilderOpen = (): void => {
    if (compiled) throw new Error("A testing application já foi compilada.");
  };
  const builder: TestApplicationBuilder = {
    overrideProvider<T>(token: DependencyToken<T>): ProviderOverride<T> {
      assertBuilderOpen();
      return {
        useValue(value: T): TestApplicationBuilder {
          assertBuilderOpen();
          overrides.set(token, { provide: token, useValue: value });
          return builder;
        },
        useFactory(
          factory: (...dependencies: never[]) => T | Promise<T>,
          inject: readonly DependencyToken[] = [],
        ): TestApplicationBuilder {
          assertBuilderOpen();
          overrides.set(token, {
            provide: token,
            useFactory: factory,
            inject,
          });
          return builder;
        },
      };
    },
    overridePlugin(plugin: unknown | string): PluginOverride {
      assertBuilderOpen();
      return {
        use(replacement: unknown): TestApplicationBuilder {
          assertBuilderOpen();
          pluginReplacements.push({ target: plugin, replacement });
          return builder;
        },
        remove(): TestApplicationBuilder {
          assertBuilderOpen();
          pluginReplacements.push({ target: plugin, replacement: null });
          return builder;
        },
      };
    },
    async compile(): Promise<EmpilhaApplication> {
      assertBuilderOpen();
      compiled = true;
      const testRoot = addTestPostgresIntegration(
        applyPluginOverrides(root, pluginReplacements),
        options.postgres,
      );
      assertQueryManifest(options.queryManifest, options.verifyQueryManifest);
      const graph = new ApplicationGraphBuilder().build(testRoot, {
        allowRuntimeQueries: true,
      });
      assertValidApplicationGraph(graph);
      const linked = await linkApplicationGraphAsync(graph, { overrides });
      const app = new ApplicationRuntime(
        linked.root.container,
      ) as EmpilhaApplication;
      attachApplicationMetadata(app, graph, linked, options.queryManifest);
      try {
        registerModuleQueries(app, graph);
        for (const integration of linked.integrations.postgres)
          app.postgres(integration.runner, integration.options);
        for (const handler of linked.integrations.auth) app.auth(handler);
        for (const healthCheck of linked.integrations.healthChecks)
          app.healthCheck(healthCheck.name, healthCheck.check);
        options.configure?.(app);
        if (options.runtime) app.configure(options.runtime);
        const controllers = [
          ...new Set(graph.modules.flatMap((module) => module.controllers)),
        ];
        activateApplicationRuntime(app, controllers);
        return app;
      } catch (error) {
        return rollbackFailedBootstrap(app, error);
      }
    },
  };
  return builder;
}
