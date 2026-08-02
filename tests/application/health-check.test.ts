import { describe, expect, test } from "bun:test";
import { createApplication } from "../../src";
import { testModule } from "../helpers/test-utils";

describe("health checks", () => {
  test("liveness não executa checks de readiness", async () => {
    let checksRun = 0;
    const app = await createApplication(testModule([]), {
      configure(runtime) {
        runtime.configureHttp({ cors: false }).healthCheck("database", () => {
          checksRun++;
          throw new Error("database unavailable");
        });
      },
    });

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
    const app = await createApplication(testModule([]), {
      configure(runtime) {
        runtime
          .configureHttp({ cors: false })
          .healthCheck("first", check)
          .healthCheck("second", check);
      },
    });

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
    const app = await createApplication(testModule([]), {
      configure(runtime) {
        runtime
          .configureHttp({ cors: false })
          .configureHealthChecks({ timeout: 5, maxConcurrentRequests: 1 })
          .healthCheck("slow", (signal) => {
            signal?.addEventListener("abort", () => {
              aborted = true;
            });
            return pending;
          })
          .healthCheck("down", () => false);
      },
    });

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
    const app = await createApplication(testModule([]), {
      configure(runtime) {
        runtime
          .configureHttp({ cors: false, handlerTimeout: null })
          .healthCheck("ok", () => true);
      },
    });

    const response = await app.test().get("/health/ready");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      checks: { ok: "up" },
    });
    expect((await app.test().get("/health")).status).toBe(404);
  });

  test("retorna saudável, degradado, erro e múltiplos checks", async () => {
    const app = await createApplication(testModule([]), {
      configure(runtime) {
        runtime
          .configureHttp({ cors: false })
          .healthCheck("ok", async () => true)
          .healthCheck("false", () => false)
          .healthCheck("error", () => {
            throw new Error("down");
          });
      },
    });

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

  test("registra health check no módulo e rejeita nome duplicado", async () => {
    const app = await createApplication(testModule([]), {
      configure(runtime) {
        runtime.configureHttp({ cors: false }).healthCheck("db", () => true);
        expect(() => runtime.healthCheck("db", () => true)).toThrow(
          "já foi registrado",
        );
      },
    });

    const response = await app.test().get("/health/ready");

    expect(response.status).toBe(200);
  });
});
