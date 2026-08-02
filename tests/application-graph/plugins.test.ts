import { describe, expect, test } from "bun:test";
import {
  DeclarativePluginRegistry,
  defineDeclarativePlugin,
} from "../../src/application/declarative-plugin";
import {
  ApplicationGraphBuilder,
  linkApplicationGraphAsync,
} from "../../src/application/graph";
import { createToken } from "../../src/di";
import { defineModule } from "../../src/modules";

describe("declarative plugins", () => {
  test("inclui falhas de descritor no grafo sem ativar plugins", () => {
    let registrations = 0;
    const provider = defineDeclarativePlugin({
      name: "cache-v2",
      version: "2.0.0",
      provides: [{ name: "cache", version: "2.0.0" }],
      register() {
        registrations++;
      },
    });
    const consumer = defineDeclarativePlugin({
      name: "cache-consumer",
      version: "1.0.0",
      requires: [{ name: "cache", version: "^1.0.0" }, "mailer"],
      register() {
        registrations++;
      },
    });
    const graph = new ApplicationGraphBuilder().build(
      defineModule({ name: "diagnose-plugins", plugins: [provider, consumer] }),
    );

    expect(graph.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "E_PLUGIN_CAPABILITY_INCOMPATIBLE",
      "E_PLUGIN_CAPABILITY_MISSING",
    ]);
    expect(registrations).toBe(0);
  });

  test("torna a mesma instância idempotente", async () => {
    let registrations = 0;
    const plugin = defineDeclarativePlugin({
      name: "idempotent",
      version: "1.0.0",
      register() {
        registrations++;
      },
    });

    const result = await new DeclarativePluginRegistry().activate([
      plugin,
      plugin,
    ]);

    expect(result.diagnostics).toEqual([]);
    expect(registrations).toBe(1);
    expect(result.plugins).toHaveLength(1);
    await result.close();
  });

  test("ordena capabilities, normaliza config e fecha em ordem inversa", async () => {
    const events: string[] = [];
    const token = createToken<string>("plugin/value");
    const database = defineDeclarativePlugin({
      name: "database",
      version: "2.0.0",
      provides: ["database/client"],
      register(context) {
        context.provider({ provide: token, useValue: "ready" });
        context.onClose(() => {
          events.push("database");
        });
      },
    });
    const feature = defineDeclarativePlugin({
      name: "feature",
      version: "1.0.0",
      requires: ["database/client"],
      config: (value) => ({ enabled: Boolean(value) }),
      register(context, config) {
        expect(config).toEqual({ enabled: true });
        context.onClose(() => {
          events.push("feature");
        });
      },
    });

    const result = await new DeclarativePluginRegistry().activate(
      [feature, database],
      new Map([["feature", true]]),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.plugins.map((plugin) => plugin.name)).toEqual([
      "database",
      "feature",
    ]);
    expect(result.plugins[0]?.providers).toHaveLength(1);
    await result.close();
    await result.close();
    expect(events).toEqual(["feature", "database"]);
  });

  test("diagnostica capability ausente e plugin duplicado", async () => {
    const plugin = defineDeclarativePlugin({
      name: "needs-cache",
      version: "1.0.0",
      requires: ["cache"],
      register() {},
    });
    const result = await new DeclarativePluginRegistry().activate([
      plugin,
      plugin,
    ]);

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "E_PLUGIN_CAPABILITY_MISSING",
      "E_PLUGIN_CAPABILITY_UNAVAILABLE",
    ]);
    expect(result.diagnostics[0]?.hint).toContain("Nenhum plugin instalado");
  });

  test("identifica capability incompatível e o contrato encontrado", async () => {
    const database = defineDeclarativePlugin({
      name: "database-v2",
      version: "2.0.0",
      provides: [{ name: "database/client", version: "2.0.0" }],
      register() {},
    });
    const feature = defineDeclarativePlugin({
      name: "feature-v1",
      version: "1.0.0",
      requires: [{ name: "database/client", version: "^1.0.0" }],
      register() {},
    });

    const result = await new DeclarativePluginRegistry().activate([
      feature,
      database,
    ]);

    const diagnostic = result.diagnostics.find(
      (entry) => entry.code === "E_PLUGIN_CAPABILITY_INCOMPATIBLE",
    );
    expect(diagnostic?.plugin).toBe("feature-v1");
    expect(diagnostic?.message).toContain("database/client@^1.0.0");
    expect(diagnostic?.hint).toContain("database-v2");
    await result.close();
  });

  test("desfaz ativação parcial quando register falha", async () => {
    const closed: string[] = [];
    const first = defineDeclarativePlugin({
      name: "first",
      version: "1.0.0",
      register(context) {
        context.onClose(() => {
          closed.push("first");
        });
      },
    });
    const second = defineDeclarativePlugin({
      name: "second",
      version: "1.0.0",
      register(context) {
        context.onClose(() => {
          closed.push("second");
        });
        throw new Error("register failed");
      },
    });

    await expect(
      new DeclarativePluginRegistry().activate([first, second]),
    ).rejects.toThrow("register failed");
    expect(closed).toEqual(["second", "first"]);
  });

  test("diagnostica nomes duplicados de health checks", async () => {
    const first = defineDeclarativePlugin({
      name: "first-health",
      version: "1.0.0",
      register(context) {
        context.healthCheck("database", () => true);
      },
    });
    const second = defineDeclarativePlugin({
      name: "second-health",
      version: "1.0.0",
      register(context) {
        context.healthCheck("database", () => true);
      },
    });

    const result = await new DeclarativePluginRegistry().activate([
      first,
      second,
    ]);

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "E_PLUGIN_HEALTH_CHECK_DUPLICATE",
    ]);
    await result.close();
  });

  test("desfaz plugins quando a resolução eager do linker falha", async () => {
    const closed: string[] = [];
    const broken = createToken<string>("broken/value");
    const plugin = defineDeclarativePlugin({
      name: "broken-provider",
      version: "1.0.0",
      register(context) {
        context.provider({
          provide: broken,
          useFactory: () => {
            throw new Error("factory failed");
          },
          inject: [],
        });
        context.onClose(() => {
          closed.push("broken-provider");
        });
      },
    });
    const graph = new ApplicationGraphBuilder().build(
      defineModule({ name: "app", plugins: [plugin] }),
    );

    await expect(linkApplicationGraphAsync(graph)).rejects.toThrow(
      "factory failed",
    );
    expect(closed).toEqual(["broken-provider"]);
  });

  test("descarta providers já ativados quando a resolução eager posterior falha", async () => {
    const disposed: string[] = [];
    const ready = createToken<string>("ready/value");
    const broken = createToken<string>("broken/value");
    const graph = new ApplicationGraphBuilder().build(
      defineModule({
        name: "rollback-providers",
        providers: [
          {
            provide: ready,
            useValue: "ready",
            onDispose: () => {
              disposed.push("ready");
            },
          },
          {
            provide: broken,
            useFactory: () => {
              throw new Error("factory failed after activation");
            },
            inject: [],
          },
        ],
      }),
    );

    await expect(linkApplicationGraphAsync(graph)).rejects.toThrow(
      "factory failed after activation",
    );
    expect(disposed).toEqual(["ready"]);
  });

  test("continua fechando módulos e plugins depois de uma falha de disposal", async () => {
    const closed: string[] = [];
    const importedResource = createToken<string>("imported/resource");
    const rootResource = createToken<string>("root/resource");
    const plugin = defineDeclarativePlugin({
      name: "close-observer",
      version: "1.0.0",
      register(context) {
        context.onClose(() => {
          closed.push("plugin");
        });
      },
    });
    const imported = defineModule({
      name: "imported-close",
      providers: [
        {
          provide: importedResource,
          useValue: "imported",
          onDispose: () => {
            closed.push("imported");
          },
        },
      ],
    });
    const graph = new ApplicationGraphBuilder().build(
      defineModule({
        name: "root-close",
        imports: [imported],
        plugins: [plugin],
        providers: [
          {
            provide: rootResource,
            useValue: "root",
            onDispose: () => {
              closed.push("root");
              throw new Error("root disposal failed");
            },
          },
        ],
      }),
    );
    const linked = await linkApplicationGraphAsync(graph);

    await expect(linked.close()).rejects.toThrow(
      "Falha ao encerrar o grafo da aplicação",
    );
    expect(closed).toEqual(["root", "imported", "plugin"]);
    await linked.close();
  });
});
