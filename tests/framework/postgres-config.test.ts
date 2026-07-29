import { describe, expect, test } from "bun:test";
import { Empilha, type ManagedPostgresPool } from "../../src";

describe("configuração PostgreSQL", () => {
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

    expect((await app.test().get("/health")).status).toBe(200);
    expect(await (await app.test().get("/health")).json()).toEqual({
      status: "ok",
      checks: { database: "up" },
    });

    await app.close();
    expect(closed).toBe(true);
  });
});
