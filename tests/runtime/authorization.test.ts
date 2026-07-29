import { describe, expect, test } from "bun:test";
import { AuthorizationService } from "../../src/runtime/authorization";
import type { ServerRequest } from "../../src/http/http-adapter";

function request(authorization?: string): ServerRequest {
  return {
    method: "GET",
    pathname: "/private",
    headers: authorization ? { authorization } : {},
    params: {},
    query: {},
    body: undefined,
  };
}

describe("AuthorizationService", () => {
  test("valida bearer token, roles e ausência de token", async () => {
    const service = new AuthorizationService();
    service.configure(async (token) => ({
      valid: token === "valid",
      roles: ["admin"],
    }));

    const guard = service.createGuard("admin");
    expect((await guard(request()))?.status).toBe(401);
    expect((await guard(request("Bearer invalid")))?.status).toBe(401);
    expect(await guard(request("Bearer valid"))).toBeNull();
  });

  test("suporta regra por função e rejeita role ausente", async () => {
    const service = new AuthorizationService();
    service.configure(() => ({ valid: true, roles: [] }));

    expect(
      (await service.createGuard("admin")(request("Bearer valid")))?.status,
    ).toBe(403);

    const guard = service.createGuard(async (token) => token === "allowed");
    expect((await guard(request("Bearer denied")))?.status).toBe(403);
    expect(await guard(request("Bearer allowed"))).toBeNull();
  });

  test("aceita roles superiores configuradas na hierarquia", async () => {
    const service = new AuthorizationService();
    service.configure(() => ({ valid: true, roles: ["admin"] }));
    service.configureHierarchy({ user: 0, manager: 1, admin: 2 });

    expect(
      await service.createGuard("manager")(request("Bearer valid")),
    ).toBeNull();

    const lowerRole = new AuthorizationService();
    lowerRole.configure(() => ({ valid: true, roles: ["manager"] }));
    lowerRole.configureHierarchy({ user: 0, manager: 1, admin: 2 });

    expect(
      (await lowerRole.createGuard("admin")(request("Bearer valid")))?.status,
    ).toBe(403);
  });

  test("mantém correspondência exata para roles fora da hierarquia", async () => {
    const service = new AuthorizationService();
    service.configure(() => ({ valid: true, roles: ["partner"] }));
    service.configureHierarchy({ user: 0, admin: 2 });

    expect(
      await service.createGuard("partner")(request("Bearer valid")),
    ).toBeNull();
  });

  test("rejeita níveis inválidos na hierarquia", () => {
    const service = new AuthorizationService();

    expect(() => service.configureHierarchy({ admin: -1 })).toThrow(RangeError);
    expect(() => service.configureHierarchy({ admin: 1.5 })).toThrow(
      RangeError,
    );
  });
});
