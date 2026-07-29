import { describe, expect, test } from "bun:test";
import { Identity, Guard, Controller, Empilha, Get, Roles } from "../../src";

describe("Empilha authentication", () => {
  function appWith(
    rule: string | readonly string[],
    auth?: (token: string) => {
      valid: boolean;
      roles?: string[];
      payload?: unknown;
    },
  ) {
    class Admin {
      @Get("/panel")
      @Roles(...(Array.isArray(rule) ? rule : [rule]))
      panel() {
        return {
          secret: true,
        };
      }
    }

    Controller("/admin")(Admin);

    const app = new Empilha().configureHttp({ cors: false });

    if (auth) {
      app.auth(auth);
    }

    app.validate([Admin]).initialize([Admin]);

    return app;
  }

  test("bloqueia sem token e token inválido", async () => {
    const app = appWith("admin", () => ({
      valid: false,
    }));

    expect((await app.test().get("/admin/panel")).status).toBe(401);

    const response = await app.test().get("/admin/panel", {
      headers: {
        authorization: "Bearer bad",
      },
    });

    expect(response.status).toBe(401);
  });

  test("autoriza role correta e rejeita role ausente", async () => {
    const app = appWith("admin", () => ({
      valid: true,
      roles: ["admin"],
    }));

    const authorizedResponse = await app.test().get("/admin/panel", {
      headers: {
        authorization: "Bearer good",
      },
    });

    expect(authorizedResponse.status).toBe(200);

    const configured = appWith("user", () => ({
      valid: true,
      roles: ["admin"],
    }));

    const forbiddenResponse = await configured.test().get("/admin/panel", {
      headers: {
        authorization: "Bearer good",
      },
    });

    expect(forbiddenResponse.status).toBe(403);
  });

  test("autoriza qualquer uma das roles informadas", async () => {
    const app = appWith(["admin", "manager"], () => ({
      valid: true,
      roles: ["manager"],
    }));

    const response = await app.test().get("/admin/panel", {
      headers: {
        authorization: "Bearer good",
      },
    });

    expect(response.status).toBe(200);
  });

  test("falha no bootstrap quando autenticação não foi configurada", () => {
    expect(() => appWith("admin")).toThrow("app.auth() não foi configurado");
  });

  test("Guard oferece contrato explícito para callback", async () => {
    class TokenRoute {
      @Get("/")
      @Guard((token) => token === "allowed")
      get() {
        return {
          ok: true,
        };
      }
    }

    Controller("/authorize")(TokenRoute);

    const app = new Empilha()
      .configureHttp({ cors: false })
      .validate([TokenRoute])
      .initialize([TokenRoute]);

    expect(
      (
        await app.test().get("/authorize", {
          headers: {
            authorization: "Bearer allowed",
          },
        })
      ).status,
    ).toBe(200);

    expect(
      (
        await app.test().get("/authorize", {
          headers: {
            authorization: "Bearer denied",
          },
        })
      ).status,
    ).toBe(403);
  });

  test("injeta o payload autenticado com Identity", async () => {
    class Profile {
      @Get("/profile")
      profile(user: { id: string; email: string }) {
        return user;
      }
    }

    Identity()(Profile.prototype, "profile", 0);
    Controller("/account")(Profile);

    const app = new Empilha().configureHttp({ cors: false });
    app.auth(() => ({
      valid: true,
      roles: [],
      payload: {
        id: "user-1",
        email: "ana@example.com",
      },
    }));
    app.validate([Profile]).initialize([Profile]);

    const response = await app.test().get("/account/profile", {
      headers: {
        authorization: "Bearer valid",
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: "user-1",
      email: "ana@example.com",
    });
  });
});
