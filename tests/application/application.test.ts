import { describe, expect, test } from "bun:test";
import {
  createApplication,
  createTestApplication,
} from "../../src/application/application";
import {
  Controller,
  Get,
  Inject,
  Param,
  Result,
  Sql,
} from "../../src/decorators";
import { createToken } from "../../src/di";
import { CLOCK, REQUEST_ID_GENERATOR } from "../../src/di";
import { defineModule } from "../../src/modules";
import { testPostgres } from "../../src/application/testing/test-postgres";
import { defineDeclarativePlugin } from "../../src/application/declarative-plugin";
import type { EmpilhaApplication } from "../../src/application/application";
import {
  createGeneratedQueryManifest,
  defineGeneratedQuery,
} from "../../src/sql/generated-query";

@Controller("/hello")
class HelloController {
  @Get("/")
  hello() {
    return { status: 200, body: "hello 0.2" };
  }
}

@Controller("/eligibility")
class EligibilityController {
  @Get("/static")
  staticRoute() {
    return { status: 200, body: "static" };
  }

  @Get("/param/:id")
  parameterized(@Param("id") id: string) {
    return { status: 200, body: id };
  }
}

describe("createApplication", () => {
  test("publica request.completed e isola listeners com falha", async () => {
    const app = await createApplication(
      defineModule({ name: "events", controllers: [HelloController] }),
    );
    const completed: unknown[] = [];
    app.events.on("request.completed", (event) => {
      completed.push(event);
    });
    app.events.on("request.completed", () => {
      throw new Error("observer failure");
    });

    const response = await app.fetch(
      new Request("http://test/hello", { method: "GET" }),
    );
    const event = completed[0] as {
      status: number;
      requestId: string;
      durationMs: number;
    };
    expect(response.status).toBe(200);
    expect(event.status).toBe(200);
    expect(event.requestId).toBeString();
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
    expect(Object.isFrozen(event)).toBe(true);
    await app.close();
  });

  test("publica pathname concreto e template da rota", async () => {
    const app = await createApplication(
      defineModule({
        name: "route-events",
        controllers: [EligibilityController],
      }),
    );
    const events: Array<{ pathname: string; route: string }> = [];
    app.events.on("request.completed", (event) => {
      events.push({ pathname: event.pathname, route: event.route });
    });

    expect(
      (await app.fetch(new Request("http://test/eligibility/param/42"))).status,
    ).toBe(200);
    expect(events[0]).toEqual({
      pathname: "/eligibility/param/42",
      route: "/eligibility/param/:id",
    });
    await app.close();
  });

  test("usa pathname como fallback de rota em 404 e 405", async () => {
    const app = await createApplication(
      defineModule({
        name: "route-event-fallbacks",
        controllers: [EligibilityController],
      }),
    );
    const events: Array<{
      pathname: string;
      route: string;
      status: number;
    }> = [];
    app.events.on("request.completed", (event) => {
      events.push({
        pathname: event.pathname,
        route: event.route,
        status: event.status,
      });
    });

    expect((await app.fetch(new Request("http://test/missing"))).status).toBe(
      404,
    );
    expect(
      (
        await app.fetch(
          new Request("http://test/eligibility/param/42", { method: "POST" }),
        )
      ).status,
    ).toBe(405);
    expect(events).toEqual([
      { pathname: "/missing", route: "/missing", status: 404 },
      {
        pathname: "/eligibility/param/42",
        route: "/eligibility/param/42",
        status: 405,
      },
    ]);
    await app.close();
  });

  test("compila o módulo e usa app.fetch sem abrir socket", async () => {
    const app = await createApplication(
      defineModule({ name: "app", controllers: [HelloController] }),
      { runtime: { http: { cors: false } } },
    );

    const response = await app.fetch(
      new Request("http://test/hello", { method: "GET" }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"status":200,"body":"hello 0.2"}');
    expect(app.graph.root).toBe("app");
    await app.close();
  });

  test("registra a elegibilidade de native routes durante o compile", async () => {
    const app = await createApplication(
      defineModule({
        name: "native-inspection",
        controllers: [EligibilityController],
      }),
      { runtime: { http: { cors: false, handlerTimeout: null } } },
    );

    expect(app.inspect().nativeRoutes).toEqual([
      {
        method: "GET",
        path: "/eligibility/static",
        eligible: false,
        reasons: ["handler-arguments"],
      },
      {
        method: "GET",
        path: "/eligibility/param/:id",
        eligible: false,
        reasons: ["handler-arguments", "request"],
      },
    ]);
    expect(Object.isFrozen(app.inspect().nativeRoutes)).toBe(true);
    await app.close();
  });

  test("mantém app.test e app.fetch no mesmo contrato HTTP", async () => {
    const app = await createTestApplication(
      defineModule({ name: "equivalent", controllers: [HelloController] }),
    ).compile();

    const direct = await app.fetch(
      new Request("http://test/hello", { method: "GET" }),
    );
    const client = await app.test().get("/hello");

    expect(client.status).toBe(direct.status);
    expect(await client.text()).toBe(await direct.clone().text());
    await app.close();
  });

  test("não publica rotas parcialmente quando o bootstrap falha", async () => {
    const disposed: string[] = [];
    const resource = createToken<string>("partial/resource");
    @Controller("/partial/valid")
    class ValidController {
      @Get("/")
      get() {
        return { ok: true };
      }
    }

    @Controller("/partial/invalid")
    class InvalidController {
      @Get("/")
      get(@Param("id") id: string) {
        return id;
      }
    }

    let app: Pick<EmpilhaApplication, "fetch" | "close"> | undefined;
    await expect(
      createApplication(
        defineModule({
          name: "partial-bootstrap",
          controllers: [ValidController, InvalidController],
          providers: [
            {
              provide: resource,
              useValue: "active",
              onDispose: () => {
                disposed.push("resource");
              },
            },
          ],
        }),
        { configure: (configured) => (app = configured) },
      ),
    ).rejects.toThrow('@Param("id")');

    expect(app).toBeDefined();
    if (!app) throw new Error("A aplicação deveria ter sido configurada.");
    expect(
      (await app.fetch(new Request("http://test/partial/valid"))).status,
    ).toBe(404);
    expect(disposed).toEqual(["resource"]);
    await app.close();
  });

  test("fecha recursos com await using", async () => {
    const disposed: string[] = [];
    const resource = createToken<string>("test/resource");
    const module = defineModule({
      name: "disposable-test",
      providers: [
        {
          provide: resource,
          useValue: "resource",
          onDispose: () => {
            disposed.push("resource");
          },
        },
      ],
    });

    try {
      await using app = await createTestApplication(module).compile();
      expect(app.get(resource)).toBe("resource");
      throw new Error("simulated test failure");
    } catch (error) {
      expect(error).toEqual(new Error("simulated test failure"));
    }

    expect(disposed).toEqual(["resource"]);
  });

  test("ativa factory assíncrona e permite override no testing application", async () => {
    const greeting = createToken<string>("test/greeting");

    @Controller("/greeting")
    class GreetingController {
      constructor(@Inject(greeting) private readonly value: string) {}

      @Get("/")
      get() {
        return this.value;
      }
    }

    const module = defineModule({
      name: "greeting",
      controllers: [GreetingController],
      providers: [
        {
          provide: greeting,
          useFactory: async () => "production",
          inject: [],
        },
      ],
      exports: [greeting],
    });
    const production = await createApplication(module);
    expect(production.get(greeting)).toBe("production");
    await production.close();
    const app = await createTestApplication(module)
      .overrideProvider(greeting)
      .useValue("test")
      .compile();

    expect(app.get(greeting)).toBe("test");
    expect((await app.fetch(new Request("http://test/greeting"))).status).toBe(
      200,
    );
    expect(app.inspect().modules[0]?.name).toBe("greeting");
    await app.close();
  });

  test("conecta o fake PostgreSQL ao executor da testing application", async () => {
    const database = testPostgres([{ id: 1 }]);

    @Controller("/tasks")
    class TaskController {
      @Get("/")
      @Sql("tasks")
      @Result("many")
      list() {}
    }

    const app = await createTestApplication(
      defineModule({ name: "tasks", controllers: [TaskController] }),
      {
        postgres: database,
        configure: (configured) =>
          configured.registerQuery("tasks", "SELECT id FROM tasks"),
      },
    ).compile();
    const queries: unknown[] = [];
    app.events.on("query.completed", (event) => {
      queries.push(event);
    });

    const response = await app.fetch(
      new Request("http://test/tasks", { method: "GET" }),
    );
    expect(response.status).toBe(200);
    expect(database.queries).toEqual(["SELECT id FROM tasks"]);
    expect(await response.json()).toEqual([{ id: 1 }]);
    expect(queries[0]).toMatchObject({
      query: "tasks",
      rowCount: 1,
      transaction: false,
    });
    expect(Object.isFrozen(queries[0])).toBe(true);
    await app.close();
  });

  test("isola queries, containers e hooks entre testing applications", async () => {
    @Controller("/isolated-query")
    class IsolatedQueryController {
      @Get("/")
      @Sql("isolated")
      @Result("many")
      list() {}
    }

    const module = defineModule({
      name: "isolated-query",
      controllers: [IsolatedQueryController],
    });
    const firstDatabase = testPostgres([{ app: "first" }]);
    const secondDatabase = testPostgres([{ app: "second" }]);
    const create = (database: ReturnType<typeof testPostgres>) =>
      createTestApplication(module, {
        postgres: database,
        configure: (configured) =>
          configured.registerQuery("isolated", "SELECT $1"),
      }).compile();

    const first = await create(firstDatabase);
    const second = await create(secondDatabase);
    await first.fetch(new Request("http://test/isolated-query"));
    expect(firstDatabase.queries).toEqual(["SELECT $1"]);
    expect(secondDatabase.queries).toEqual([]);
    await second.fetch(new Request("http://test/isolated-query"));
    expect(secondDatabase.queries).toEqual(["SELECT $1"]);
    await first.close();
    await second.close();
  });

  test("substitui e remove plugins na testing application", async () => {
    const value = createToken<string>("plugin/override-value");
    const production = defineDeclarativePlugin({
      name: "replaceable",
      version: "1.0.0",
      register(context) {
        context.provider({ provide: value, useValue: "production" });
      },
    });
    const replacement = defineDeclarativePlugin({
      name: "replacement",
      version: "1.0.0",
      register(context) {
        context.provider({ provide: value, useValue: "test" });
      },
    });
    const module = defineModule({
      name: "plugin-override",
      plugins: [production],
    });

    const builder = createTestApplication(module)
      .overridePlugin(production)
      .use(replacement);
    const app = await builder.compile();
    expect(app.get(value)).toBe("test");
    expect(app.graph.modules[0]?.plugins).toEqual([replacement]);
    expect(() => builder.overridePlugin(production)).toThrow(
      "já foi compilada",
    );
    await app.close();

    const removed = await createTestApplication(module)
      .overridePlugin("replaceable")
      .remove()
      .compile();
    expect(removed.graph.modules[0]?.plugins).toEqual([]);
    await removed.close();
  });

  test("permite substituir relógio e gerador de request ID", async () => {
    const module = defineModule({
      name: "test-clocks",
      controllers: [HelloController],
      providers: [
        { provide: CLOCK, useValue: { now: () => 10 } },
        { provide: REQUEST_ID_GENERATOR, useValue: () => "test-request-id" },
      ],
    });
    const app = await createTestApplication(module)
      .overrideProvider(CLOCK)
      .useValue({ now: () => 42 })
      .overrideProvider(REQUEST_ID_GENERATOR)
      .useValue(() => "fixed-request-id")
      .compile();
    const events: unknown[] = [];
    app.events.on("request.completed", (event) => {
      events.push(event);
    });

    const response = await app.fetch(
      new Request("http://test/hello", { method: "GET" }),
    );

    expect(response.headers.get("x-request-id")).toBe("fixed-request-id");
    expect(events[0]).toMatchObject({
      requestId: "fixed-request-id",
      durationMs: 0,
    });
    await app.close();
  });

  test("ativa plugin declarativo antes de compilar controllers", async () => {
    const value = createToken<string>("plugin/value");
    const plugin = defineDeclarativePlugin({
      name: "fixture-plugin",
      version: "1.0.0",
      provides: ["fixture/value"],
      register(context) {
        context.provider({ provide: value, useValue: "from plugin" });
      },
    });

    @Controller("/plugin")
    class PluginController {
      constructor(@Inject(value) private readonly message: string) {}

      @Get("/")
      get() {
        return this.message;
      }
    }

    const app = await createApplication(
      defineModule({
        name: "plugin-app",
        controllers: [PluginController],
        plugins: [plugin],
      }),
    );
    expect(app.get(value)).toBe("from plugin");
    await app.close();
  });

  test("resolve @Inject de método de rota pelo container", async () => {
    const service = createToken<string>("route/injected");

    @Controller("/route-inject")
    class RouteInjectionController {
      @Get("/")
      get(@Inject(service) value: string) {
        return value;
      }
    }

    const app = await createApplication(
      defineModule({
        name: "route-inject-app",
        controllers: [RouteInjectionController],
        providers: [{ provide: service, useValue: "from container" }],
      }),
    );

    const response = await app.fetch(new Request("http://test/route-inject"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('"from container"');
    await app.close();
  });

  test("expõe rotas readonly na inspeção da aplicação", async () => {
    const app = await createApplication(
      defineModule({ name: "inspect-app", controllers: [HelloController] }),
    );

    const inspection = app.inspect();
    expect(inspection.routes).toEqual([
      {
        module: "inspect-app",
        controller: "HelloController",
        method: "GET",
        path: "/hello",
      },
    ]);
    expect(Object.isFrozen(inspection)).toBe(true);
    expect(Object.isFrozen(inspection.routes)).toBe(true);
    expect(() =>
      (inspection.routes as unknown as Array<unknown>).push({}),
    ).toThrow();
    await app.close();
  });

  test("não expõe containers mutáveis na visão pública de módulos", async () => {
    const app = await createApplication(
      defineModule({
        name: "readonly-modules",
        controllers: [HelloController],
      }),
    );

    const module = app.modules.get("readonly-modules");
    expect(module).toBeDefined();
    expect(module && "container" in module).toBe(false);
    expect(Object.isFrozen(module)).toBe(true);
    expect(Object.isFrozen(module?.tokens)).toBe(true);
    expect(
      (app.modules as ReadonlyMap<string, unknown> & { set?: unknown }).set,
    ).toBeUndefined();
    await app.close();
  });

  test("registra health checks declarativos no bootstrap", async () => {
    let calls = 0;
    const plugin = defineDeclarativePlugin({
      name: "health-plugin",
      version: "1.0.0",
      register(context) {
        context.healthCheck("database", (signal) => {
          expect(signal).toBeInstanceOf(AbortSignal);
          calls++;
          return true;
        });
      },
    });
    const app = await createApplication(
      defineModule({ name: "health-app", plugins: [plugin] }),
    );

    const response = await app.fetch(new Request("http://test/health/ready"));
    expect(response.status).toBe(200);
    expect(calls).toBe(1);
    await app.close();
  });

  test("recebe manifest de queries no bootstrap e na inspeção", async () => {
    const query = defineGeneratedQuery({
      id: "tasks/list",
      source: "tasks.sql:1",
      cardinality: "many",
      sql: "SELECT 1",
    });
    const manifest = createGeneratedQueryManifest([query]);
    const app = await createApplication(
      defineModule({ name: "manifest-app" }),
      { queryManifest: manifest },
    );

    expect(app.queryManifest).toBe(manifest);
    expect(app.inspect().queryManifest).toBe(manifest);
    await app.close();
  });

  test("aplica integrações declarativas de PostgreSQL e autenticação", async () => {
    const database = testPostgres([{ id: 1 }]);
    const query = defineGeneratedQuery({
      id: "integration/list",
      source: "integration.sql:1",
      cardinality: "many",
      sql: "SELECT id FROM integration",
    });
    const plugin = defineDeclarativePlugin({
      name: "integration-plugin",
      version: "1.0.0",
      register(context) {
        context.postgres(database, { healthCheck: false });
        context.auth(async (token) => ({
          valid: token === "valid",
          payload: { sub: "user-1" },
        }));
      },
    });

    @Controller("/integration")
    class IntegrationController {
      @Get("/")
      @Sql(query)
      @Result("many")
      list() {}
    }

    const app = await createApplication(
      defineModule({
        name: "integration-app",
        plugins: [plugin],
        controllers: [IntegrationController],
        queries: [query],
      }),
    );
    expect(
      await (await app.fetch(new Request("http://test/integration"))).json(),
    ).toEqual([{ id: 1 }]);
    await app.close();
  });
});
