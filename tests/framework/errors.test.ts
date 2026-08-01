import { describe, expect, test } from "bun:test";
import { Catch, Controller, Empilha, Get } from "../../src";
import { HttpError, NotFoundError } from "../../src/errors/index";

describe("Empilha errors", () => {
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

    const app = new Empilha().configureHttp({ cors: false });
    app.validate([Errors]).initialize([Errors]);

    expect((await app.test().get("/errors/http")).status).toBe(418);

    expect((await app.test().get("/errors/unknown")).status).toBe(500);
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

    const app = new Empilha().configureHttp({ cors: false });
    app.validate([Errors]).initialize([Errors]);

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

    const app = new Empilha().configureHttp({ cors: false });
    app.validate([Errors]).initialize([Errors]);

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

    const app = new Empilha()
      .configureHttp({ cors: false })
      .catch(GlobalFailure, async (error) => ({
        status: 422,
        body: JSON.stringify({
          handled: error instanceof GlobalFailure,
        }),
      }));

    app.validate([GlobalErrors]).initialize([GlobalErrors]);

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

    const app = new Empilha()
      .configureHttp({ cors: false })
      .useMiddleware(async () => {
        throw new GlobalFailure();
      })
      .catch(GlobalFailure, () => ({ status: 422, body: '{"handled":true}' }))
      .validate([Route])
      .initialize([Route]);

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

    const first = new Empilha()
      .configureHttp({ cors: false })
      .validate([Isolated])
      .initialize([Isolated]);

    Catch(Error)(
      Isolated.prototype,
      "handle",
      Object.getOwnPropertyDescriptor(Isolated.prototype, "handle")!,
    );

    const second = new Empilha()
      .configureHttp({ cors: false })
      .validate([Isolated])
      .initialize([Isolated]);

    expect((await first.test().get("/isolated-catch")).status).toBe(500);
    expect((await second.test().get("/isolated-catch")).status).toBe(409);
  });
});
