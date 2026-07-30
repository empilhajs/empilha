import { describe, expect, test } from "bun:test";
import { Empilha, type ManagedPostgresPool } from "../../src";

describe("configuração PostgreSQL", () => {
  test("adapta o pool gerenciado sem passar opções como callback ao pg", async () => {
    const argumentsReceived: unknown[][] = [];
    const pool: ManagedPostgresPool = {
      query: async (...args: unknown[]) => {
        argumentsReceived.push(args);
        return { rows: [] };
      },
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release() {},
      }),
      end: async () => {},
    };

    const app = new Empilha()
      .configureHttp({ cors: false })
      .postgres(pool)
      .validate([])
      .initialize([]);

    expect((await app.test().get("/health/ready")).status).toBe(200);
    expect(argumentsReceived).toEqual([["SELECT 1", undefined]]);
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
      end: () => {
        closed = true;
      },
    };

    const app = new Empilha()
      .configureHttp({ cors: false })
      .postgres(pool)
      .validate([])
      .initialize([]);

    expect((await app.test().get("/health/ready")).status).toBe(200);
    expect(await (await app.test().get("/health/ready")).json()).toEqual({
      status: "ok",
      checks: { database: "up" },
    });

    await app.close();
    expect(closed).toBe(true);
  });
});
