import { describe, expect, test } from "bun:test";
import { createApplication, type ManagedPostgresPool } from "../../src";
import { testModule } from "../helpers/test-utils";

describe("configuração PostgreSQL", () => {
  test("usa o caminho cancelável sem passar opções como callback ao pg", async () => {
    const argumentsReceived: unknown[][] = [];
    let receivedSignal: AbortSignal | undefined;
    const pool: ManagedPostgresPool = {
      query: async (...args: unknown[]) => {
        argumentsReceived.push(args);
        return { rows: [] };
      },
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release() {},
      }),
      queryWithOptions: async (sql, params, options) => {
        receivedSignal = options?.signal;
        return pool.query(sql, params);
      },
      end: async () => {},
    };

    const app = await createApplication(testModule([]), {
      configure: (runtime) =>
        runtime.configureHttp({ cors: false }).postgres(pool),
    });

    expect((await app.test().get("/health/ready")).status).toBe(200);
    expect(argumentsReceived).toEqual([["SELECT 1", undefined]]);
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    await app.close();
  });

  test("configura runner, health check e encerramento do pool", async () => {
    let closed = false;
    const pool: ManagedPostgresPool = {
      query: async () => ({ rows: [] }),
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release() {},
      }),
      queryWithOptions: async () => ({ rows: [] }),
      end: () => {
        closed = true;
      },
    };

    const app = await createApplication(testModule([]), {
      configure: (runtime) =>
        runtime.configureHttp({ cors: false }).postgres(pool),
    });

    expect((await app.test().get("/health/ready")).status).toBe(200);
    expect(await (await app.test().get("/health/ready")).json()).toEqual({
      status: "ok",
      checks: { database: "up" },
    });

    await app.close();
    expect(closed).toBe(true);
  });

  test("rejeita pool gerenciado sem cancelamento quando há timeout", async () => {
    const pool: ManagedPostgresPool = {
      query: async () => ({ rows: [] }),
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release() {},
      }),
      end() {},
    };

    await expect(
      createApplication(testModule([]), {
        configure: (runtime) => runtime.postgres(pool),
      }),
    ).rejects.toThrow("queryWithOptions");
  });
});
