import { describe, expect, test } from "bun:test";
import {
  Controller,
  Empilha,
  Get,
  Sql,
  Transaction,
  requestContext,
} from "../../src";

describe("Empilha transactions", () => {
  function runner(fail = false) {
    const calls: string[] = [];

    const client = {
      query: async (sql: string) => {
        calls.push(sql);

        if (fail && sql === "SELECT") {
          throw new Error("query");
        }

        return {
          rows: [{ ok: true }],
        };
      },

      release: () => {
        calls.push("release");
      },
    };

    return {
      calls,

      connect: async () => client,

      query: async (sql: string) => {
        calls.push(sql);

        return {
          rows: [],
        };
      },
    };
  }

  test("Transaction read executa BEGIN, READ ONLY, QUERY, COMMIT e release", async () => {
    class Read {
      @Get("/")
      @Transaction("read")
      @Sql("read")
      get() {}
    }

    Controller("/tx-read")(Read);

    const mock = runner();

    const app = new Empilha()
      .registerQuery("read", "SELECT")
      .postgres(mock)
      .configureHttp({ cors: false });

    app.validate([Read]).initialize([Read]);

    await app.test().get("/tx-read");

    expect(mock.calls).toEqual([
      "BEGIN",
      "SET TRANSACTION READ ONLY",
      "SELECT",
      "COMMIT",
      "release",
    ]);
  });

  test("Transaction aplica timeout durante aquisição do client", async () => {
    class Hanging {
      @Get("/")
      @Transaction("write")
      @Sql("hanging")
      get() {}
    }

    Controller("/tx-hanging")(Hanging);

    const app = new Empilha()
      .registerQuery("hanging", "SELECT")
      .postgres(
        {
          query: async () => ({ rows: [] }),
          connect: () => new Promise<never>(() => {}),
        },
        { timeout: 5, healthCheck: false },
      )
      .configureHttp({ cors: false });

    app.validate([Hanging]).initialize([Hanging]);

    expect((await app.test().get("/tx-hanging")).status).toBe(504);
  });

  test("Transaction write faz COMMIT e rollback, sempre liberando", async () => {
    class Write {
      @Get("/")
      @Transaction("write")
      @Sql("write")
      get() {}
    }

    Controller("/tx-write")(Write);

    const mock = runner();

    const app = new Empilha()
      .registerQuery("write", "UPDATE")
      .postgres(mock)
      .configureHttp({ cors: false });

    app.validate([Write]).initialize([Write]);

    await app.test().get("/tx-write");

    expect(mock.calls).toEqual(["BEGIN", "UPDATE", "COMMIT", "release"]);

    class Fail {
      @Get("/")
      @Transaction("write")
      @Sql("fail")
      get() {}
    }

    Controller("/tx-fail")(Fail);

    const failed = runner(true);

    const failingApp = new Empilha()
      .registerQuery("fail", "SELECT")
      .postgres(failed)
      .configureHttp({ cors: false });

    failingApp.validate([Fail]).initialize([Fail]);

    const response = await failingApp.test().get("/tx-fail");

    expect(response.status).toBe(500);

    expect(failed.calls).toEqual(["BEGIN", "SELECT", "ROLLBACK", "release"]);
  });

  test("mantém a transação aberta durante o controller e suas queries", async () => {
    class Write {
      @Get("/")
      @Transaction("write")
      @Sql("write")
      async get() {
        await requestContext().transaction?.query("SECOND QUERY");
      }
    }

    Controller("/tx-controller")(Write);

    const mock = runner();
    const app = new Empilha()
      .registerQuery("write", "FIRST QUERY")
      .postgres(mock)
      .configureHttp({ cors: false });

    app.validate([Write]).initialize([Write]);
    await app.test().get("/tx-controller");

    expect(mock.calls).toEqual([
      "BEGIN",
      "FIRST QUERY",
      "SECOND QUERY",
      "COMMIT",
      "release",
    ]);
  });

  test("faz rollback quando o controller falha depois da query", async () => {
    class Failing {
      @Get("/")
      @Transaction("write")
      @Sql("write")
      get() {
        throw new Error("controller");
      }
    }

    Controller("/tx-controller-fail")(Failing);

    const mock = runner();
    const app = new Empilha()
      .registerQuery("write", "FIRST QUERY")
      .postgres(mock)
      .configureHttp({ cors: false });

    app.validate([Failing]).initialize([Failing]);
    const response = await app.test().get("/tx-controller-fail");

    expect(response.status).toBe(500);
    expect(mock.calls).toEqual(["BEGIN", "FIRST QUERY", "ROLLBACK", "release"]);
  });

  test("rejeita runner sem suporte a transação no registro", () => {
    class Plain {
      @Get("/")
      @Transaction("read")
      @Sql("plain")
      get() {}
    }

    Controller("/plain-tx")(Plain);

    const app = new Empilha()
      .registerQuery("plain", "SELECT")
      .postgres({
        query: async () => ({
          rows: [],
        }),
      })
      .configureHttp({ cors: false });

    expect(() => app.validate([Plain]).initialize([Plain])).toThrow(
      "não suporta transações",
    );
  });

  test("aborta query no timeout, faz rollback e libera o client", async () => {
    class Slow {
      @Get("/")
      @Transaction("write")
      @Sql("timeout")
      get() {}
    }

    Controller("/tx-timeout")(Slow);

    const calls: string[] = [];
    let receivedSignal = false;

    const client = {
      query: async (
        sql: string,
        _params?: unknown[],
        options?: {
          signal?: AbortSignal;
        },
      ) => {
        calls.push(sql);

        if (sql !== "SELECT SLOW") {
          return {
            rows: [],
          };
        }

        receivedSignal = options?.signal !== undefined;

        return new Promise<{
          rows: unknown[];
        }>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            {
              once: true,
            },
          );
        });
      },
      release: () => {
        calls.push("release");
      },
    };

    const app = new Empilha()
      .configureHttp({ cors: false })
      .registerQuery("timeout", "SELECT SLOW")
      .postgres(
        {
          query: async () => ({
            rows: [],
          }),
          connect: async () => client,
        },
        { timeout: 5 },
      )
      .validate([Slow])
      .initialize([Slow]);

    const response = await app.test().get("/tx-timeout");

    expect(response.status).toBe(504);
    expect(receivedSignal).toBe(true);
    expect(calls).toEqual(["BEGIN", "SELECT SLOW", "ROLLBACK", "release"]);
  });
});
