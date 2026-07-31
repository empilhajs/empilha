import { describe, expect, test } from "bun:test";
import {
  AfterResponse,
  Context,
  Controller,
  Empilha,
  Get,
  Inject,
  Produces,
  type RequestScope,
} from "../../src";

describe("Empilha lifecycle", () => {
  test("permite validar e inicializar em fases separadas", async () => {
    class Routes {
      @Get("/")
      get() {
        return "ok";
      }
    }
    Controller("/explicit-lifecycle")(Routes);

    const app = new Empilha().configureHttp({ cors: false });
    app.validate([Routes]);
    app.initialize([Routes]);

    expect((await app.test().get("/explicit-lifecycle")).status).toBe(200);
    await app.close();
  });

  test("exige os mesmos controllers entre validate e initialize", () => {
    class First {
      @Get("/")
      get() {
        return "first";
      }
    }
    Controller("/first")(First);

    class Second {
      @Get("/")
      get() {
        return "second";
      }
    }
    Controller("/second")(Second);

    const app = new Empilha().configureHttp({ cors: false });
    app.validate([First]);

    expect(() => app.initialize([Second])).toThrow(
      "mesmos controllers usados em validate",
    );
  });

  test("faz rollback das rotas se o health check conflitar no bootstrap", async () => {
    @Controller("/health/ready")
    class ConflictingHealthRoute {
      @Get("/")
      get() {
        return "não deveria ser publicado";
      }
    }

    const app = new Empilha()
      .configureHttp({ cors: false })
      .healthCheck("ok", () => true);

    expect(() => app.initialize([ConflictingHealthRoute])).toThrow();
    expect((await app.test().get("/health/ready")).status).toBe(404);
    expect(() => app.initialize([ConflictingHealthRoute])).toThrow("bootstrap");
  });

  test("faz rollback das rotas e marca a aplicação como falha após hook", async () => {
    @Controller("/hook-failure")
    class HookFailureRoute {
      @Get("/")
      get() {
        return "não deveria ser publicado";
      }
    }

    const app = new Empilha()
      .configureHttp({ cors: false })
      .onAfterInitialize(() => {
        throw new Error("hook failed");
      });

    expect(() => app.initialize([HookFailureRoute])).toThrow("hook failed");
    expect((await app.test().get("/hook-failure")).status).toBe(404);
    expect(() => app.initialize([HookFailureRoute])).toThrow("bootstrap");
  });

  test("executa hooks do lifecycle e bloqueia alterações estruturais tardias", () => {
    const events: string[] = [];
    class Routes {
      @Get("/")
      get() {
        return "ok";
      }
    }
    Controller("/hooks")(Routes);

    const app = new Empilha()
      .onBeforeValidate(() => events.push("before"))
      .onAfterInitialize(() => events.push("after"))
      .validate([Routes])
      .initialize([Routes]);

    expect(events).toEqual(["before", "after"]);
    expect(() => app.registerQuery("late", "SELECT 1")).toThrow(
      "fase configure",
    );
    expect(() => app.validate([Routes]).initialize([Routes])).toThrow(
      "fase configure",
    );
  });

  test("executa onStart após o adapter iniciar", async () => {
    let started = false;
    const app = new Empilha().onStart(() => {
      started = true;
    });
    app.validate([]).initialize([]);

    const internals = app as unknown as {
      http: { listen: (port: number) => Promise<void> };
    };
    internals.http.listen = async () => {};

    const port = 40_000 + Math.floor(Math.random() * 1_000);
    await app.listen(port);
    expect(started).toBe(true);
    expect(() => app.onStart(() => {})).toThrow("antes de app.listen");

    await app.close();
  });

  test("rejeita hook de fechamento depois que a aplicação encerra", async () => {
    const app = new Empilha();

    await app.close();

    expect(() => app.onClose(() => {})).toThrow("após app.close");
  });

  test("atende uma requisição HTTP real e encerra o servidor", async () => {
    class Live {
      @Get("/")
      @Produces("text/plain")
      get() {
        return "live";
      }
    }
    Controller("/live")(Live);

    const app = new Empilha()
      .configureHttp({ cors: false })
      .validate([Live])
      .initialize([Live]);

    try {
      await app.listen(0);
    } catch (error) {
      if (
        (error as { code?: string }).code === "EADDRINUSE" ||
        String(error).includes("EADDRINUSE")
      )
        return;
      throw error;
    }
    const internals = app as unknown as {
      http: { port: number | null };
    };
    expect(internals.http.port).not.toBeNull();
    const response = await fetch(
      `http://localhost:${internals.http.port}/live`,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("live");
    await app.close();
  });

  test("aplica timeout ao handler e aborta o signal da requisição", async () => {
    let finish!: () => void;
    const blocker = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let signal: AbortSignal | undefined;

    class Slow {
      @Get("/")
      async get(
        @Context()
        context: RequestScope,
      ) {
        signal = context.signal;
        await blocker;
        return {
          late: true,
        };
      }
    }

    Controller("/slow-handler")(Slow);

    const app = new Empilha()
      .configureHttp({ cors: false, handlerTimeout: 5 })
      .validate([Slow])
      .initialize([Slow]);

    const response = await app.test().get("/slow-handler");

    expect(response.status).toBe(504);
    expect(signal?.aborted).toBe(true);

    finish();
    await app.close();
  });

  test("aplica timeout ao graceful shutdown e sinaliza cancelamento", async () => {
    let aborted = false;

    class Jobs {
      @Get("/")
      @AfterResponse()
      async run(
        @Context()
        context: RequestScope,
      ) {
        await new Promise<void>((resolve) => {
          context.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            {
              once: true,
            },
          );
        });
      }
    }

    Controller("/shutdown-timeout")(Jobs);

    const app = new Empilha()
      .configureHttp({ cors: false, shutdownTimeout: 5 })
      .validate([Jobs])
      .initialize([Jobs]);

    expect((await app.test().get("/shutdown-timeout")).status).toBe(202);

    await expect(app.close()).rejects.toThrow("Timeout ao drenar");
    expect(aborted).toBe(true);

    await app.close();
  });

  test("não libera singleton enquanto shutdown forçado tem trabalho ativo", async () => {
    let finish!: () => void;
    const blocker = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let disposed = false;

    class Resource {}

    class Jobs {
      constructor(@Inject(Resource) private readonly resource: Resource) {}

      @Get("/")
      @AfterResponse()
      async run() {
        expect(this.resource).toBeInstanceOf(Resource);
        await blocker;
      }
    }

    Controller("/shutdown-resource")(Jobs);

    const app = new Empilha()
      .configureHttp({ cors: false, shutdownTimeout: 5 })
      .provide(Resource, {
        useClass: Resource,
        onDispose: () => {
          disposed = true;
        },
      })
      .validate([Jobs])
      .initialize([Jobs]);

    expect((await app.test().get("/shutdown-resource")).status).toBe(202);

    await expect(app.close()).rejects.toThrow("Timeout ao drenar");
    expect(disposed).toBe(false);

    finish();
    await app.close();

    expect(disposed).toBe(true);
  });

  test("valida configurações de timeout", () => {
    const app = new Empilha();

    expect(() => app.configureHttp({ handlerTimeout: 0 })).toThrow(RangeError);
    expect(() => app.configureHttp({ bodyTimeout: -1 })).toThrow(RangeError);
    expect(() => app.configureHttp({ shutdownTimeout: 1.5 })).toThrow(
      RangeError,
    );
    expect(
      app.configureHttp({
        handlerTimeout: null,
        bodyTimeout: null,
        shutdownTimeout: null,
      }),
    ).toBe(app);
  });

  test("limita requisições simultâneas", async () => {
    let finish!: () => void;
    const blocker = new Promise<void>((resolve) => {
      finish = resolve;
    });

    class Limited {
      @Get("/")
      async get() {
        await blocker;
        return {
          ok: true,
        };
      }
    }

    Controller("/request-limit")(Limited);

    const app = new Empilha()
      .configureHttp({ cors: false, maxConcurrentRequests: 1 })
      .validate([Limited])
      .initialize([Limited]);

    const first = app.test().get("/request-limit");
    await Promise.resolve();

    const rejected = await app.test().get("/request-limit");

    expect(rejected.status).toBe(503);

    finish();
    expect((await first).status).toBe(200);

    expect((await app.test().get("/request-limit")).status).toBe(200);

    await app.close();
  });

  test("encerra recursos externos uma vez e em ordem inversa", async () => {
    const closed: string[] = [];
    const app = new Empilha()
      .onClose(() => {
        closed.push("pool");
      })
      .onClose(() => {
        closed.push("cache");
      });

    await app.close();
    await app.close();

    expect(closed).toEqual(["cache", "pool"]);
  });

  test("limita o tempo de descarte de recursos", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const app = new Empilha()
      .configureHttp({ disposalTimeout: 5 })
      .onClose(() => pending);

    await expect(app.close()).rejects.toThrow("Timeout ao descartar");

    finish();
  });
});
