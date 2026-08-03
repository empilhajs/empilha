import { describe, expect, test } from "bun:test";
import { Controller, createApplication, Get } from "../../src";
import { defineRoles, Roles } from "../../src/decorators";
import { testModule } from "../helpers/test-utils";

describe("atalhos de experiência de desenvolvimento", () => {
  test("cria app de teste já registrado e permite configuração", async () => {
    class Hello {
      @Get("/")
      get() {
        return { ok: true };
      }
    }

    const app = await createApplication(testModule([Hello]), {
      configure: (configured) => configured.configureHttp({ cors: false }),
    });

    expect((await app.test().get("/")).status).toBe(200);
  });

  test("agrupa as configurações HTTP", async () => {
    const app = await createApplication(testModule([]), {
      configure: (configured) =>
        configured.configureHttp({
          cors: false,
          handlerTimeout: 1_000,
          shutdownTimeout: 1_000,
          maxConcurrentRequests: 10,
        }),
    });

    expect(app.fetch).toBeTypeOf("function");
  });

  test("aplica configuração centralizada tipada", async () => {
    const app = await createApplication(testModule([]), {
      runtime: {
        server: { port: 4000 },
        http: { cors: false },
        openapi: { title: "Configured API", version: "1.0.0" },
        validation: { responses: false },
      },
    });

    const docs = await app.test().get("/openapi.json");
    expect(docs.status).toBe(200);
    expect((await docs.json()).info.title).toBe("Configured API");
  });

  test("valida configuração parcial antes de aplicar mudanças", async () => {
    await expect(
      createApplication(testModule([]), {
        runtime: { middleware: ["not-a-middleware"] as never },
      }),
    ).rejects.toThrow("middleware deve ser uma lista de funções");

    await expect(
      createApplication(testModule([]), {
        runtime: { validation: { responses: "yes" as never } },
      }),
    ).rejects.toThrow("validation.responses deve ser booleano");

    await expect(
      createApplication(testModule([]), {
        runtime: { server: { port: 70_000 } },
      }),
    ).rejects.toThrow("porta do servidor");

    await expect(
      createApplication(testModule([]), {
        configure: (runtime) =>
          runtime.configureHttp({ cors: false, maxQueryBytes: 0 }),
      }),
    ).rejects.toThrow("maxQueryBytes");
  });

  test("habilita logging de requests pela configuração centralizada", async () => {
    const entries: Array<{ method: string; status: number }> = [];
    const originalInfo = console.info;
    console.info = (value: unknown) => {
      const entry = JSON.parse(String(value)) as {
        method: string;
        status: number;
      };
      entries.push(entry);
    };

    try {
      @Controller("/configured-logs")
      class Logged {
        @Get("/")
        get() {
          return { ok: true };
        }
      }

      const app = await createApplication(testModule([Logged]), {
        runtime: { logging: { requests: true } },
      });

      expect((await app.test().get("/configured-logs")).status).toBe(200);
      expect(entries).toEqual([
        expect.objectContaining({ method: "GET", status: 200 }),
      ]);
    } finally {
      console.info = originalInfo;
    }
  });

  test("cria decorators de roles", () => {
    const roles = defineRoles("admin", "user");
    expect(roles.require("admin")).toBeTypeOf("function");
  });

  test("inclui endpoint no erro de bootstrap", async () => {
    @Controller("/admin")
    class Admin {
      @Get("/")
      @Roles("admin")
      list() {}
    }

    await expect(createApplication(testModule([Admin]))).rejects.toThrow(
      "Admin.list",
    );
  });
});
