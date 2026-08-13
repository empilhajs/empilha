import { describe, expect, test } from "bun:test";
/* eslint-disable no-shadow -- callbacks configuram a aplicação criada na mesma expressão. */
import {
  Body,
  AfterResponse,
  AfterCommit,
  Controller,
  createTestApplication,
  Get,
  HeaderParams,
  Identity,
  BeforeSql,
  Post,
  Request as RequestDecorator,
  QueryParams,
  Result,
  NotFoundWhenEmpty,
  postgresRunner,
  testPostgres,
  Sql,
  Transaction,
  t,
} from "../../src";
import type { CreateApplicationOptions } from "../../src";
import type { ModuleDefinition } from "../../src/modules";
import {
  testAuthPlugin,
  testModule,
  testPostgresPlugin,
} from "../helpers/test-utils";

function compileSqlApplication(
  module: ModuleDefinition,
  configure: NonNullable<CreateApplicationOptions["configure"]> = () => {},
) {
  return createTestApplication(module, { configure }).compile();
}

describe("Empilha SQL", () => {
  test("rejeita @Result sem @Sql no bootstrap", async () => {
    class MissingQuery {
      @Get("/")
      @Result("one")
      get() {
        return { ok: true };
      }
    }

    Controller("/missing-query")(MissingQuery);

    await expect(
      compileSqlApplication(testModule([MissingQuery])),
    ).rejects.toThrow('usa @Result("one"), mas não possui @Sql()');
  });

  test("rejeita AfterCommit sem transação", async () => {
    class InvalidAfterCommit {
      @Get("/")
      @AfterCommit("notify")
      get() {
        return { ok: true };
      }

      notify() {}
    }

    Controller("/invalid-after-commit")(InvalidAfterCommit);

    await expect(
      compileSqlApplication(testModule([InvalidAfterCommit]), (app) => {
        app.configureHttp({ cors: false });
      }),
    ).rejects.toThrow("AfterCommit sem transação");
  });

  test("rejeita hooks SQL inexistentes no bootstrap", async () => {
    class InvalidHooks {
      @Get("/")
      @BeforeSql("missingBefore")
      @Transaction("read")
      @Sql("read")
      get() {}
    }

    Controller("/invalid-hooks")(InvalidHooks);

    await expect(
      compileSqlApplication(testModule([InvalidHooks]), (app) =>
        app
          .registerQuery("read", "SELECT 1")
          .postgres({ query: async () => ({ rows: [] }) }),
      ),
    ).rejects.toThrow('BeforeSql("missingBefore")');
  });

  test("rejeita AfterResponse combinado com SQL", async () => {
    class InvalidBackground {
      @Get("/")
      @AfterResponse()
      @Sql("read")
      get() {}
    }

    Controller("/invalid-background")(InvalidBackground);

    await expect(
      compileSqlApplication(testModule([InvalidBackground]), (app) =>
        app
          .registerQuery("read", "SELECT 1")
          .postgres({ query: async () => ({ rows: [] }) }),
      ),
    ).rejects.toThrow("combina uma resposta em background");
  });

  test("não publica rotas quando uma rota posterior falha no bootstrap", async () => {
    @Controller("/ready")
    class Ready {
      @Get("/")
      get() {
        return { ok: true };
      }
    }

    @Controller("/broken")
    class Broken {
      @Get("/")
      @Sql("missing")
      get() {}
    }

    await expect(
      compileSqlApplication(testModule([Ready, Broken]), (app) => {
        app.configureHttp({ cors: false });
      }),
    ).rejects.toThrow('Query "missing" não encontrada');
  });

  test("adapta um pool PostgreSQL sem wrappers manuais", async () => {
    const calls: string[] = [];
    const pool = {
      query: async (sql: string) => {
        calls.push(sql);
        return { rows: [] };
      },
      connect: async () => ({
        query: async (sql: string) => {
          calls.push(sql);
          return { rows: [] };
        },
        release: () => {},
      }),
    };

    await postgresRunner(pool).query("SELECT 1");
    expect(calls).toEqual(["SELECT 1"]);
  });

  test("executa pool sem cancelamento usando timeout de parede", async () => {
    const argumentsReceived: unknown[][] = [];
    const pool = {
      query: async () => ({ rows: [] }),
      connect: async () => ({
        query: async (...args: unknown[]) => {
          argumentsReceived.push(args);
          return { rows: [] };
        },
        release: () => {},
      }),
    };

    const client = await postgresRunner(pool).connect!();
    await client.query("BEGIN", undefined, {
      signal: new AbortController().signal,
    });

    expect(argumentsReceived).toEqual([["BEGIN", undefined]]);
  });

  test("executa query em pool incompatível sem repassar cancelamento", async () => {
    let calls = 0;
    const pool = {
      query: async () => {
        calls++;
        return { rows: [] };
      },
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release: () => {},
      }),
    };

    await postgresRunner(pool).query("SELECT 1", [], {
      signal: new AbortController().signal,
    });
    expect(calls).toBe(1);
  });

  test("encaminha opções para pools que oferecem cancelamento nativo", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const pool = {
      query: async () => ({ rows: [] }),
      queryWithOptions: async (
        _sql: string,
        _params?: unknown[],
        options?: { signal?: AbortSignal },
      ) => {
        receivedSignal = options?.signal;
        return { rows: [] };
      },
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release: () => {},
      }),
    };

    await postgresRunner(pool).queryWithOptions?.("SELECT 1", [], {
      signal: controller.signal,
    });

    expect(receivedSignal).toBe(controller.signal);
  });

  test("executa BeforeSql antes de resolver bindings da query", async () => {
    const received: unknown[][] = [];

    @Controller("/users")
    class Users {
      @Post("/")
      @Body(t.Object({ password: t.String() }))
      @BeforeSql("prepare")
      @Sql("create")
      @Result("one")
      create() {}

      prepare(request: { body: { password: string } }) {
        request.body.password = `hashed_${request.body.password}`;
      }
    }

    const app = await compileSqlApplication(testModule([Users]), (app) =>
      app
        .registerQuery(
          "create",
          "INSERT INTO users(password) VALUES (:body.password)",
        )
        .postgres({
          query: async (_sql, params) => {
            received.push(params ?? []);
            return { rows: [{ ok: true }] };
          },
        })
        .validateResponseSchemas(false),
    );

    expect(
      (await app.test().post("/users", { password: "secret" })).status,
    ).toBe(201);
    expect(received).toEqual([["hashed_secret"]]);
  });

  test("permite usar o próprio método da rota como BeforeSql", async () => {
    const received: unknown[][] = [];

    @Controller("/users")
    class Users {
      @Post("/")
      @BeforeSql()
      @Body(t.Object({ password: t.String() }))
      @Sql("create")
      @Result("one")
      create(@RequestDecorator() request: { body: { password: string } }) {
        request.body.password = `hashed_${request.body.password}`;
      }
    }

    const app = await compileSqlApplication(testModule([Users]), (app) =>
      app
        .registerQuery(
          "create",
          "INSERT INTO users(password) VALUES (:body.password)",
        )
        .postgres({
          query: async (_sql, params) => {
            received.push(params ?? []);
            return { rows: [{ ok: true }] };
          },
        })
        .validateResponseSchemas(false),
    );

    expect(
      (await app.test().post("/users", { password: "secret" })).status,
    ).toBe(201);
    expect(received).toEqual([["hashed_secret"]]);
  });

  test("executa AfterCommit somente depois do commit", async () => {
    const events: string[] = [];

    @Controller("/users")
    class Users {
      @Post("/")
      @Transaction("write")
      @AfterCommit("notify")
      @Sql("create")
      @Result("one")
      create() {}

      notify() {
        events.push("after-commit");
      }
    }

    const database = testPostgres({
      rows: [{ ok: true }],
      onQuery: (sql) => {
        if (sql === "COMMIT") events.push("commit");
      },
    });
    const app = await compileSqlApplication(
      testModule([Users], { plugins: [testPostgresPlugin(database)] }),
      (app) =>
        app
          .registerQuery("create", "INSERT INTO users DEFAULT VALUES")
          .validateResponseSchemas(false),
    );

    expect((await app.test().post("/users")).status).toBe(201);
    expect(events).toEqual(["commit", "after-commit"]);
  });

  test("converte violação de unique do PostgreSQL em 409", async () => {
    @Controller("/users")
    class Users {
      @Post("/")
      @Sql("create")
      create() {}
    }

    const app = await compileSqlApplication(testModule([Users]), (app) =>
      app
        .registerQuery(
          "create",
          "INSERT INTO users(email) VALUES ('used@test.com')",
        )
        .postgres(
          {
            query: async () => {
              throw Object.assign(new Error("duplicate"), { code: "23505" });
            },
          },
          { timeout: null },
        ),
    );

    const response = await app.test().post("/users");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      type: "about:blank",
      title: "Resource already exists",
      status: 409,
    });
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });

  test("aplica defaults e conversão em QueryParams antes da query", async () => {
    const received: unknown[][] = [];

    @Controller("/tasks")
    class Tasks {
      @Get("/")
      @QueryParams(t.Object({ limit: t.Integer(), completed: t.Boolean() }), {
        limit: 20,
        completed: false,
      })
      @Sql("list")
      @Result("many")
      list() {}
    }

    const app = await compileSqlApplication(testModule([Tasks]), (app) =>
      app
        .registerQuery(
          "list",
          "SELECT * FROM tasks WHERE completed = :query.completed LIMIT :query.limit",
        )
        .postgres({
          query: async (_sql, params) => {
            received.push(params ?? []);
            return { rows: [] };
          },
        }),
    );

    expect((await app.test().get("/tasks?limit=5&completed=true")).status).toBe(
      200,
    );
    expect(received).toEqual([[true, 5]]);
  });

  test("rejeita query escrita em transação read-only", async () => {
    @Controller("/tasks")
    class Tasks {
      @Post("/")
      @Sql("update-task")
      @Result("none")
      @Transaction("read")
      update() {}
    }

    const database = {
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release() {},
      }),
      query: async () => ({ rows: [] }),
    };
    await expect(
      compileSqlApplication(
        testModule([Tasks], { plugins: [testPostgresPlugin(database)] }),
        (app) =>
          app.registerQuery("update-task", "UPDATE tasks SET done = true"),
      ),
    ).rejects.toThrow('Use @Transaction("write")');
  });

  test("usa parâmetros do path em bindings SQL sem parâmetro fantasma", async () => {
    const received: unknown[][] = [];

    @Controller("/users")
    class Users {
      @Get("/:id")
      @Sql("by-id")
      @Result("one")
      find() {}
    }

    const app = await compileSqlApplication(testModule([Users]), (app) =>
      app
        .configureHttp({ cors: false })
        .registerQuery("by-id", "SELECT * FROM users WHERE id = :param.id")
        .postgres({
          query: async (_sql, params) => {
            received.push(params ?? []);
            return { rows: [{ id: 1 }] };
          },
        }),
    );

    expect((await app.test().get("/users/1")).status).toBe(200);
    expect(received).toEqual([["1"]]);
  });

  test("sugere propriedade do schema para binding de body inválido", async () => {
    @Controller("/users")
    class Users {
      @Post("/")
      @Body(t.Object({ title: t.String() }))
      @Sql("create")
      create() {}
    }

    await expect(
      compileSqlApplication(testModule([Users]), (app) =>
        app.registerQuery(
          "create",
          "INSERT INTO users(title) VALUES (:body.titel)",
        ),
      ),
    ).rejects.toThrow('Você quis dizer "body.title"?');
  });

  test("exige schema para cada origem HTTP usada por binding SQL", async () => {
    const expectMissingSchema = async (
      source: "body" | "query" | "header",
      sql: string,
    ) => {
      class MissingSchema {
        get() {}
      }

      const route = source === "body" ? Post("/") : Get("/");
      route(
        MissingSchema.prototype,
        "get",
        Object.getOwnPropertyDescriptor(MissingSchema.prototype, "get")!,
      );
      Sql("missing-schema")(
        MissingSchema.prototype,
        "get",
        Object.getOwnPropertyDescriptor(MissingSchema.prototype, "get")!,
      );
      Controller(`/missing-${source}`)(MissingSchema);

      await expect(
        compileSqlApplication(testModule([MissingSchema]), (app) =>
          app
            .registerQuery("missing-schema", sql)
            .postgres({ query: async () => ({ rows: [] }) }),
        ),
      ).rejects.toThrow(`origem "${source}"`);
    };

    await expectMissingSchema("body", "SELECT :body.value");
    await expectMissingSchema("query", "SELECT :query.value");
    await expectMissingSchema("header", "SELECT :header.x-api-key");
  });

  test("valida binding de header contra HeaderParams", async () => {
    class HeaderQuery {
      @Get("/")
      @HeaderParams(t.Object({ x_api_key: t.String() }))
      @Sql("header-query")
      @Result("one")
      get() {}
    }

    Controller("/header-query")(HeaderQuery);
    const app = await compileSqlApplication(testModule([HeaderQuery]), (app) =>
      app
        .registerQuery("header-query", "SELECT :header.x_api_key")
        .postgres({ query: async () => ({ rows: [{ ok: true }] }) }),
    );

    const response = await app.test().get("/header-query", {
      headers: { x_api_key: "secret" },
    });
    expect(response.status).toBe(200);
  });

  test("sugere propriedade do schema para binding de query inválido", async () => {
    @Controller("/tasks")
    class Tasks {
      @Get("/")
      @QueryParams(t.Object({ limit: t.Integer() }))
      @Sql("list")
      list() {}
    }

    await expect(
      compileSqlApplication(testModule([Tasks]), (app) =>
        app
          .registerQuery("list", "SELECT * FROM tasks LIMIT :query.limt")
          .postgres({ query: async () => ({ rows: [] }) }),
      ),
    ).rejects.toThrow('Você quis dizer "query.limit"?');
  });

  test("valida propriedades aninhadas de bindings de body", async () => {
    @Controller("/users")
    class Users {
      @Post("/")
      @Body(t.Object({ user: t.Object({ email: t.String() }) }))
      @Sql("create")
      create() {}
    }

    await expect(
      compileSqlApplication(testModule([Users]), (app) =>
        app.registerQuery(
          "create",
          "INSERT INTO users(email) VALUES (:body.user.emali)",
        ),
      ),
    ).rejects.toThrow('Você quis dizer "body.user.email"?');
  });

  test("valida bindings em Partial e Intersect e exige campos comuns em Union", async () => {
    const partial = t.Partial(
      t.Object({
        title: t.String(),
        done: t.Boolean(),
      }),
    );
    const intersect = t.Intersect([
      t.Object({ user: t.Object({ email: t.String() }) }),
      t.Object({ title: t.String() }),
    ]);

    class Tasks {
      @Post("/partial")
      @Body(partial)
      @Sql("partial")
      partial() {}

      @Post("/intersect")
      @Body(intersect)
      @Sql("intersect")
      intersect() {}
    }

    Controller("/composed-schemas")(Tasks);

    const app = await compileSqlApplication(testModule([Tasks]), (app) =>
      app
        .registerQuery("partial", "SELECT :body.title")
        .registerQuery("intersect", "SELECT :body.user.email, :body.title")
        .postgres({ query: async () => ({ rows: [] }) }),
    );

    expect(app.fetch).toBeTypeOf("function");

    const union = t.Union([
      t.Object({ title: t.String() }),
      t.Object({ name: t.String() }),
    ]);

    class UnionTask {
      @Post("/")
      @Body(union)
      @Sql("union")
      create() {}
    }

    Controller("/union-schema")(UnionTask);

    await expect(
      compileSqlApplication(testModule([UnionTask]), (app) =>
        app
          .registerQuery("union", "SELECT :body.title")
          .postgres({ query: async () => ({ rows: [] }) }),
      ),
    ).rejects.toThrow("não existe no schema declarado em @Body()");
  });

  test("usa bindings explícitos e preserva a ordem declarada", async () => {
    const input = t.Object({
      name: t.String(),
      email: t.String(),
    });
    class Users {
      create(_request: unknown) {}
    }

    RequestDecorator()(Users.prototype, "create", 0);
    Body(input)(
      Users.prototype,
      "create",
      Object.getOwnPropertyDescriptor(Users.prototype, "create")!,
    );

    Sql("create-user", ["body.name", "body.email"])(
      Users.prototype,
      "create",
      Object.getOwnPropertyDescriptor(Users.prototype, "create")!,
    );

    Post("/")(
      Users.prototype,
      "create",
      Object.getOwnPropertyDescriptor(Users.prototype, "create")!,
    );

    Controller("/users")(Users);

    const calls: unknown[][] = [];

    const app = await compileSqlApplication(testModule([Users]), (app) => {
      app
        .registerQuery(
          "create-user",
          "INSERT INTO users(name,email) VALUES (:body.name,:body.email)",
        )
        .postgres({
          query: async (_sql, params) => {
            calls.push(params ?? []);

            return {
              rows: [{ id: 1 }],
            };
          },
        })
        .configureHttp({ cors: false });
    });

    const response = await app.test().post("/users", {
      email: "a@x.test",
      name: "Ana",
    });

    expect(response.status).toBe(201);
    expect(calls).toEqual([["Ana", "a@x.test"]]);
  });

  test("Sql suporta one, many, none e onEmpty notFound", async () => {
    class Tasks {
      @Get("/one")
      @Sql("one")
      @Result("one")
      one() {}

      @Get("/many")
      @Sql("many")
      @Result("many")
      many() {}

      @Get("/none")
      @Sql("none")
      @Result("none")
      none() {}

      @Get("/missing")
      @Sql("missing")
      @Result("one")
      @NotFoundWhenEmpty()
      missing() {}
    }

    Controller("/tasks")(Tasks);

    const app = await compileSqlApplication(testModule([Tasks]), (app) => {
      app
        .registerQuery("one", "SELECT one")
        .registerQuery("many", "SELECT many")
        .registerQuery("none", "SELECT none")
        .registerQuery("missing", "SELECT missing")
        .postgres({
          query: async (sql: string) => ({
            rows: sql.includes("one")
              ? [{ id: 1 }]
              : sql.includes("many")
                ? [{ id: 1 }, { id: 2 }]
                : [],
          }),
        })
        .configureHttp({ cors: false });
    });

    expect(await (await app.test().get("/tasks/one")).json()).toEqual({
      id: 1,
    });

    expect(await (await app.test().get("/tasks/many")).json()).toEqual([
      { id: 1 },
      { id: 2 },
    ]);

    expect((await app.test().get("/tasks/none")).status).toBe(200);

    expect((await app.test().get("/tasks/missing")).status).toBe(404);
  });

  test("SQL pode validar body e retornar entidade", async () => {
    const schema = t.Object({
      title: t.String({
        minLength: 1,
      }),
    });

    class Tasks {
      @Post("/")
      @Body(schema)
      @Sql("task")
      @Result("one")
      create() {}
    }

    Controller("/tasks-v2")(Tasks);

    const app = await compileSqlApplication(testModule([Tasks]), (app) => {
      app
        .registerQuery(
          "task",
          "INSERT INTO tasks(title) VALUES (:body.title) RETURNING id, title",
        )
        .postgres({
          query: async () => ({
            rows: [
              {
                id: 1,
                title: "Teste",
              },
            ],
          }),
        })
        .configureHttp({ cors: false });
    });

    expect(
      await (
        await app.test().post("/tasks-v2", {
          title: "Teste",
        })
      ).json(),
    ).toEqual({
      id: 1,
      title: "Teste",
    });

    expect(
      (
        await app.test().post("/tasks-v2", {
          title: "",
        })
      ).status,
    ).toBe(400);
  });

  test("bindings de auth e identity funcionam em rotas protegidas", async () => {
    const received: unknown[][] = [];

    @Controller("/profile")
    class Profile {
      @Get("/")
      @Sql("current-user")
      @Result("one")
      get(@Identity() _identity: unknown) {}
    }

    const database = {
      query: async (_sql: string, params?: unknown[]) => {
        received.push(params ?? []);
        return { rows: [{ id: "user-123" }] };
      },
    };
    const app = await compileSqlApplication(
      testModule([Profile], {
        plugins: [
          testAuthPlugin(() => ({
            valid: true,
            payload: { sub: "user-123" },
          })),
          testPostgresPlugin(database),
        ],
      }),
      (app) => {
        app
          .registerQuery(
            "current-user",
            "SELECT * FROM users WHERE id = :identity.sub",
          )
          .configureHttp({ cors: false });
      },
    );

    const response = await app
      .test()
      .get("/profile", { headers: { authorization: "Bearer token" } });

    expect(response.status).toBe(200);
    expect(received).toEqual([["user-123"]]);
  });

  test("valida binding auth contra claims da Identity configurada", async () => {
    const access = {
      name: "access",
      claims: t.Object({ sub: t.String() }),
    };
    class Profile {
      @Get("/")
      @Sql("invalid-claim")
      get(_identity: unknown) {}
    }
    Identity(access)(Profile.prototype, "get", 0);
    Controller("/invalid-claim")(Profile);

    await expect(
      compileSqlApplication(
        testModule([Profile], {
          plugins: [
            testAuthPlugin(() => ({
              valid: true,
              payload: { sub: "user-1" },
            })),
          ],
        }),
        (app) => {
          app
            .registerQuery("invalid-claim", "SELECT :auth.tenantId")
            .postgres({ query: async () => ({ rows: [] }) });
        },
      ),
    ).rejects.toThrow("schema de claims");
  });

  test("ordem dos decorators não altera registro SQL", async () => {
    class Reorder {
      @Get("/test")
      @Sql("orderTest")
      get() {}
    }

    Controller("/reorder")(Reorder);

    const app = await compileSqlApplication(testModule([Reorder]), (app) => {
      app
        .registerQuery("orderTest", "SELECT 1")
        .postgres({
          query: async () => ({
            rows: [{ ok: true }],
          }),
        })
        .configureHttp({ cors: false });
    });

    expect((await app.test().get("/reorder/test")).status).toBe(200);
  });

  test("mantém o resultado SQL isolado por requisição concorrente", async () => {
    class Tasks {
      @Get("/:id")
      @Sql("by-id")
      @Result("one")
      find() {}
    }

    Controller("/concurrent")(Tasks);

    const runner = {
      query: async (_sql: string, params?: unknown[]) => {
        const id = params?.[0];
        await new Promise((resolve) => setTimeout(resolve, id === "a" ? 5 : 0));
        return { rows: [{ id }] };
      },
    };

    const app = await compileSqlApplication(testModule([Tasks]), (app) => {
      app
        .registerQuery("by-id", "SELECT :param.id")
        .postgres(runner)
        .configureHttp({ cors: false });
    });

    const [first, second] = await Promise.all([
      app.test().get("/concurrent/a"),
      app.test().get("/concurrent/b"),
    ]);

    expect(await first.json()).toEqual({ id: "a" });
    expect(await second.json()).toEqual({ id: "b" });
  });

  test("isola queries com o mesmo nome entre aplicações", async () => {
    @Controller("/")
    class Shared {
      @Get("/")
      @Sql("shared")
      @Result("one")
      get() {}
    }

    const first = await compileSqlApplication(testModule([Shared]), (app) => {
      app
        .configureHttp({ cors: false })
        .registerQuery("shared", "SELECT first")
        .postgres({ query: async (sql) => ({ rows: [{ sql }] }) });
    });

    const second = await compileSqlApplication(testModule([Shared]), (app) => {
      app
        .configureHttp({ cors: false })
        .registerQuery("shared", "SELECT second")
        .postgres({ query: async (sql) => ({ rows: [{ sql }] }) });
    });

    expect(await (await first.test().get("/")).json()).toEqual({
      sql: "SELECT first",
    });
    expect(await (await second.test().get("/")).json()).toEqual({
      sql: "SELECT second",
    });
  });
});
