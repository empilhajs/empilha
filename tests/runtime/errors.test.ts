import { describe, expect, test } from "bun:test";
import {
  Catch,
  Controller,
  createApplication,
  Get,
  Responses,
  t,
} from "../../src";
import { HttpError, NotFoundError } from "../../src/errors/index";
import { testModule } from "../helpers/test-utils";

describe("Empilha errors", () => {
  test("valida e serializa respostas de erro pelo status declarado", async () => {
    class Failure extends Error {}

    class Errors {
      @Get("/")
      @Responses({ 422: t.Object({ handled: t.Boolean() }) })
      run() {
        throw new Failure();
      }
    }

    Controller("/declared-error")(Errors);

    const app = await createApplication(testModule([Errors]), {
      configure: (runtime) =>
        runtime.configureHttp({ cors: false }).catch(Failure, () => ({
          status: 422,
          body: JSON.stringify({ handled: true, internal: "hidden" }),
        })),
    });

    const response = await app.test().get("/declared-error");

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ handled: true });
  });

  test("trata erro HTTP e erro não classificado", async () => {
    class Errors {
      @Get("/http")
      http() {
        throw new HttpError(418, "teapot");
      }

      @Get("/unknown")
      unknown() {
        throw new Error("boom");
      }
    }

    Controller("/errors")(Errors);

    const app = await createApplication(testModule([Errors]), {
      configure: (runtime) => runtime.configureHttp({ cors: false }),
    });

    const httpResponse = await app.test().get("/errors/http");
    expect(httpResponse.status).toBe(418);
    expect(httpResponse.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(await httpResponse.json()).toEqual({
      type: "about:blank",
      title: "teapot",
      status: 418,
    });

    const unknownResponse = await app.test().get("/errors/unknown");
    expect(unknownResponse.status).toBe(500);
    expect(await unknownResponse.json()).toEqual({
      type: "about:blank",
      title: "Internal server error",
      status: 500,
    });
  });

  test("não expõe detalhes de HttpError 5xx em produção", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      class ProductionFailure {
        @Get("/")
        fail() {
          throw new HttpError(503, "database password leaked");
        }
      }
      Controller("/production-failure")(ProductionFailure);
      const app = await createApplication(testModule([ProductionFailure]), {
        configure: (runtime) => runtime.configureHttp({ cors: false }),
      });

      const response = await app.test().get("/production-failure");
      const body = await response.json();
      expect(response.status).toBe(503);
      expect(body).toMatchObject({
        status: 503,
        title: "Internal server error",
      });
      expect(JSON.stringify(body)).not.toContain("database password leaked");
      await app.close();
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  test("prioriza catcher específico sobre genérico", async () => {
    class Errors {
      @Get("/")
      run() {
        throw new NotFoundError();
      }

      handleNotFound(_error: unknown) {
        return {
          status: 410,
          body: "specific",
        };
      }

      handleError(_error: unknown) {
        return {
          status: 500,
          body: "generic",
        };
      }
    }

    Catch(NotFoundError)(
      Errors.prototype,
      "handleNotFound",
      Object.getOwnPropertyDescriptor(Errors.prototype, "handleNotFound")!,
    );

    Catch(Error)(
      Errors.prototype,
      "handleError",
      Object.getOwnPropertyDescriptor(Errors.prototype, "handleError")!,
    );

    Controller("/catch")(Errors);

    const app = await createApplication(testModule([Errors]), {
      configure: (runtime) => runtime.configureHttp({ cors: false }),
    });

    const response = await app.test().get("/catch");

    expect(response.status).toBe(410);
  });

  test("converte erro dentro de catcher", async () => {
    class Errors {
      @Get("/")
      run() {
        throw new Error("source");
      }

      catch(_error: unknown) {
        throw new Error("catcher");
      }
    }

    Catch(Error)(
      Errors.prototype,
      "catch",
      Object.getOwnPropertyDescriptor(Errors.prototype, "catch")!,
    );

    Controller("/catch-error")(Errors);

    const app = await createApplication(testModule([Errors]), {
      configure: (runtime) => runtime.configureHttp({ cors: false }),
    });

    expect((await app.test().get("/catch-error")).status).toBe(500);
  });

  test("usa catcher global quando não há catcher no controller", async () => {
    class GlobalFailure extends HttpError {
      constructor() {
        super(409, "conflict");
      }
    }

    class GlobalErrors {
      @Get("/")
      run() {
        throw new GlobalFailure();
      }
    }

    Controller("/global-errors")(GlobalErrors);

    const app = await createApplication(testModule([GlobalErrors]), {
      configure: (runtime) =>
        runtime
          .configureHttp({ cors: false })
          .catch(GlobalFailure, async (error) => ({
            status: 422,
            body: JSON.stringify({
              handled: error instanceof GlobalFailure,
            }),
          })),
    });

    const response = await app.test().get("/global-errors");

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      handled: true,
    });
  });

  test("aplica catcher global a middleware global", async () => {
    class GlobalFailure extends HttpError {
      constructor() {
        super(409, "conflict");
      }
    }

    class Route {
      @Get("/")
      run() {
        return { ok: true };
      }
    }

    Controller("/global-middleware")(Route);

    const app = await createApplication(testModule([Route]), {
      configure: (runtime) =>
        runtime
          .configureHttp({ cors: false })
          .useMiddleware(async () => {
            throw new GlobalFailure();
          })
          .catch(GlobalFailure, () => ({
            status: 422,
            body: '{"handled":true}',
          })),
    });

    const response = await app.test().get("/global-middleware");

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ handled: true });
  });

  test("isola catchers decorados entre aplicações", async () => {
    class Isolated {
      @Get("/")
      run() {
        throw new Error("source");
      }

      handle(_error: unknown) {
        return { status: 409, body: "caught" };
      }
    }

    Controller("/isolated-catch")(Isolated);

    const first = await createApplication(testModule([Isolated]), {
      configure: (runtime) => runtime.configureHttp({ cors: false }),
    });

    Catch(Error)(
      Isolated.prototype,
      "handle",
      Object.getOwnPropertyDescriptor(Isolated.prototype, "handle")!,
    );

    const second = await createApplication(testModule([Isolated]), {
      configure: (runtime) => runtime.configureHttp({ cors: false }),
    });

    expect((await first.test().get("/isolated-catch")).status).toBe(500);
    expect((await second.test().get("/isolated-catch")).status).toBe(409);
  });
});
