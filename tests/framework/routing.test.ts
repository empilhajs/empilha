import { describe, expect, test } from "bun:test";
import {
  Body,
  Context,
  Controller,
  Delete,
  Empilha,
  Get,
  Header,
  Param,
  Produces,
  Post,
  Query,
  Request as RequestDecorator,
  Returns,
  Status,
  t,
} from "../../src";
import { request as createRequest } from "../helpers/test-utils";

describe("Empilha routing and decorators", () => {
  test("registra controllers e resolve rota sem parâmetros", async () => {
    class Hello {
      @Get("/")
      hello() {
        return { ok: true };
      }
    }

    Controller("/hello")(Hello);

    const app = new Empilha().configureHttp({ cors: false });
    app.validate([Hello]).initialize([Hello]);

    const response = await app.test().get("/hello");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("aguarda rota assíncrona", async () => {
    class AsyncRoute {
      @Get("/")
      async get() {
        return [1, 2, 3];
      }
    }

    Controller("/async")(AsyncRoute);

    const app = new Empilha().configureHttp({ cors: false });
    app.validate([AsyncRoute]).initialize([AsyncRoute]);

    expect(await (await app.test().get("/async")).json()).toEqual([1, 2, 3]);
  });

  test("injeta Request, Param, Query e Header", async () => {
    class Echo {
      run(
        request: {
          method: string;
          body: { name: string };
          params: Record<string, string>;
          query: Record<string, string>;
          headers: Record<string, string>;
        },
        id: string,
        page: string,
        token: string,
      ) {
        return {
          method: request.method,
          name: request.body.name,
          id,
          page,
          token,
        };
      }
    }

    RequestDecorator()(Echo.prototype, "run", 0);
    Param("id")(Echo.prototype, "run", 1);
    Query("page")(Echo.prototype, "run", 2);
    Header("X-Token")(Echo.prototype, "run", 3);

    Post("/:id")(
      Echo.prototype,
      "run",
      Object.getOwnPropertyDescriptor(Echo.prototype, "run")!,
    );

    Controller("/echo")(Echo);

    const app = new Empilha().configureHttp({ cors: false });
    app.validate([Echo]).initialize([Echo]);

    const http = (
      app as unknown as {
        http: {
          handleRequest(value: Request): Response | Promise<Response>;
        };
      }
    ).http;

    const response = await http.handleRequest(
      createRequest("/echo/7?page=2", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-token": "abc",
        },
        body: JSON.stringify({
          name: "Ana",
        }),
      }),
    );

    expect(response.status).toBe(201);

    expect(await response.json()).toEqual({
      method: "POST",
      name: "Ana",
      id: "7",
      page: "2",
      token: "abc",
    });
  });

  test("Body injeta e valida body quando schema foi declarado", async () => {
    const schema = t.Object({
      name: t.String(),
    });

    class Loose {
      create(request: { body: unknown }) {
        return request.body;
      }
    }

    RequestDecorator()(Loose.prototype, "create", 0);

    Post("/")(
      Loose.prototype,
      "create",
      Object.getOwnPropertyDescriptor(Loose.prototype, "create")!,
    );

    Controller("/loose")(Loose);

    class Strict {
      create(body: unknown) {
        return body;
      }
    }

    Body(schema)(Strict.prototype, "create", 0);

    Post("/")(
      Strict.prototype,
      "create",
      Object.getOwnPropertyDescriptor(Strict.prototype, "create")!,
    );

    Controller("/strict")(Strict);

    const app = new Empilha().configureHttp({ cors: false });
    app.validate([Loose, Strict]).initialize([Loose, Strict]);

    expect(
      (
        await app.test().post("/loose", {
          name: 123,
        })
      ).status,
    ).toBe(201);

    const invalidResponse = await app.test().post("/strict", {
      name: 123,
    });

    expect(invalidResponse.status).toBe(400);
    expect(await invalidResponse.json()).toEqual({
      errors: [
        {
          path: "/name",
          message: "Expected string",
        },
      ],
    });
  });

  test("injeta contexto isolado por requisição", async () => {
    class ContextRoute {
      @Get("/")
      async get(context: { requestId: string }) {
        await Promise.resolve();
        return {
          requestId: context.requestId,
        };
      }
    }

    Context()(ContextRoute.prototype, "get", 0);
    Controller("/context")(ContextRoute);

    const app = new Empilha().configureHttp({ cors: false });
    app.validate([ContextRoute]).initialize([ContextRoute]);

    const [first, second] = await Promise.all([
      app.test().get("/context"),
      app.test().get("/context"),
    ]);

    const firstBody = (await first.json()) as { requestId: string };
    const secondBody = (await second.json()) as { requestId: string };

    expect(firstBody.requestId).toBeString();
    expect(secondBody.requestId).toBeString();
    expect(firstBody.requestId).not.toBe(secondBody.requestId);
  });

  test("Produces, Returns e Status produzem a resposta declarada", async () => {
    const schema = t.Object({
      ok: t.Boolean(),
    });

    class Features {
      @Get("/json")
      @Returns(schema)
      @Status(202)
      json() {
        return { ok: true };
      }

      @Get("/text")
      @Produces("text/plain")
      text() {
        return "hello";
      }
    }

    Controller("/features")(Features);

    const app = new Empilha().configureHttp({ cors: false });
    app.validate([Features]).initialize([Features]);

    const jsonResponse = await app.test().get("/features/json");

    expect(jsonResponse.status).toBe(202);
    expect(await jsonResponse.json()).toEqual({ ok: true });

    const textResponse = await app.test().get("/features/text");

    expect(await textResponse.text()).toBe("hello");
  });

  test("usa DELETE 204 sem corpo e preserva Produces e Server", async () => {
    class Items {
      @Delete("/")
      remove() {
        return { deleted: true };
      }

      @Get("/text")
      @Produces("text/plain")
      text() {
        return "Hello, World!";
      }
    }

    Controller("/items")(Items);

    const app = new Empilha().configureHttp({
      cors: false,
      serverHeader: "Test",
    });

    app.validate([Items]).initialize([Items]);

    const deleted = await app.test().delete("/items");

    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");

    const text = await app.test().get("/items/text");

    expect(text.headers.get("content-type")).toContain("text/plain");

    expect(text.headers.get("server")).toBe("Test");

    expect(await text.text()).toBe("Hello, World!");
  });

  test("não executa handler durante registro e rejeita parâmetro sem decorator", async () => {
    let executions = 0;

    class Dynamic {
      @Get("/")
      get() {
        executions++;
        return { executions };
      }
    }

    Controller("/dynamic")(Dynamic);

    const app = new Empilha().configureHttp({ cors: false });
    app.validate([Dynamic]).initialize([Dynamic]);

    expect(executions).toBe(0);

    await app.test().get("/dynamic");

    expect(executions).toBe(1);

    class Invalid {
      get(_unused: string, id: string) {
        return id;
      }
    }

    Param("id")(Invalid.prototype, "get", 1);

    Get("/")(
      Invalid.prototype,
      "get",
      Object.getOwnPropertyDescriptor(Invalid.prototype, "get")!,
    );

    Controller("/invalid")(Invalid);

    expect(() => {
      new Empilha().validate([Invalid]).initialize([Invalid]);
    }).toThrow("parâmetro 0");
  });

  test("isola o snapshot de metadata entre aplicações", async () => {
    class Routes {
      @Get("/one")
      one() {
        return { route: "one" };
      }

      two() {
        return { route: "two" };
      }
    }

    Controller("/snapshot")(Routes);

    const first = new Empilha()
      .configureHttp({ cors: false })
      .validate([Routes])
      .initialize([Routes]);

    Get("/two")(
      Routes.prototype,
      "two",
      Object.getOwnPropertyDescriptor(Routes.prototype, "two")!,
    );

    const second = new Empilha()
      .configureHttp({ cors: false })
      .validate([Routes])
      .initialize([Routes]);

    expect((await first.test().get("/snapshot/two")).status).toBe(404);
    expect((await second.test().get("/snapshot/two")).status).toBe(200);
  });
});
