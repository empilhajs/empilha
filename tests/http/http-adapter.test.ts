import { describe, expect, test } from "bun:test";
import { Container, HttpAdapter } from "../../src";
import { request } from "../helpers/test-utils";

describe("HttpAdapter", () => {
  test("atende rota estática e dinâmica", async () => {
    const adapter = new HttpAdapter();

    adapter.get("/static", () => ({
      status: 200,
      body: '{"ok":true}',
    }));

    adapter.get("/users/:id", (req) => ({
      status: 200,
      body: req.params.id,
    }));

    const staticResponse = await adapter.handleRequest(request("/static"));

    const dynamicResponse = await adapter.handleRequest(request("/users/42"));

    expect(staticResponse.status).toBe(200);
    expect(await dynamicResponse.text()).toBe("42");
  });

  test("registra texto e JSON estáticos", async () => {
    const adapter = new HttpAdapter();

    adapter.getText("/text", "Hi", { "X-Test": "static" });
    adapter.getJson("/json-static", { ok: true });

    const firstText = await adapter.handleRequest(request("/text"));
    const secondText = await adapter.handleRequest(request("/text"));
    const json = await adapter.handleRequest(request("/json-static"));

    expect(await firstText.text()).toBe("Hi");
    expect(await secondText.text()).toBe("Hi");
    expect(firstText.headers.get("content-type")).toContain("text/plain");
    expect(firstText.headers.get("x-test")).toBe("static");
    expect(await json.json()).toEqual({ ok: true });
  });

  test("documenta a captura e os limites de serialização do getJson", async () => {
    const adapter = new HttpAdapter();
    const value = { ok: true };

    adapter.getJson("/captured", value);
    value.ok = false;

    const captured = await adapter.handleRequest(request("/captured"));
    expect(await captured.json()).toEqual({ ok: true });

    adapter.getJson("/undefined", undefined);
    const undefinedResponse = await adapter.handleRequest(
      request("/undefined"),
    );
    expect(await undefinedResponse.text()).toBe("null");

    expect(() => adapter.getJson("/bigint", 1n)).toThrow(TypeError);
    expect(() =>
      adapter.getJson(
        "/circular",
        (() => {
          const circular: { self?: unknown } = {};
          circular.self = circular;
          return circular;
        })(),
      ),
    ).toThrow(TypeError);
  });

  test("aplica headers comuns nas conveniências", async () => {
    const adapter = new HttpAdapter();

    adapter.enableCors();
    adapter.setServerHeader("Audit");
    adapter.getText("/text", "Hi");
    adapter.getJson("/json", { ok: true });

    const text = await adapter.handleRequest(request("/text"));
    const json = await adapter.handleRequest(request("/json"));

    expect(text.headers.get("server")).toBe("Audit");
    expect(json.headers.get("server")).toBe("Audit");
    expect(text.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("rejeita resposta estática parametrizada", () => {
    const adapter = new HttpAdapter();

    expect(() => adapter.getText("/users/:id", "ok")).toThrow(
      "Respostas estáticas não podem usar parâmetros de rota.",
    );
  });

  test("usa as conveniências de query e JSON no pipeline comum", async () => {
    const adapter = new HttpAdapter();

    adapter.getQueryText(
      "/users/:id",
      (params, query) => `${params.id}:${query.name}`,
    );
    adapter.postJson("/echo", (body) => body);

    const query = await adapter.handleRequest(request("/users/42?name=bun"));
    const body = await adapter.handleRequest(
      request("/echo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      }),
    );
    expect(await query.text()).toBe("42:bun");
    expect(await body.json()).toEqual({ hello: "world" });
  });

  test("converte erro síncrono e Promise rejeitada para 500", async () => {
    const adapter = new HttpAdapter();

    adapter.get("/sync", () => {
      throw new Error("boom");
    });

    adapter.get("/async", async () => {
      throw new Error("boom");
    });

    const syncResponse = await adapter.handleRequest(request("/sync"));

    const asyncResponse = await adapter.handleRequest(request("/async"));

    expect(syncResponse.status).toBe(500);
    expect(asyncResponse.status).toBe(500);
  });

  test("usa fallback 500 quando o error handler falha durante leitura do body", async () => {
    const adapter = new HttpAdapter();
    adapter.setErrorHandler(async () => {
      throw new Error("error handler failed");
    });

    const handler = () => ({ status: 200, body: "ok" });
    Object.assign(handler, { needsBody: true });
    adapter.post("/body-error", handler);

    const stream = new ReadableStream({
      pull() {
        throw new Error("body read failed");
      },
    });
    const response = await adapter.handleRequest(
      new Request("http://test/body-error", {
        method: "POST",
        body: stream,
        duplex: "half",
      } as RequestInit),
    );

    expect(response.status).toBe(500);
  });

  test("não pendura quando o error handler rejeita com timeout ativo", async () => {
    const adapter = new HttpAdapter();
    adapter.setHandlerTimeout(20);
    adapter.setErrorHandler(async () => {
      throw new Error("error handler failed");
    });

    adapter.get("/async-error", async () => {
      throw new Error("handler failed");
    });

    const response = await adapter.handleRequest(request("/async-error"));

    expect(response.status).toBe(500);

    await adapter.close();
  });

  test("reverte o contador quando a factory do scope falha", async () => {
    const adapter = new HttpAdapter();
    adapter.setRequestScopeFactory(() => {
      throw new Error("scope failed");
    });
    adapter.use(async (_request, next) => next());
    adapter.get("/scope", () => ({ status: 200, body: "ok" }));

    await expect(
      Promise.resolve().then(() => adapter.handleRequest(request("/scope"))),
    ).rejects.toThrow("scope failed");

    adapter.setRequestScopeFactory(() => new Container());

    const response = await adapter.handleRequest(request("/scope"));

    expect(response.status).toBe(200);

    await adapter.close();
  });

  test("close aguarda handler stateless assíncrono", async () => {
    let finish!: () => void;
    const blocker = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const handler = async () => {
      await blocker;
      return { status: 200, body: "ok" };
    };

    const adapter = new HttpAdapter();
    adapter.get("/stateless", handler);

    const responsePromise = adapter.handleRequest(request("/stateless"));
    let closed = false;
    const closePromise = adapter.close().then(() => {
      closed = true;
    });

    await Promise.resolve();
    expect(closed).toBe(false);

    finish();
    expect((await responsePromise).status).toBe(200);
    await closePromise;
    expect(closed).toBe(true);
  });

  test("aplica, desabilita e responde preflight CORS", async () => {
    const adapter = new HttpAdapter();
    adapter.enableCors();

    adapter.get("/cors", () => ({
      status: 200,
      body: "{}",
    }));

    const corsResponse = await adapter.handleRequest(request("/cors"));

    expect(corsResponse.headers.get("access-control-allow-origin")).toBe("*");

    const preflightResponse = await adapter.handleRequest(
      request("/cors", {
        method: "OPTIONS",
      }),
    );

    expect(preflightResponse.status).toBe(204);

    adapter.disableCors();

    const disabledCorsResponse = await adapter.handleRequest(request("/cors"));

    expect(
      disabledCorsResponse.headers.get("access-control-allow-origin"),
    ).toBeNull();
  });

  test("preserva CORS em erros e envia Server", async () => {
    const adapter = new HttpAdapter();

    adapter.enableCors();
    adapter.setServerHeader("Test");

    const response = await adapter.handleRequest(request("/missing"));

    expect(response.status).toBe(404);
    expect(response.headers.get("server")).toBe("Test");

    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("valida JSON, body vazio, limite com e sem Content-Length", async () => {
    const adapter = new HttpAdapter();

    adapter.setMaxBodyBytes(5);

    const bodyHandler = (req: { body: unknown }) => ({
      status: 200,
      body: JSON.stringify(req.body),
    });

    bodyHandler.needsBody = true;

    adapter.post("/body", bodyHandler);

    const invalidJsonResponse = await adapter.handleRequest(
      request("/body", {
        method: "POST",
        body: "{",
      }),
    );

    expect(invalidJsonResponse.status).toBe(400);

    const emptyBodyResponse = await adapter.handleRequest(
      request("/body", {
        method: "POST",
      }),
    );

    expect(emptyBodyResponse.status).toBe(200);

    const contentLengthResponse = await adapter.handleRequest(
      request("/body", {
        method: "POST",
        body: JSON.stringify({
          long: true,
        }),
      }),
    );

    expect(contentLengthResponse.status).toBe(413);

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("123456"));

        controller.close();
      },
    });

    const streamedBodyResponse = await adapter.handleRequest(
      request("/body", {
        method: "POST",
        body: stream,
      }),
    );

    expect(streamedBodyResponse.status).toBe(413);
  });

  test("aplica o limite ao body real mesmo com Content-Length incorreto", async () => {
    const adapter = new HttpAdapter();
    adapter.setMaxBodyBytes(5);

    const bodyHandler = (req: { body: unknown }) => ({
      status: 200,
      body: JSON.stringify(req.body),
    });
    bodyHandler.needsBody = true;
    adapter.post("/false-length", bodyHandler);

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("123456"));
        controller.close();
      },
    });

    const response = await adapter.handleRequest(
      request("/false-length", {
        method: "POST",
        headers: { "content-length": "1" },
        body: stream,
      }),
    );

    expect(response.status).toBe(413);
  });

  test("getFile não força content type JSON", async () => {
    const adapter = new HttpAdapter();
    adapter.getFile("/file", Bun.file("package.json"));

    const response = await adapter.handleRequest(request("/file"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).not.toBe("application/json");
  });

  test("mantém a semântica JSON do writer para vazio e BOM", async () => {
    const adapter = new HttpAdapter();
    adapter.postJson("/json", (body) => body);

    const empty = await adapter.handleRequest(
      request("/json", { method: "POST" }),
    );
    const bom = await adapter.handleRequest(
      request("/json", {
        method: "POST",
        body: "\uFEFF{}",
      }),
    );

    expect(empty.status).toBe(200);
    expect(await empty.text()).toBe("null");
    expect(bom.status).toBe(200);
    expect(await bom.text()).toBe("{}");
  });

  test("aplica timeout durante a leitura do body", async () => {
    const adapter = new HttpAdapter();
    adapter.setBodyTimeout(5);

    const bodyHandler = (req: { body: unknown }) => ({
      status: 200,
      body: JSON.stringify(req.body),
    });

    bodyHandler.needsBody = true;
    adapter.post("/body-timeout", bodyHandler);

    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });

    const response = await adapter.handleRequest(
      request("/body-timeout", {
        method: "POST",
        body: stream,
      }),
    );

    expect(response.status).toBe(408);
    expect(cancelled).toBe(true);

    await adapter.close();
  });

  test("executa middlewares em ordem, permite interromper e detecta next duplicado", async () => {
    const adapter = new HttpAdapter();
    const order: string[] = [];

    adapter.use(async (_req, next) => {
      order.push("one");

      const response = await next();

      order.push("one-after");

      return response;
    });

    adapter.use(async (_req, next) => {
      order.push("two");

      return next();
    });

    adapter.get("/ok", () => {
      order.push("handler");

      return {
        status: 200,
        body: "ok",
      };
    });

    const response = await adapter.handleRequest(request("/ok"));

    expect(response.status).toBe(200);

    expect(order).toEqual(["one", "two", "handler", "one-after"]);

    const stopped = new HttpAdapter();

    stopped.use(async () => ({
      status: 401,
      body: "stop",
    }));

    stopped.get("/x", () => ({
      status: 200,
      body: "x",
    }));

    const stoppedResponse = await stopped.handleRequest(request("/x"));

    expect(stoppedResponse.status).toBe(401);

    const twice = new HttpAdapter();

    twice.use(async (_req, next) => {
      await next();

      return next();
    });

    twice.get("/x", () => ({
      status: 200,
      body: "x",
    }));

    const twiceResponse = await twice.handleRequest(request("/x"));

    expect(twiceResponse.status).toBe(500);
  });
});
