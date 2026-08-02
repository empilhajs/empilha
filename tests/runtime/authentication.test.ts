import { describe, expect, test } from "bun:test";
import {
  Identity,
  Guard,
  Controller,
  createApplication,
  Get,
  Roles,
  t,
} from "../../src";
import { testAuthPlugin, testModule } from "../helpers/test-utils";

describe("Empilha authentication", () => {
  async function appWith(
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

    return createApplication(
      testModule([Admin], {
        plugins: auth ? [testAuthPlugin(auth)] : [],
      }),
      {
        configure(runtime) {
          runtime.configureHttp({ cors: false });
        },
      },
    );
  }

  test("bloqueia sem token e token inválido", async () => {
    const app = await appWith("admin", () => ({
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
    const app = await appWith("admin", () => ({
      valid: true,
      roles: ["admin"],
    }));

    const authorizedResponse = await app.test().get("/admin/panel", {
      headers: {
        authorization: "Bearer good",
      },
    });

    expect(authorizedResponse.status).toBe(200);

    const configured = await appWith("user", () => ({
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
    const app = await appWith(["admin", "manager"], () => ({
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

  test("falha no bootstrap quando autenticação não foi configurada", async () => {
    await expect(appWith("admin")).rejects.toThrow("E_AUTH_CAPABILITY_MISSING");
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

    const app = await createApplication(testModule([TokenRoute]), {
      configure: (runtime) => runtime.configureHttp({ cors: false }),
    });

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

    const app = await createApplication(
      testModule([Profile], {
        plugins: [
          testAuthPlugin(() => ({
            valid: true,
            roles: [],
            payload: {
              id: "user-1",
              email: "ana@example.com",
            },
          })),
        ],
      }),
      { configure: (runtime) => runtime.configureHttp({ cors: false }) },
    );

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

  test("valida claims e tipa o contrato de Identity(access)", async () => {
    const access = {
      name: "access",
      claims: t.Object({
        sub: t.String(),
        tenantId: t.String(),
      }),
    };
    class Profile {
      profile(user: unknown) {
        return user;
      }
    }

    Get("/profile")(
      Profile.prototype,
      "profile",
      Object.getOwnPropertyDescriptor(Profile.prototype, "profile")!,
    );
    Identity(access)(Profile.prototype, "profile", 0);
    Controller("/typed-account")(Profile);

    const app = await createApplication(
      testModule([Profile], {
        plugins: [
          testAuthPlugin(() => ({
            valid: true,
            payload: { sub: "user-1", tenantId: "tenant-1" },
          })),
        ],
      }),
      { configure: (runtime) => runtime.configureHttp({ cors: false }) },
    );

    const valid = await app.test().get("/typed-account/profile", {
      headers: { authorization: "Bearer valid" },
    });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({
      sub: "user-1",
      tenantId: "tenant-1",
    });

    const invalid = await createApplication(
      testModule([Profile], {
        plugins: [
          testAuthPlugin(() => ({
            valid: true,
            payload: { sub: "user-1" },
          })),
        ],
      }),
      { configure: (runtime) => runtime.configureHttp({ cors: false }) },
    );
    expect(
      (
        await invalid.test().get("/typed-account/profile", {
          headers: { authorization: "Bearer invalid" },
        })
      ).status,
    ).toBe(400);
  });

  test("mantém falha de claims distinta sem revelar detalhes", async () => {
    class ClaimsRoute {
      @Get("/")
      @Roles("admin")
      get() {
        return { ok: true };
      }
    }
    Controller("/claims-failure")(ClaimsRoute);

    const app = await createApplication(
      testModule([ClaimsRoute], {
        plugins: [
          testAuthPlugin(() => ({
            valid: false,
            failure: "invalid-claims",
          })),
        ],
      }),
      { configure: (runtime) => runtime.configureHttp({ cors: false }) },
    );
    const response = await app.test().get("/claims-failure", {
      headers: { authorization: "Bearer invalid" },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      type: "about:blank",
      title: "Claims inválidas",
      status: 401,
    });
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });
});
