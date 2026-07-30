import { describe, expect, test } from "bun:test";
import { Empilha } from "../../src";

describe("health checks", () => {
  test("liveness não executa checks de readiness", async () => {
    let checksRun = 0;
    const app = new Empilha()
      .configureHttp({ cors: false })
      .healthCheck("database", () => {
        checksRun++;
        throw new Error("database unavailable");
      });

    app.validate([]).initialize([]);

    const response = await app.test().get("/health/live");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(checksRun).toBe(0);
  });

  test("executa os checks em paralelo", async () => {
    let started = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const check = async () => {
      started++;
      await pending;
      return true;
    };
    const app = new Empilha()
      .configureHttp({ cors: false })
      .healthCheck("first", check)
      .healthCheck("second", check);

    app.validate([]).initialize([]);

    const response = app.test().get("/health/ready");
    expect(started).toBe(2);
    release();

    expect((await response).status).toBe(200);
  });

  test("configura timeout, limite de readiness e liveness", async () => {
    let release!: () => void;
    const pending = new Promise<boolean>((resolve) => {
      release = () => resolve(true);
    });
    let aborted = false;
    const app = new Empilha()
      .configureHttp({ cors: false })
      .configureHealthChecks({ timeout: 5, maxConcurrentRequests: 1 })
      .healthCheck("slow", (signal) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return pending;
      })
      .healthCheck("down", () => false);

    app.validate([]).initialize([]);

    const first = app.test().get("/health/ready");
    expect((await app.test().get("/health/ready")).status).toBe(503);
    const ready = await first;

    expect(ready.status).toBe(503);
    expect(aborted).toBe(true);
    expect(await ready.json()).toEqual({
      status: "degraded",
      checks: { slow: "down", down: "down" },
    });
    expect((await app.test().get("/health/live")).status).toBe(200);
    release();
  });

  test("mantém o request context quando o timeout do handler está desativado", async () => {
    const app = new Empilha()
      .configureHttp({ cors: false, handlerTimeout: null })
      .healthCheck("ok", () => true);

    app.validate([]).initialize([]);

    const response = await app.test().get("/health/ready");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      checks: { ok: "up" },
    });
    expect((await app.test().get("/health")).status).toBe(404);
  });

  test("retorna saudável, degradado, erro e múltiplos checks", async () => {
    const app = new Empilha()
      .configureHttp({ cors: false })
      .healthCheck("ok", async () => true)
      .healthCheck("false", () => false)
      .healthCheck("error", () => {
        throw new Error("down");
      });

    app.validate([]).initialize([]);

    const response = await app.test().get("/health/ready");

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

    const response = await app.test().get("/health/ready");

    expect(response.status).toBe(200);

    expect(() => {
      app.healthCheck("db", () => true);
    }).toThrow("já foi registrado");
  });
});
