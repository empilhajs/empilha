import { describe, expect, test } from "bun:test";
import { Container, HttpAdapter, requestContext } from "../../src";
import { JsonBodyReader } from "../../src/http";
import { ApplicationEvents } from "../../src/runtime";
import { request, testPort } from "../helpers/test-utils";

function nativeResponseHeaders(response: Response, name: string): string[] {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  return name === "set-cookie"
    ? (headers.getSetCookie?.() ?? [])
    : [response.headers.get(name) ?? ""];
}

describe("HttpAdapter", () => {
  test("não cria scope para rota stateless sem timeout", async () => {
    const adapter = new HttpAdapter();
    let scopesCreated = 0;

    adapter.setHandlerTimeout(null);
    adapter.setRequestScopeFactory(() => {
      scopesCreated++;
      return new Container();
    });
    adapter.getText("/stateless", "ok");

    const response = await adapter.handleRequest(request("/stateless"));

    expect(response.status).toBe(200);
    expect(scopesCreated).toBe(0);
  });

  test("adiciona X-Request-Id no fallback sem scope", async () => {
    const adapter = new HttpAdapter();
    adapter.setHandlerTimeout(null);
    adapter.get("/request-id", () => ({ status: 200, body: "ok" }));

    const response = await adapter.handleRequest(request("/request-id"));

    expect(response.headers.get("x-request-id")).toMatch(
      /^[0-9a-z]+-[0-9a-z]+-[0-9a-z]+$/,
    );
  });

  test("remove o corpo no fallback HEAD e aplica headers à Response nativa", async () => {
    const adapter = new HttpAdapter();
    adapter.setHandlerTimeout(null);
    adapter.enableCors("https://example.test");
    adapter.setServerHeader("Empilha");
    adapter.get("/head", () => "hello");
    adapter.head("/explicit-head", () => "explicit");
    adapter.getJson("/json-head", { ok: true });
    adapter.get("/error-head", () => {
      throw new Error("head error");
    });
    adapter.get("/native", () => new Response("ok"));
    adapter.get("/native-head", () => new Response("hello"));
    adapter.get(
      "/stream-head",
      () =>
        new Response(
          new ReadableStream({ start: (controller) => controller.close() }),
          {
            headers: { "Content-Type": "application/octet-stream" },
          },
        ),
    );
    adapter.get("/native-cookies", () => {
      const headers = new Headers();
      headers.append("Set-Cookie", "a=1");
      headers.append("Set-Cookie", "b=2");
      return new Response("ok", { headers });
    });
    adapter.get("/native-locked", () => {
      const response = new Response("locked");
      void response.text();
      return response;
    });

    const head = await adapter.handleRequest(
      request("/head", { method: "HEAD" }),
    );
    const native = await adapter.handleRequest(request("/native"));
    const nativeHead = await adapter.handleRequest(
      request("/native-head", { method: "HEAD" }),
    );
    const explicitHead = await adapter.handleRequest(
      request("/explicit-head", { method: "HEAD" }),
    );
    const jsonHead = await adapter.handleRequest(
      request("/json-head", { method: "HEAD" }),
    );
    const streamHead = await adapter.handleRequest(
      request("/stream-head", { method: "HEAD" }),
    );
    const errorHead = await adapter.handleRequest(
      request("/error-head", { method: "HEAD" }),
    );

    expect(await head.text()).toBe("");
    expect(await explicitHead.text()).toBe("");
    expect(jsonHead.headers.get("content-length")).toBe("11");
    expect(await jsonHead.text()).toBe("");
    expect(await streamHead.text()).toBe("");
    expect(errorHead.status).toBe(500);
    expect(await errorHead.text()).toBe("");
    expect(native.headers.get("access-control-allow-origin")).toBe(
      "https://example.test",
    );
    expect(native.headers.get("server")).toBe("Empilha");
    expect(nativeHead.headers.get("content-length")).toBe("5");
    const cookies = nativeResponseHeaders(
      await adapter.handleRequest(request("/native-cookies")),
      "set-cookie",
    );
    expect(cookies).toEqual(["a=1", "b=2"]);
    expect(
      (await adapter.handleRequest(request("/native-locked"))).status,
    ).toBe(500);
  });

  test("rejeita requests que excedem o limite de headers", async () => {
    const adapter = new HttpAdapter();
    adapter.setMaxHeaderCount(1);
    adapter.get("/limited-headers", () => ({ status: 200, body: "ok" }));

    const response = await adapter.handleRequest(
      request("/limited-headers", {
        headers: { "X-First": "one", "X-Second": "two" },
      }),
    );

    expect(response.status).toBe(431);
  });

  test("permite desabilitar X-Request-Id no fallback e na rota nativa", async () => {
    const fallback = new HttpAdapter();
    fallback.setRequestIdEnabled(false);
    fallback.get("/request-id", () => ({ status: 200, body: "ok" }));
    expect(
      (await fallback.handleRequest(request("/request-id"))).headers.get(
        "x-request-id",
      ),
    ).toBeNull();

    const native = new HttpAdapter();
    native.setHandlerTimeout(null);
    native.setRequestIdEnabled(false);
    native.get("/request-id", () => ({ status: 200, body: "ok" }));
    await native.listen(testPort());
    try {
      expect(
        (await fetch(`${native.url}request-id`)).headers.get("x-request-id"),
      ).toBeNull();
    } finally {
      await native.close();
    }
  });

  test("preserva params de rota nativa ao adicionar X-Request-Id", async () => {
    const adapter = new HttpAdapter();
    adapter.disableCors();
    adapter.setHandlerTimeout(null);
    adapter.setRequestIdGenerator(() => "native-param-request-id");
    adapter.getQueryText(
      "/native-params/:id",
      (params, query) => `${params.id} ${query.name}`,
    );

    await adapter.listen(testPort());
    try {
      const response = await fetch(`${adapter.url}native-params/42?name=bun`);
      expect(await response.text()).toBe("42 bun");
      expect(response.headers.get("x-request-id")).toBe(
        "native-param-request-id",
      );
    } finally {
      await adapter.close();
    }
  });

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

  test("registra handlers explícitos para HEAD e OPTIONS", async () => {
    const adapter = new HttpAdapter();
    adapter.head("/resource", () => ({ status: 204, body: "" }));
    adapter.options("/resource", () => ({ status: 200, body: "options" }));

    expect(
      (await adapter.handleRequest(request("/resource", { method: "HEAD" })))
        .status,
    ).toBe(204);
    expect(
      await (
        await adapter.handleRequest(request("/resource", { method: "OPTIONS" }))
      ).text(),
    ).toBe("options");
  });

  test("responde 405 e Allow quando o caminho existe para outro método", async () => {
    const adapter = new HttpAdapter();
    adapter.get("/users", () => ({ status: 200, body: "ok" }));
    adapter.post("/users", () => ({ status: 201, body: "created" }));

    const response = await adapter.handleRequest(
      new Request("http://localhost/users", { method: "DELETE" }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD, POST");
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

  test("timeout sem scope responde 504 e mantém o request rastreado até o fim", async () => {
    const adapter = new HttpAdapter();
    adapter.setHandlerTimeout(5);
    adapter.setShutdownTimeout(20);
    let scopesCreated = 0;
    let signal: AbortSignal | undefined;
    adapter.setRequestScopeFactory(() => {
      scopesCreated++;
      return new Container();
    });
    let finish!: () => void;
    const original = new Promise<Response>((resolve) => {
      finish = () => resolve(new Response("late"));
    });
    adapter.get("/never", (serverRequest) => {
      signal = serverRequest.signal;
      return original;
    });

    const response = await adapter.handleRequest(request("/never"));
    expect(response.status).toBe(504);
    expect(scopesCreated).toBe(0);
    expect(signal?.aborted).toBe(true);

    const started = performance.now();
    await expect(adapter.close()).rejects.toThrow("Timeout ao drenar");
    expect(performance.now() - started).toBeLessThan(100);

    finish();
    await adapter.close();
  });

  test("timeout preserva o scope até a Promise original terminar", async () => {
    const adapter = new HttpAdapter();
    adapter.setHandlerTimeout(5);
    adapter.setShutdownTimeout(20);
    let finish!: () => void;
    const original = new Promise<Response>((resolve) => {
      finish = () => resolve(new Response("late"));
    });
    const handler = () => original;
    Object.assign(handler, { requiresRequestContext: true });
    adapter.get("/never", handler);

    const response = await adapter.handleRequest(request("/never"));
    expect(response.status).toBe(504);

    const started = performance.now();
    await expect(adapter.close()).rejects.toThrow("Timeout ao drenar");
    expect(performance.now() - started).toBeLessThan(100);

    finish();
    await adapter.close();
  });

  test("propaga o abort do cliente para o request scope", async () => {
    const adapter = new HttpAdapter();
    adapter.setHandlerTimeout(null);
    const client = new AbortController();
    const reason = new Error("client disconnected");
    let receivedReason: unknown;

    const handler = () =>
      new Promise<{ status: number; body: string }>((resolve) => {
        const scope = requestContext();
        scope.signal.addEventListener(
          "abort",
          () => {
            receivedReason = scope.signal.reason;
            resolve({ status: 200, body: "cancelled" });
          },
          { once: true },
        );
      });
    Object.assign(handler, { requiresRequestContext: true });
    adapter.get("/disconnect", handler);

    const response = Promise.resolve(
      adapter.handleRequest(
        new Request("http://test/disconnect", { signal: client.signal }),
      ),
    );
    client.abort(reason);

    expect((await response).status).toBe(200);
    expect(receivedReason).toBe(reason);
  });

  test("remove o listener de abort quando o request scope termina", async () => {
    const adapter = new HttpAdapter();
    adapter.setHandlerTimeout(null);
    const client = new AbortController();
    let signal: AbortSignal | undefined;

    const handler = () => {
      signal = requestContext().signal;
      return { status: 200, body: "ok" };
    };
    Object.assign(handler, { requiresRequestContext: true });
    adapter.get("/complete", handler);

    await adapter.handleRequest(
      new Request("http://test/complete", { signal: client.signal }),
    );
    client.abort(new Error("late client disconnect"));

    expect(signal?.aborted).toBe(false);
  });

  test("reverte o contador quando a factory do scope falha", async () => {
    const adapter = new HttpAdapter();
    adapter.setRequestScopeFactory(() => {
      throw new Error("scope failed");
    });
    adapter.useMiddleware(async (_request, next) => next());
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
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toMatch(
      /^[0-9a-z]+-[0-9a-z]+-[0-9a-z]+$/,
    );
    await closePromise;
    expect(closed).toBe(true);
  });

  test("close aguarda handler assíncrono registrado como rota nativa", async () => {
    let finish!: () => void;
    let started!: () => void;
    const blocker = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });

    const adapter = new HttpAdapter();
    adapter.setHandlerTimeout(null);
    adapter.get("/native", async () => {
      started();
      await blocker;
      return { status: 200, body: "ok" };
    });

    await adapter.listen(testPort());
    const responsePromise = fetch(`${adapter.url}native`);
    await handlerStarted;

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
        headers: {
          Origin: "https://example.test",
          "Access-Control-Request-Method": "GET",
        },
      }),
    );

    expect(preflightResponse.status).toBe(204);

    adapter.disableCors();

    const disabledCorsResponse = await adapter.handleRequest(request("/cors"));

    expect(
      disabledCorsResponse.headers.get("access-control-allow-origin"),
    ).toBeNull();
  });

  test("mantém headers CORS no servidor e no app.fetch para rota estática", async () => {
    const adapter = new HttpAdapter();
    adapter.setHandlerTimeout(null);
    adapter.enableCors("https://client.example");
    adapter.get("/cors-native", () => ({ status: 200, body: "ok" }));

    const direct = await adapter.handleRequest(
      request("/cors-native", {
        headers: { Origin: "https://client.example" },
      }),
    );
    await adapter.listen(testPort());
    try {
      const server = await fetch(`${adapter.url}cors-native`, {
        headers: { Origin: "https://client.example" },
      });
      expect(direct.status).toBe(server.status);
      expect(direct.headers.get("access-control-allow-origin")).toBe(
        "https://client.example",
      );
      expect(server.headers.get("access-control-allow-origin")).toBe(
        "https://client.example",
      );
      expect(await server.text()).toBe(await direct.text());
    } finally {
      await adapter.close();
    }
  });

  test("mantém paridade de headers, erros, validação, request ID e eventos", async () => {
    const adapter = new HttpAdapter();
    const events = new ApplicationEvents();
    const observed: Array<{
      requestId: string;
      status: number;
      route: string;
    }> = [];
    events.on("request.completed", (event) => {
      observed.push({
        requestId: event.requestId,
        status: event.status,
        route: event.route,
      });
    });
    adapter.setEvents(events);
    adapter.setHandlerTimeout(null);
    adapter.setRequestIdGenerator(() => "parity-request-id");
    adapter.get("/headers", () => ({
      status: 201,
      body: "created",
      headers: { "X-Parity": "yes" },
    }));
    adapter.get("/failure", () => {
      throw new Error("native failure");
    });
    const validation = ((input: { body: unknown }) => ({
      status: 200,
      body: JSON.stringify(input.body),
    })) as import("../../src/http").ServerHandler;
    Object.assign(validation, { needsBody: true });
    adapter.post("/validation", validation);

    const snapshots = async (pathname: string, init?: RequestInit) => {
      const direct = await adapter.handleRequest(
        new Request(`http://test${pathname}`, init),
      );
      const directSnapshot = {
        status: direct.status,
        parity: direct.headers.get("x-parity"),
        requestId: direct.headers.get("x-request-id"),
        contentType: direct.headers.get("content-type"),
        body: await direct.text(),
      };
      await adapter.listen(testPort());
      try {
        const server = await fetch(new URL(pathname, adapter.url!), init);
        const serverSnapshot = {
          status: server.status,
          parity: server.headers.get("x-parity"),
          requestId: server.headers.get("x-request-id"),
          contentType: server.headers.get("content-type"),
          body: await server.text(),
        };
        expect(serverSnapshot).toEqual(directSnapshot);
      } finally {
        await adapter.close();
      }
    };

    await snapshots("/headers");
    await snapshots("/failure");
    await snapshots("/validation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{invalid",
    });

    expect(observed).toEqual([
      { requestId: "parity-request-id", status: 201, route: "/headers" },
      { requestId: "parity-request-id", status: 201, route: "/headers" },
      { requestId: "parity-request-id", status: 500, route: "/failure" },
      { requestId: "parity-request-id", status: 500, route: "/failure" },
      { requestId: "parity-request-id", status: 400, route: "/validation" },
      { requestId: "parity-request-id", status: 400, route: "/validation" },
    ]);
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

  test("lê text, urlencoded e multipart conforme o Content-Type", async () => {
    const reader = new JsonBodyReader();
    await expect(
      reader.read(
        new Request("http://test/body", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "hello",
        }),
      ),
    ).resolves.toBe("hello");

    await expect(
      reader.read(
        new Request("http://test/body", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "name=Ada&tag=one&tag=two",
        }),
      ),
    ).resolves.toEqual({ name: "Ada", tag: ["one", "two"] });

    const form = new FormData();
    form.append("name", "Ada");
    form.append("tag", "one");
    form.append("tag", "two");
    const multipartRequest = new Request("http://test/body", {
      method: "POST",
      body: form,
    });
    await expect(reader.read(multipartRequest)).resolves.toEqual({
      name: "Ada",
      tag: ["one", "two"],
    });
  });

  test("rejeita media type de body não suportado", async () => {
    const reader = new JsonBodyReader();
    await expect(
      reader.read(
        new Request("http://test/body", {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: "{}",
        }),
      ),
    ).rejects.toMatchObject({ status: 415 });
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

  test("aplica o limite padrão ao body real com Content-Length falsamente pequeno", async () => {
    const reader = new JsonBodyReader();
    const value = "x".repeat(1_048_576);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ value })));
        controller.close();
      },
    });

    await expect(
      reader.read(
        new Request("http://test/body", {
          method: "POST",
          headers: {
            "content-length": "1",
            "content-type": "application/json",
          },
          body: stream,
          duplex: "half",
        } as RequestInit),
      ),
    ).rejects.toMatchObject({ status: 413 });
  });

  test("cancela stream sem Content-Length ao exceder o limite", async () => {
    const adapter = new HttpAdapter();
    adapter.setMaxBodyBytes(5);

    const bodyHandler = (req: { body: unknown }) => ({
      status: 200,
      body: JSON.stringify(req.body),
    });
    bodyHandler.needsBody = true;
    adapter.post("/stream-limit", bodyHandler);

    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([49]));
      },
      cancel() {
        cancelled = true;
      },
    });

    const response = await adapter.handleRequest(
      request("/stream-limit", {
        method: "POST",
        body: stream,
      }),
    );

    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
  });

  test("getFile não força content type JSON", async () => {
    const adapter = new HttpAdapter();
    adapter.getFile("/file", Bun.file("README.md"));

    const response = await adapter.handleRequest(request("/file"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).not.toBe("application/json");
    expect(response.headers.get("content-type")).toContain("text/markdown");
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

    adapter.useMiddleware(async (_req, next) => {
      order.push("one");

      const response = await next();

      order.push("one-after");

      return response;
    });

    adapter.useMiddleware(async (_req, next) => {
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

    stopped.useMiddleware(async () => ({
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

    twice.useMiddleware(async (_req, next) => {
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
