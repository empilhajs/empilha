import { describe, expect, test } from "bun:test";
import {
  Catch,
  Controller,
  Delete,
  Empilha,
  Get,
  HttpError,
  Param,
  Produces,
  Query,
  Header,
  Returns,
  t,
} from "../../src";

describe("Empilha request pipeline", () => {
  async function responseSnapshot(response: Response) {
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: await response.text(),
    };
  }

  test("resolve rota estática", async () => {
    class Health {
      @Get("/")
      get() {
        return {
          ok: true,
        };
      }
    }

    Controller("/health")(Health);

    const app = new Empilha().configureHttp({ cors: false });

    app.validate([Health]).initialize([Health]);

    const response = await app.test().get("/health");

    expect(response.status).toBe(200);
  });

  test("resolve rota dinâmica com parâmetro convertido", async () => {
    class Users {
      @Get("/:id")
      get(id: number) {
        return {
          id,
        };
      }
    }

    Param("id", Number)(Users.prototype, "get", 0);

    Controller("/users")(Users);

    const app = new Empilha().configureHttp({ cors: false });

    app.validate([Users]).initialize([Users]);

    const response = await app.test().get("/users/42");

    expect(await response.json()).toEqual({
      id: 42,
    });
  });

  test("resolve query e header sem request completo", async () => {
    class Search {
      @Get("/")
      find(query: string, token: string) {
        return { query, token };
      }
    }

    Query("q")(Search.prototype, "find", 0);
    Header("x-token")(Search.prototype, "find", 1);
    Controller("/search")(Search);

    const app = new Empilha()
      .configureHttp({ cors: false })
      .validate([Search])
      .initialize([Search]);
    const response = await app.test().get("/search?q=books", {
      headers: { "x-token": "secret" },
    });

    expect(await response.json()).toEqual({
      query: "books",
      token: "secret",
    });
  });

  test("mantém respostas e erros equivalentes com middleware global", async () => {
    const responseSchema = t.Object({
      ok: t.Boolean(),
    });

    class Routes {
      @Get("/sync")
      sync() {
        return {
          ok: true,
        };
      }

      @Get("/async")
      async asyncRoute() {
        await Promise.resolve();
        return {
          ok: true,
        };
      }

      @Get("/text")
      @Produces("text/plain")
      text() {
        return "hello";
      }

      @Delete("/empty")
      empty() {
        return {
          ignored: true,
        };
      }

      @Get("/schema")
      @Returns(responseSchema)
      schema() {
        return {
          ok: true,
        };
      }

      @Get("/http-error")
      httpError() {
        throw new HttpError(418, "teapot");
      }

      @Get("/rejection")
      async rejection() {
        throw new Error("rejected");
      }

      @Get("/caught")
      caught() {
        throw new RangeError("range");
      }

      @Catch(RangeError)
      catchRange() {
        return {
          status: 409,
          body: "caught",
        };
      }
    }

    Controller("/parity")(Routes);

    const withoutMiddleware = new Empilha()
      .configureHttp({ cors: false })
      .validate([Routes])
      .initialize([Routes]);

    const normal = new Empilha()
      .configureHttp({ cors: false })
      .use(async (_request, next) => next())
      .validate([Routes])
      .initialize([Routes]);

    for (const path of [
      "/sync",
      "/async",
      "/text",
      "/empty",
      "/schema",
      "/http-error",
      "/rejection",
      "/caught",
    ]) {
      const method = path === "/empty" ? "delete" : "get";

      const withoutMiddlewareResponse =
        method === "delete"
          ? await withoutMiddleware.test().delete(`/parity${path}`)
          : await withoutMiddleware.test().get(`/parity${path}`);

      const normalResponse =
        method === "delete"
          ? await normal.test().delete(`/parity${path}`)
          : await normal.test().get(`/parity${path}`);

      expect(await responseSnapshot(withoutMiddlewareResponse)).toEqual(
        await responseSnapshot(normalResponse),
      );
    }
  });

  test("preserva validação, encoding, prioridade e backtracking", async () => {
    const idSchema = t.String({
      pattern: "^[0-9]+$",
    });

    class Routes {
      @Get("/number/:id")
      number(
        @Param("id", Number)
        id: number,
      ) {
        return {
          id,
        };
      }

      @Get("/validated/:id")
      validated(
        @Param("id", idSchema)
        id: string,
      ) {
        return {
          id,
        };
      }

      @Get("/encoded/:value")
      encoded(
        @Param("value")
        value: string,
      ) {
        return {
          value,
        };
      }

      @Get("/files/static/end")
      staticEnd() {
        return "static";
      }

      @Get("/files/:name/edit")
      parameterEdit(
        @Param("name")
        name: string,
      ) {
        return name;
      }
    }

    Controller("/routing-parity")(Routes);

    const withoutMiddleware = new Empilha()
      .configureHttp({ cors: false })
      .validate([Routes])
      .initialize([Routes]);

    const normal = new Empilha()
      .configureHttp({ cors: false })
      .use(async (_request, next) => next())
      .validate([Routes])
      .initialize([Routes]);

    for (const path of [
      "/number/2",
      "/validated/invalid",
      "/encoded/a%20b",
      "/files/static/end",
      "/files/static/edit",
    ]) {
      const withoutMiddlewareResponse = await withoutMiddleware
        .test()
        .get(`/routing-parity${path}`);
      const normalResponse = await normal.test().get(`/routing-parity${path}`);

      expect(await responseSnapshot(withoutMiddlewareResponse)).toEqual(
        await responseSnapshot(normalResponse),
      );
    }

    expect(
      await (
        await withoutMiddleware.test().get("/routing-parity/encoded/a%20b")
      ).json(),
    ).toEqual({
      value: "a b",
    });

    expect(
      await (
        await withoutMiddleware.test().get("/routing-parity/files/static/edit")
      ).json(),
    ).toBe("static");
  });
});
