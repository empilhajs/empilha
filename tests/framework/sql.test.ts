import { describe, expect, test } from "bun:test";
import {
  Body,
  AfterResponse,
  AfterCommit,
  Controller,
  Empilha,
  Get,
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

describe("Empilha SQL", () => {
  test("rejeita AfterCommit sem transação", () => {
    class InvalidAfterCommit {
      @Get("/")
      @AfterCommit("notify")
      get() {
        return { ok: true };
      }

      notify() {}
    }

    Controller("/invalid-after-commit")(InvalidAfterCommit);

    const app = new Empilha().configureHttp({ cors: false });
    expect(() =>
      app.validate([InvalidAfterCommit]).initialize([InvalidAfterCommit]),
    ).toThrow("AfterCommit, mas não possui uma transação");
  });

  test("rejeita hooks SQL inexistentes no bootstrap", () => {
    class InvalidHooks {
      @Get("/")
      @BeforeSql("missingBefore")
      @Transaction("read")
      @Sql("read")
      get() {}
    }

    Controller("/invalid-hooks")(InvalidHooks);

    expect(() =>
      new Empilha()
        .registerQuery("read", "SELECT 1")
        .postgres({ query: async () => ({ rows: [] }) })
        .validate([InvalidHooks])
        .initialize([InvalidHooks]),
    ).toThrow('BeforeSql("missingBefore")');
  });

  test("rejeita AfterResponse combinado com SQL", () => {
    class InvalidBackground {
      @Get("/")
      @AfterResponse()
      @Sql("read")
      get() {}
    }

    Controller("/invalid-background")(InvalidBackground);

    expect(() =>
      new Empilha()
        .registerQuery("read", "SELECT 1")
        .postgres({ query: async () => ({ rows: [] }) })
        .validate([InvalidBackground])
        .initialize([InvalidBackground]),
    ).toThrow("combina AfterResponse com SQL");
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

    const app = new Empilha().configureHttp({ cors: false });

    expect(() => app.initialize([Ready, Broken])).toThrow(
      'Query "missing" não encontrada',
    );
    expect((await app.test().get("/ready")).status).toBe(404);
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

  test("adapta também o client transacional sem encaminhar opções como callback", async () => {
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

    const app = new Empilha()
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
      .validateResponseSchemas(false)
      .initialize([Users]);

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

    const app = new Empilha()
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
      .validateResponseSchemas(false)
      .initialize([Users]);

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
    const app = new Empilha()
      .registerQuery("create", "INSERT INTO users DEFAULT VALUES")
      .postgres(database)
      .validateResponseSchemas(false)
      .initialize([Users]);

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

    const app = new Empilha()
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
      )
      .initialize([Users]);

    const response = await app.test().post("/users");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Resource already exists" });
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

    const app = new Empilha()
      .registerQuery(
        "list",
        "SELECT * FROM tasks WHERE completed = :query.completed LIMIT :query.limit",
      )
      .postgres({
        query: async (_sql, params) => {
          received.push(params ?? []);
          return { rows: [] };
        },
      })
      .initialize([Tasks]);

    expect((await app.test().get("/tasks?limit=5&completed=true")).status).toBe(
      200,
    );
    expect(received).toEqual([[true, 5]]);
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

    const app = new Empilha()
      .configureHttp({ cors: false })
      .registerQuery("by-id", "SELECT * FROM users WHERE id = :param.id")
      .postgres({
        query: async (_sql, params) => {
          received.push(params ?? []);
          return { rows: [{ id: 1 }] };
        },
      })
      .validate([Users])
      .initialize([Users]);

    expect((await app.test().get("/users/1")).status).toBe(200);
    expect(received).toEqual([["1"]]);
  });

  test("sugere propriedade do schema para binding de body inválido", () => {
    @Controller("/users")
    class Users {
      @Post("/")
      @Body(t.Object({ title: t.String() }))
      @Sql("create")
      create() {}
    }

    expect(() =>
      new Empilha()
        .registerQuery(
          "create",
          "INSERT INTO users(title) VALUES (:body.titel)",
        )
        .validate([Users])
        .initialize([Users]),
    ).toThrow('Você quis dizer "body.title"?');
  });

  test("valida propriedades aninhadas de bindings de body", () => {
    @Controller("/users")
    class Users {
      @Post("/")
      @Body(t.Object({ user: t.Object({ email: t.String() }) }))
      @Sql("create")
      create() {}
    }

    expect(() =>
      new Empilha()
        .registerQuery(
          "create",
          "INSERT INTO users(email) VALUES (:body.user.emali)",
        )
        .validate([Users])
        .initialize([Users]),
    ).toThrow('Você quis dizer "body.user.email"?');
  });

  test("valida bindings em Partial e Intersect e exige campos comuns em Union", () => {
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

    const app = new Empilha()
      .registerQuery("partial", "SELECT :body.title")
      .registerQuery("intersect", "SELECT :body.user.email, :body.title")
      .postgres({ query: async () => ({ rows: [] }) })
      .validate([Tasks])
      .initialize([Tasks]);

    expect(app).toBeInstanceOf(Empilha);

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

    expect(() =>
      new Empilha()
        .registerQuery("union", "SELECT :body.title")
        .postgres({ query: async () => ({ rows: [] }) })
        .validate([UnionTask])
        .initialize([UnionTask]),
    ).toThrow("não existe no schema declarado em @Body()");
  });

  test("usa bindings explícitos e preserva a ordem declarada", async () => {
    class Users {
      create(_request: unknown) {}
    }

    RequestDecorator()(Users.prototype, "create", 0);

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

    const app = new Empilha()
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

    app.validate([Users]).initialize([Users]);

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

    const app = new Empilha()
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

    app.validate([Tasks]).initialize([Tasks]);

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

    const app = new Empilha()
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

    app.validate([Tasks]).initialize([Tasks]);

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

    const app = new Empilha()
      .auth(() => ({ valid: true, payload: { sub: "user-123" } }))
      .registerQuery(
        "current-user",
        "SELECT * FROM users WHERE id = :identity.sub",
      )
      .postgres({
        query: async (_sql, params) => {
          received.push(params ?? []);
          return { rows: [{ id: "user-123" }] };
        },
      })
      .configureHttp({ cors: false });

    app.validate([Profile]).initialize([Profile]);

    const response = await app
      .test()
      .get("/profile", { headers: { authorization: "Bearer token" } });

    expect(response.status).toBe(200);
    expect(received).toEqual([["user-123"]]);
  });

  test("ordem dos decorators não altera registro SQL", async () => {
    class Reorder {
      @Get("/test")
      @Sql("orderTest")
      get() {}
    }

    Controller("/reorder")(Reorder);

    const app = new Empilha()
      .registerQuery("orderTest", "SELECT 1")
      .postgres({
        query: async () => ({
          rows: [{ ok: true }],
        }),
      })
      .configureHttp({ cors: false });

    app.validate([Reorder]).initialize([Reorder]);

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

    const app = new Empilha()
      .registerQuery("by-id", "SELECT :param.id")
      .postgres(runner)
      .configureHttp({ cors: false });
    app.validate([Tasks]).initialize([Tasks]);

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

    const first = new Empilha()
      .configureHttp({ cors: false })
      .registerQuery("shared", "SELECT first")
      .postgres({
        query: async (sql) => ({
          rows: [
            {
              sql,
            },
          ],
        }),
      })
      .validate([Shared])
      .initialize([Shared]);

    const second = new Empilha()
      .configureHttp({ cors: false })
      .registerQuery("shared", "SELECT second")
      .postgres({
        query: async (sql) => ({
          rows: [
            {
              sql,
            },
          ],
        }),
      })
      .validate([Shared])
      .initialize([Shared]);

    expect(await (await first.test().get("/")).json()).toEqual({
      sql: "SELECT first",
    });
    expect(await (await second.test().get("/")).json()).toEqual({
      sql: "SELECT second",
    });
  });
});
