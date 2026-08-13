import { describe, expect, test } from "bun:test";
import {
  Controller,
  createApplication,
  Get,
  Post,
  requestLogger,
  Use,
  type MiddlewareFn,
} from "../../src";
import { testModule } from "../helpers/test-utils";

describe("Empilha scoped middleware", () => {
  test("requestLogger registra método, rota, status e duração", async () => {
    const entries: Array<{
      method: string;
      pathname: string;
      status: number;
      durationMs: number;
      requestId: string;
    }> = [];

    @Controller("/logged")
    class LoggedRoute {
      @Get("/")
      get() {
        return { ok: true };
      }
    }

    const app = await createApplication(testModule([LoggedRoute]), {
      configure: (runtime) =>
        runtime
          .configureHttp({ cors: false })
          .useMiddleware(requestLogger((entry) => entries.push(entry))),
    });

    expect((await app.test().get("/logged")).status).toBe(200);
    expect(entries).toEqual([
      expect.objectContaining({
        method: "GET",
        pathname: "/logged",
        status: 200,
      }),
    ]);
    expect(entries[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(entries[0].requestId).toBeString();
  });

  test("executa global, controller e rota na ordem declarada", async () => {
    const order: string[] = [];

    const globalMiddleware: MiddlewareFn = async (_request, next) => {
      order.push("global");
      const response = await next();
      order.push("global-after");
      return response;
    };

    const controllerMiddleware: MiddlewareFn = async (_request, next) => {
      order.push("controller");
      const response = await next();
      order.push("controller-after");
      return response;
    };

    const routeMiddleware: MiddlewareFn = async (request, next) => {
      order.push(
        `${request.query.page}:${request.headers["x-token"]}:${String(
          (request.body as { name: string }).name,
        )}`,
      );
      const response = await next();
      order.push("route-after");
      return response;
    };

    @Use(controllerMiddleware)
    @Controller("/middleware")
    class Routes {
      @Post("/")
      @Use(routeMiddleware)
      create() {
        order.push("handler");
        return {
          ok: true,
        };
      }
    }

    const app = await createApplication(testModule([Routes]), {
      configure: (runtime) =>
        runtime.configureHttp({ cors: false }).useMiddleware(globalMiddleware),
    });

    const response = await app.test().post(
      "/middleware?page=2",
      {
        name: "Ada",
      },
      {
        headers: {
          "x-token": "secret",
        },
      },
    );

    expect(response.status).toBe(201);
    expect(order).toEqual([
      "global",
      "controller",
      "2:secret:Ada",
      "handler",
      "route-after",
      "controller-after",
      "global-after",
    ]);
  });

  test("permite short-circuit apenas na rota decorada", async () => {
    const deny: MiddlewareFn = async () => ({
      status: 403,
      body: JSON.stringify({
        error: "forbidden",
      }),
    });

    @Controller("/permissions")
    class Permissions {
      @Get("/public")
      publicRoute() {
        return {
          public: true,
        };
      }

      @Get("/private")
      @Use(deny)
      privateRoute() {
        return {
          private: true,
        };
      }
    }

    const app = await createApplication(testModule([Permissions]), {
      configure: (runtime) => runtime.configureHttp({ cors: false }),
    });

    expect((await app.test().get("/permissions/public")).status).toBe(200);
    expect((await app.test().get("/permissions/private")).status).toBe(403);
  });

  test("preserva a ordem visual de múltiplos Use no mesmo método", async () => {
    const order: string[] = [];
    const first: MiddlewareFn = async (_request, next) => {
      order.push("first");
      const response = await next();
      order.push("first-after");
      return response;
    };
    const second: MiddlewareFn = async (_request, next) => {
      order.push("second");
      const response = await next();
      order.push("second-after");
      return response;
    };

    @Controller("/multiple-use")
    class MultipleUse {
      @Get("/")
      @Use(first)
      @Use(second)
      get() {
        order.push("handler");
        return { ok: true };
      }
    }

    const app = await createApplication(testModule([MultipleUse]), {
      configure: (runtime) => runtime.configureHttp({ cors: false }),
    });

    expect((await app.test().get("/multiple-use")).status).toBe(200);
    expect(order).toEqual([
      "first",
      "second",
      "handler",
      "second-after",
      "first-after",
    ]);
  });
});
