import { describe, expect, test } from "bun:test";
import {
  ApplicationGraphBuilder,
  assertValidApplicationGraph,
  linkApplicationGraph,
} from "../../src/application/graph";
import { createToken } from "../../src/di";
import { defineModule, type ModuleDefinition } from "../../src/modules";
import {
  AfterCommit,
  AfterResponse,
  BeforeSql,
  Catch,
  Controller,
  Get,
  Roles,
  Result,
  Returns,
  Sql,
  Transaction,
} from "../../src/decorators";
import { defineDeclarativePlugin } from "../../src/application/declarative-plugin";
import { defineGeneratedQuery } from "../../src/sql/generated-query";
import { Type } from "@sinclair/typebox";

class Service {}

describe("application graph", () => {
  test("diagnostica fontes de resposta concorrentes antes do bootstrap", () => {
    @Controller("/jobs")
    class JobsController {
      @Get("/")
      @AfterResponse()
      @Sql("listJobs")
      run() {}
    }

    const graph = new ApplicationGraphBuilder().build(
      defineModule({ name: "jobs", controllers: [JobsController] }),
    );

    expect(graph.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "E_RESPONSE_SOURCE_CONFLICT",
        module: "jobs",
        hint: expect.stringContaining("background"),
      }),
    );
  });

  test("diagnostica hooks de lifecycle inválidos no grafo", () => {
    @Controller("/hooks")
    class InvalidHooksController {
      @Get("/")
      @BeforeSql("missingBefore")
      @AfterCommit("missingAfter")
      run() {}
    }

    const graph = new ApplicationGraphBuilder().build(
      defineModule({ name: "hooks", controllers: [InvalidHooksController] }),
    );

    expect(graph.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        "E_LIFECYCLE_HOOK_INVALID",
        "E_LIFECYCLE_HOOK_INVALID",
      ]),
    );
    expect(graph.diagnostics).toHaveLength(3);
  });

  test("diagnostica catcher com tipo ou assinatura inválidos", () => {
    @Controller("/errors")
    class InvalidCatcherController {
      @Catch(Error)
      handle() {}
    }

    const graph = new ApplicationGraphBuilder().build(
      defineModule({
        name: "errors",
        controllers: [InvalidCatcherController],
      }),
    );

    expect(graph.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "E_CATCHER_INVALID",
        module: "errors",
        hint: expect.stringContaining("receba o erro"),
      }),
    );
  });

  test("diagnostica autenticação e transação sem capabilities visíveis", () => {
    @Controller("/protected")
    class ProtectedController {
      @Get("/")
      @Roles("admin")
      @Transaction("read")
      get() {}
    }

    const graph = new ApplicationGraphBuilder().build(
      defineModule({
        name: "protected",
        controllers: [ProtectedController],
      }),
    );

    expect(graph.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        "E_AUTH_CAPABILITY_MISSING",
        "E_TRANSACTION_CAPABILITY_MISSING",
      ]),
    );
  });

  test("aceita capabilities de autenticação e PostgreSQL trazidas por imports", () => {
    const auth = defineDeclarativePlugin({
      name: "test-auth",
      version: "1.0.0",
      provides: ["auth/handler"],
      register() {},
    });
    const database = defineDeclarativePlugin({
      name: "test-database",
      version: "1.0.0",
      provides: ["postgres/query-runner"],
      register() {},
    });

    @Controller("/protected")
    class ProtectedController {
      @Get("/")
      @Roles("admin")
      @Transaction("read")
      get() {}
    }

    const graph = new ApplicationGraphBuilder().build(
      defineModule({
        name: "app",
        imports: [
          defineModule({ name: "auth", plugins: [auth] }),
          defineModule({ name: "database", plugins: [database] }),
        ],
        controllers: [ProtectedController],
      }),
    );

    expect(graph.diagnostics).toEqual([]);
  });

  test("diagnostica operationId duplicado e schema OpenAPI com ID conflitante", () => {
    @Controller("/first")
    class FirstController {
      @Get("/")
      get() {}
    }
    @Controller("/second")
    class SecondController {
      @Get("/")
      get() {}
    }
    Object.defineProperty(SecondController, "name", {
      value: "FirstController",
    });

    const firstSchema = Type.Object({ ok: Type.Boolean() }, { $id: "Shared" });
    const secondSchema = Type.Object({ ok: Type.Boolean() }, { $id: "Shared" });
    @Controller("/schemas")
    class SchemaFirstController {
      @Get("/one")
      @Returns(firstSchema)
      one() {}
    }
    @Controller("/schemas")
    class SchemaSecondController {
      @Get("/two")
      @Returns(secondSchema)
      two() {}
    }

    const graph = new ApplicationGraphBuilder().build(
      defineModule({
        name: "openapi",
        controllers: [
          FirstController,
          SecondController,
          SchemaFirstController,
          SchemaSecondController,
        ],
      }),
    );

    expect(graph.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        "E_OPENAPI_OPERATION_ID_DUPLICATE",
        "E_OPENAPI_SCHEMA_DUPLICATE",
      ]),
    );
  });

  test("diagnostica rota duplicada e divergência de parâmetros", () => {
    @Controller("/users")
    class FirstController {
      @Get("/:id")
      get() {}
    }

    @Controller("/users")
    class SecondController {
      @Get("/:userId")
      get() {}

      @Get("/static")
      duplicate() {}
    }

    @Controller("/users")
    class ThirdController {
      @Get("/static")
      duplicate() {}
    }

    @Controller("/search")
    class RegexFirstController {
      @Get("/:id<.+>")
      get() {}
    }

    @Controller("/search")
    class RegexSecondController {
      @Get("/:code<\\d+>")
      get() {}
    }

    const graph = new ApplicationGraphBuilder().build(
      defineModule({
        name: "routes",
        controllers: [
          FirstController,
          SecondController,
          ThirdController,
          RegexFirstController,
          RegexSecondController,
        ],
      }),
    );

    expect(graph.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        "E_ROUTE_PARAM_CONFLICT",
        "E_ROUTE_DUPLICATE",
        "E_ROUTE_SPECIFICITY_AMBIGUOUS",
      ]),
    );
    expect(graph.diagnostics).toHaveLength(3);
  });

  test("diagnostica query que não é visível ao módulo do controller", () => {
    const query = defineGeneratedQuery({
      id: "tasks/list",
      source: "tasks.sql:1",
      cardinality: "many",
      sql: "SELECT 1",
    });

    @Controller("/tasks")
    class TasksController {
      @Get("/")
      @Sql(query)
      @Result("many")
      list() {}
    }

    const graph = new ApplicationGraphBuilder().build(
      defineModule({ name: "app", controllers: [TasksController] }),
    );

    expect(graph.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "E_QUERY_NOT_VISIBLE",
        module: "app",
        subject: expect.objectContaining({ controller: "TasksController" }),
      }),
    );
    expect(() => assertValidApplicationGraph(graph)).toThrow(
      "E_QUERY_NOT_VISIBLE",
    );
  });

  test("diagnostica query nomeada ausente no grafo", () => {
    @Controller("/tasks")
    class MissingQueryController {
      @Get("/")
      @Sql("tasks/missing")
      list() {}
    }

    const graph = new ApplicationGraphBuilder().build(
      defineModule({
        name: "tasks",
        controllers: [MissingQueryController],
      }),
    );

    expect(graph.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "E_QUERY_NOT_FOUND",
        module: "tasks",
        hint: expect.stringContaining("artifact"),
      }),
    );
  });

  test("diagnostica binding incompatível do query artifact no grafo", () => {
    const query = defineGeneratedQuery({
      id: "tasks/by-owner",
      source: "tasks.sql:1",
      cardinality: "many",
      bindings: { "query.page": "number" },
      sql: "SELECT * FROM tasks WHERE owner = :auth.sub",
    });

    @Controller("/tasks")
    class InvalidBindingController {
      @Get("/")
      @Sql(query)
      @Result("many")
      list() {}
    }

    const graph = new ApplicationGraphBuilder().build(
      defineModule({
        name: "tasks",
        controllers: [InvalidBindingController],
        queries: [query],
      }),
    );

    expect(graph.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "E_SQL_BINDING_INVALID",
        message: expect.stringContaining("tasks/by-owner"),
        hint: expect.stringContaining("artifact"),
      }),
    );
  });

  test("torna query declarada no módulo importado visível à rota", () => {
    const query = defineGeneratedQuery({
      id: "tasks/list",
      source: "tasks.sql:1",
      cardinality: "many",
      sql: "SELECT 1",
    });

    @Controller("/tasks")
    class TasksController {
      @Get("/")
      @Sql(query)
      @Result("many")
      list() {}
    }

    const tasks = defineModule({ name: "tasks", queries: [query] });
    const graph = new ApplicationGraphBuilder().build(
      defineModule({
        name: "app",
        imports: [tasks],
        controllers: [TasksController],
      }),
    );

    expect(graph.diagnostics).toEqual([]);
  });

  test("compila módulos e preserva exports no inspection", () => {
    const token = createToken<Service>("tasks/service");
    const tasks = defineModule({
      name: "tasks",
      providers: [{ provide: token, useValue: new Service() }],
      exports: [token],
    });
    const app = defineModule({ name: "app", imports: [tasks] });
    const graph = new ApplicationGraphBuilder().build(app);
    expect(graph.diagnostics).toEqual([]);
    expect(graph.modules.map((module) => module.name)).toEqual([
      "tasks",
      "app",
    ]);
    expect(graph.modules[0]?.exports).toEqual([token]);
    assertValidApplicationGraph(graph);
  });

  test("mantém estado de providers isolado entre aplicações compiladas", () => {
    const state = createToken<{ count: number }>("state");
    const module = defineModule({
      name: "isolated",
      providers: [
        {
          provide: state,
          useFactory: () => ({ count: 0 }),
          inject: [],
        },
      ],
      exports: [state],
    });
    const graph = new ApplicationGraphBuilder().build(
      defineModule({ name: "app", imports: [module] }),
    );

    const first = linkApplicationGraph(graph);
    const second = linkApplicationGraph(graph);
    const firstState = first.modules.get("isolated")?.resolve(state);
    const secondState = second.modules.get("isolated")?.resolve(state);

    expect(firstState).not.toBe(secondState);
    firstState!.count = 1;
    expect(secondState?.count).toBe(0);
  });

  test("diagnostica export de provider inexistente", () => {
    const token = createToken<Service>("missing");
    const graph = new ApplicationGraphBuilder().build(
      defineModule({ name: "app", exports: [token] }),
    );
    expect(graph.diagnostics).toMatchObject([
      { code: "E_MODULE_INVALID_EXPORT", severity: "error", module: "app" },
    ]);
    expect(() => assertValidApplicationGraph(graph)).toThrow(
      "E_MODULE_INVALID_EXPORT",
    );
  });

  test("mostra a cadeia completa de um ciclo de imports", () => {
    // The public declaration is immutable; this fixture only creates the
    // recursive shape needed to exercise the builder's defensive guard.
    type MutableModule = Omit<ModuleDefinition, "imports"> & {
      imports: ModuleDefinition[];
    };
    const first = Object.create(
      defineModule({ name: "first" }),
    ) as unknown as MutableModule;
    const second = Object.create(
      defineModule({ name: "second" }),
    ) as unknown as MutableModule;
    const third = Object.create(
      defineModule({ name: "third" }),
    ) as unknown as MutableModule;
    Object.defineProperty(first, "imports", { value: [], writable: true });
    Object.defineProperty(second, "imports", { value: [first] });
    Object.defineProperty(third, "imports", { value: [second] });
    first.imports.push(third);

    const graph = new ApplicationGraphBuilder().build(first);

    expect(graph.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "E_MODULE_IMPORT_CYCLE",
        message: "Ciclo de imports: first → third → second → first",
      }),
    );
  });

  test("diagnostica token exportado por imports concorrentes", () => {
    const token = createToken<Service>("shared/service");
    const left = defineModule({
      name: "left",
      providers: [{ provide: token, useValue: new Service() }],
      exports: [token],
    });
    const right = defineModule({
      name: "right",
      providers: [{ provide: token, useValue: new Service() }],
      exports: [token],
    });
    const graph = new ApplicationGraphBuilder().build(
      defineModule({ name: "root", imports: [left, right] }),
    );

    expect(graph.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "E_PROVIDER_TOKEN_AMBIGUOUS",
        module: "root",
      }),
    );
  });

  test("diagnostica singleton que depende de request scope através de import", () => {
    const requestValue = createToken<string>("request/value");
    const singletonValue = createToken<string>("singleton/value");
    const requestModule = defineModule({
      name: "request-module",
      providers: [
        { provide: requestValue, useValue: "request", scope: "request" },
      ],
      exports: [requestValue],
    });
    const graph = new ApplicationGraphBuilder().build(
      defineModule({
        name: "root",
        imports: [requestModule],
        providers: [
          {
            provide: singletonValue,
            useFactory: (...values) => String(values[0]),
            inject: [requestValue],
          },
        ],
      }),
    );

    expect(graph.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "E_SCOPE_INVALID",
        module: "root",
        hint: expect.stringContaining("request/transient"),
      }),
    );
    expect(() => assertValidApplicationGraph(graph)).toThrow("E_SCOPE_INVALID");
  });

  test("diagnostica dependência ausente e ciclo de providers antes do link", () => {
    const missing = createToken<string>("missing/dependency");
    const first = createToken<string>("cycle/first");
    const second = createToken<string>("cycle/second");
    const graph = new ApplicationGraphBuilder().build(
      defineModule({
        name: "providers",
        providers: [
          {
            provide: first,
            useFactory: (...values) => String(values[0]),
            inject: [second],
          },
          {
            provide: second,
            useFactory: (...values) => String(values[0]),
            inject: [first],
          },
          {
            provide: createToken<string>("missing/owner"),
            useFactory: (...values) => String(values[0]),
            inject: [missing],
          },
        ],
      }),
    );

    expect(graph.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "E_PROVIDER_CYCLE" }),
        expect.objectContaining({ code: "E_PROVIDER_DEPENDENCY_MISSING" }),
      ]),
    );
    expect(() => assertValidApplicationGraph(graph)).toThrow(
      "E_PROVIDER_CYCLE",
    );
  });

  test("ordena diagnostics e oferece hint de correção", () => {
    const first = createToken<Service>("first");
    const second = createToken<Service>("second");
    const graph = new ApplicationGraphBuilder().build(
      defineModule({
        name: "root",
        imports: [
          defineModule({ name: "z-module", exports: [first] }),
          defineModule({ name: "a-module", exports: [second] }),
        ],
      }),
    );

    expect(graph.diagnostics.map((diagnostic) => diagnostic.module)).toEqual([
      "a-module",
      "z-module",
    ]);
    expect(graph.diagnostics[0]?.hint).toContain("Declare o provider");
  });

  test("liga apenas exports importados e resolve factories por inject", async () => {
    const secret = createToken<string>("internal/secret");
    const greeting = createToken<string>("shared/greeting");
    const service = createToken<string>("feature/service");
    const shared = defineModule({
      name: "shared",
      providers: [
        { provide: secret, useValue: "private" },
        {
          provide: greeting,
          useFactory: (...values) => `${values[0]} world`,
          inject: [secret],
        },
      ],
      exports: [greeting],
    });
    const feature = defineModule({
      name: "feature",
      imports: [shared],
      providers: [
        {
          provide: service,
          useFactory: (...values) => `${values[0]}!`,
          inject: [greeting],
        },
      ],
      exports: [service],
    });
    const linked = linkApplicationGraph(
      new ApplicationGraphBuilder().build(feature),
    );

    expect(linked.root.resolve(service)).toBe("private world!");
    expect(() => linked.root.resolve(secret)).toThrow(
      "Nenhum provider registrado",
    );
    expect(linked.modules.get("shared")?.resolve(secret)).toBe("private");
    await linked.close();
  });
});
