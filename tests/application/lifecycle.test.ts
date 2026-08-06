import { describe, expect, test } from "bun:test";
import {
  AfterResponse,
  Context,
  Controller,
  createApplication,
  Get,
  Inject,
  Produces,
  type RequestScope,
} from "../../src";
import { testModule, testPort } from "../helpers/test-utils";

describe("Empilha lifecycle", () => {
  test("createApplication ativa o módulo uma vez e bloqueia mudanças estruturais tardias", async () => {
    class Routes {
      @Get("/")
      get() {
        return "ok";
      }
    }
    Controller("/explicit-lifecycle")(Routes);

    const app = await createApplication(testModule([Routes]), {
      configure: (runtime) => runtime.configureHttp({ cors: false }),
    });

    expect((await app.test().get("/explicit-lifecycle")).status).toBe(200);
    expect(() => app.registerQuery("late", "SELECT 1")).toThrow(
      "fase configure",
    );
    expect(() => app.configureHttp({ requestId: false })).toThrow(
      "fase configure",
    );
    await app.close();
  });

  test("faz rollback das rotas se o health check conflitar no bootstrap", async () => {
    @Controller("/health/ready")
    class ConflictingHealthRoute {
      @Get("/")
      get() {
        return "não deveria ser publicado";
      }
    }

    await expect(
      createApplication(testModule([ConflictingHealthRoute]), {
        configure: (runtime) =>
          runtime.configureHttp({ cors: false }).healthCheck("ok", () => true),
      }),
    ).rejects.toThrow("Rota");
  });

  test("executa onStart após o adapter iniciar", async () => {
    let started = false;
    const app = await createApplication(testModule([]), {
      configure(runtime) {
        runtime.onStart(() => {
          started = true;
        });
      },
    });

    try {
      await app.listen(testPort());
      expect(started).toBe(true);
      expect(() => app.onStart(() => {})).toThrow("antes de app.listen");
    } finally {
      await app.close();
    }
  });

  test("rejeita hook de fechamento depois que a aplicação encerra", async () => {
    const app = await createApplication(testModule([]));

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

    const app = await createApplication(testModule([Live]), {
      configure: (runtime) => runtime.configureHttp({ cors: false }),
    });

    try {
      await app.listen(testPort());
    } catch (error) {
      if (
        (error as { code?: string }).code === "EADDRINUSE" ||
        String(error).includes("EADDRINUSE")
      )
        return;
      throw error;
    }
    expect(app.url).not.toBeNull();
    const response = await fetch(new URL("/live", app.url!));

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

    const app = await createApplication(testModule([Slow]), {
      configure: (runtime) =>
        runtime.configureHttp({ cors: false, handlerTimeout: 5 }),
    });

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

    const app = await createApplication(testModule([Jobs]), {
      configure: (runtime) =>
        runtime.configureHttp({ cors: false, shutdownTimeout: 5 }),
    });

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

    const app = await createApplication(
      testModule([Jobs], {
        providers: [
          {
            provide: Resource,
            useClass: Resource,
            onDispose: () => {
              disposed = true;
            },
          },
        ],
      }),
      {
        configure: (runtime) =>
          runtime.configureHttp({ cors: false, shutdownTimeout: 5 }),
      },
    );

    expect((await app.test().get("/shutdown-resource")).status).toBe(202);

    await expect(app.close()).rejects.toThrow("Timeout ao drenar");
    expect(disposed).toBe(false);

    finish();
    await app.close();

    expect(disposed).toBe(true);
  });

  test("valida configurações de timeout", async () => {
    for (const http of [
      { handlerTimeout: 0 },
      { bodyTimeout: -1 },
      { shutdownTimeout: 1.5 },
    ]) {
      await expect(
        createApplication(testModule([]), { runtime: { http } }),
      ).rejects.toThrow(RangeError);
    }
    const app = await createApplication(testModule([]), {
      runtime: {
        http: {
          handlerTimeout: null,
          bodyTimeout: null,
          shutdownTimeout: null,
        },
      },
    });
    expect(app.fetch).toBeTypeOf("function");
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

    const app = await createApplication(testModule([Limited]), {
      configure: (runtime) =>
        runtime.configureHttp({ cors: false, maxConcurrentRequests: 1 }),
    });

    const first = app.test().get("/request-limit");
    await Promise.resolve();

    const rejected = await app.test().get("/request-limit");

    expect(rejected.status).toBe(503);

    finish();
    expect((await first).status).toBe(200);

    expect((await app.test().get("/request-limit")).status).toBe(200);

    await app.close();
  });

  test("mantém o limite de concorrência em rotas nativas do Bun", async () => {
    let finish!: () => void;
    let started!: () => void;
    const blocker = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });

    class NativeLimited {
      @Get("/")
      async get() {
        started();
        await blocker;
        return { ok: true };
      }
    }

    Controller("/native-limit")(NativeLimited);

    const app = await createApplication(testModule([NativeLimited]), {
      configure: (runtime) =>
        runtime.configureHttp({
          cors: false,
          handlerTimeout: null,
          maxConcurrentRequests: 1,
        }),
    });

    try {
      await app.listen(testPort());
      const url = new URL("/native-limit", app.url!);

      const first = fetch(url);
      await handlerStarted;
      const rejected = await fetch(url);

      expect(rejected.status).toBe(503);

      finish();
      expect((await first).status).toBe(200);
    } finally {
      await app.close();
    }
  });

  test("encerra recursos externos uma vez e em ordem inversa", async () => {
    const closed: string[] = [];
    const app = await createApplication(testModule([]), {
      configure(runtime) {
        runtime
          .onClose(() => {
            closed.push("pool");
          })
          .onClose(() => {
            closed.push("cache");
          });
      },
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
    const app = await createApplication(testModule([]), {
      configure: (runtime) =>
        runtime.configureHttp({ disposalTimeout: 5 }).onClose(() => pending),
    });

    await expect(app.close()).rejects.toThrow("Timeout ao descartar");

    finish();
  });
});
