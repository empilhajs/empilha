import { describe, expect, test } from "bun:test";
import { Controller, createTestApp, Empilha, Get } from "../../src";
import { defineRoles, Roles } from "../../src/decorators";

describe("atalhos de experiência de desenvolvimento", () => {
  test("cria app de teste já registrado e permite configuração", async () => {
    class Hello {
      @Get("/")
      get() {
        return { ok: true };
      }
    }

    const app = createTestApp([Hello], (configured) =>
      configured.configureHttp({ cors: false }),
    );

    expect((await app.test().get("/")).status).toBe(200);
  });

  test("agrupa as configurações HTTP", () => {
    const app = new Empilha().configureHttp({
      cors: false,
      handlerTimeout: 1_000,
      shutdownTimeout: 1_000,
      maxConcurrentRequests: 10,
    });

    expect(app).toBeInstanceOf(Empilha);
  });

  test("aplica configuração centralizada tipada", async () => {
    const app = new Empilha()
      .configure({
        server: { port: 4000 },
        http: { cors: false },
        openapi: { title: "Configured API", version: "1.0.0" },
        validation: { responses: false },
      })
      .initialize([]);

    const docs = await app.test().get("/openapi.json");
    expect(docs.status).toBe(200);
    expect((await docs.json()).info.title).toBe("Configured API");
  });

  test("cria decorators de roles", () => {
    const roles = defineRoles("admin", "user");
    expect(roles.require("admin")).toBeTypeOf("function");
  });

  test("inclui endpoint no erro de bootstrap", () => {
    @Controller("/admin")
    class Admin {
      @Get("/")
      @Roles("admin")
      list() {}
    }

    expect(() => new Empilha().initialize([Admin])).toThrow(
      "Admin.list (GET /admin)",
    );
  });
});
