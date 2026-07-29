import { describe, expect, test } from "bun:test";
import {
  Controller,
  Empilha,
  Get,
  Post,
  requestLogger,
  Use,
  type MiddlewareFn,
} from "../../src";

describe("Empilha scoped middleware", () => {
  test("requestLogger registra método, rota, status e duração", async () => {
    const entries: Array<{
      method: string;
      pathname: string;
      status: number;
      durationMs: number;
    }> = [];

    @Controller("/logged")
    class LoggedRoute {
      @Get("/")
      get() {
        return { ok: true };
      }
    }

    const app = new Empilha()
      .configureHttp({ cors: false })
      .use(requestLogger((entry) => entries.push(entry)))
      .validate([LoggedRoute])
      .initialize([LoggedRoute]);

    expect((await app.test().get("/logged")).status).toBe(200);
    expect(entries).toEqual([
      expect.objectContaining({
        method: "GET",
        pathname: "/logged",
        status: 200,
      }),
    ]);
    expect(entries[0].durationMs).toBeGreaterThanOrEqual(0);
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

    const app = new Empilha()
      .configureHttp({ cors: false })
      .use(globalMiddleware)
      .validate([Routes])
      .initialize([Routes]);

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

    const app = new Empilha()
      .configureHttp({ cors: false })
      .validate([Permissions])
      .initialize([Permissions]);

    expect((await app.test().get("/permissions/public")).status).toBe(200);
    expect((await app.test().get("/permissions/private")).status).toBe(403);
  });
});
