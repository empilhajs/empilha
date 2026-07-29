import { describe, expect, test } from "bun:test";
import { AfterResponse, Controller, Empilha, Get } from "../../src";

describe("Empilha background handlers", () => {
  test("responde imediatamente sem sleep real", async () => {
    let resolve: (() => void) | undefined;
    let markExecuted: (() => void) | undefined;

    const done = new Promise<void>((complete) => {
      resolve = complete;
    });

    const executedSignal = new Promise<void>((complete) => {
      markExecuted = complete;
    });

    let executed = false;

    class Jobs {
      @Get("/")
      @AfterResponse()
      async run() {
        await done;
        executed = true;
        markExecuted?.();
      }
    }

    Controller("/jobs")(Jobs);

    const app = new Empilha().configureHttp({ cors: false });
    app.validate([Jobs]).initialize([Jobs]);

    const response = await app.test().get("/jobs");

    expect(response.status).toBe(202);

    resolve?.();
    await executedSignal;

    expect(executed).toBe(true);
  });

  test("encaminha erro de background para callback", async () => {
    let error: unknown;
    let reject: ((reason?: unknown) => void) | undefined;
    let markError: (() => void) | undefined;

    const pending = new Promise<void>((_, fail) => {
      reject = fail;
    });

    const errorSignal = new Promise<void>((complete) => {
      markError = complete;
    });

    class Jobs {
      @Get("/")
      @AfterResponse()
      async run() {
        await pending;
      }
    }

    Controller("/jobs-error")(Jobs);

    const app = new Empilha()
      .configureHttp({ cors: false })
      .onBackgroundError((value) => {
        error = value;
        markError?.();
      });

    app.validate([Jobs]).initialize([Jobs]);

    const response = await app.test().get("/jobs-error");

    expect(response.status).toBe(202);

    reject?.(new Error("background"));
    await errorSignal;

    expect(error).toBeInstanceOf(Error);
  });

  test("aguarda observer assíncrono que também falha", async () => {
    let reject: ((reason?: unknown) => void) | undefined;
    let observed!: () => void;

    const pending = new Promise<void>((_, fail) => {
      reject = fail;
    });

    const observedPromise = new Promise<void>((resolve) => {
      observed = resolve;
    });

    class Jobs {
      @Get("/")
      @AfterResponse()
      async run() {
        await pending;
      }
    }

    Controller("/async-observer")(Jobs);

    const app = new Empilha()
      .configureHttp({ cors: false })
      .onBackgroundError(async () => {
        observed();
        throw new Error("observer failed");
      })
      .validate([Jobs])
      .initialize([Jobs]);

    expect((await app.test().get("/async-observer")).status).toBe(202);

    reject?.(new Error("background failed"));
    await observedPromise;
    await app.close();
  });

  test("close aguarda trabalhos em background pendentes", async () => {
    let finish!: () => void;
    const blocker = new Promise<void>((resolve) => {
      finish = resolve;
    });

    class Jobs {
      @Get("/")
      @AfterResponse()
      async run() {
        await blocker;
      }
    }

    Controller("/tracked-background")(Jobs);

    const app = new Empilha()
      .configureHttp({ cors: false })
      .validate([Jobs])
      .initialize([Jobs]);

    const response = await app.test().get("/tracked-background");

    expect(response.status).toBe(202);

    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });

    await Promise.resolve();
    expect(closed).toBe(false);

    finish();
    await closing;

    expect(closed).toBe(true);
  });

  test("limita concorrência e rejeita quando a fila está cheia", async () => {
    const releases: Array<() => void> = [];
    const started: number[] = [];
    let notifySecond!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      notifySecond = resolve;
    });

    class Jobs {
      @Get("/")
      @AfterResponse()
      async run() {
        const id = started.length + 1;
        started.push(id);

        if (id === 2) {
          notifySecond();
        }

        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
      }
    }

    Controller("/limited-background")(Jobs);

    const app = new Empilha()
      .configureHttp({ cors: false })
      .backgroundJobs({
        concurrency: 1,
        queueLimit: 1,
      })
      .validate([Jobs])
      .initialize([Jobs]);

    const first = await app.test().get("/limited-background");
    await Promise.resolve();

    const second = await app.test().get("/limited-background");
    const third = await app.test().get("/limited-background");

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(third.status).toBe(503);
    expect(started).toEqual([1]);

    releases.shift()?.();
    await secondStarted;

    expect(started).toEqual([1, 2]);

    releases.shift()?.();
    await app.close();
  });
});
