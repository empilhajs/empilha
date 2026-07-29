import { describe, expect, test } from "bun:test";
import { Empilha } from "../../src";

describe("health checks", () => {
  test("retorna saudável, degradado, erro e múltiplos checks", async () => {
    const app = new Empilha()
      .configureHttp({ cors: false })
      .healthCheck("ok", async () => true)
      .healthCheck("false", () => false)
      .healthCheck("error", () => {
        throw new Error("down");
      });

    app.validate([]).initialize([]);

    const response = await app.test().get("/health");

    expect(response.status).toBe(503);

    expect(await response.json()).toEqual({
      status: "degraded",
      checks: {
        ok: "up",
        false: "down",
        error: "down",
      },
    });
  });

  test("registra health check depois de controllers e rejeita nome duplicado", async () => {
    const app = new Empilha().configureHttp({ cors: false });

    app.validate([]).initialize([]);

    app.healthCheck("db", () => true);

    const response = await app.test().get("/health");

    expect(response.status).toBe(200);

    expect(() => {
      app.healthCheck("db", () => true);
    }).toThrow("já foi registrado");
  });
});
