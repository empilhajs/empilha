import { describe, expect, test } from "bun:test";
import { Inject, t } from "empilha";
import { IdentityOf, jwt, refreshAccessToken } from "../src";

describe("@empilha/jwt", () => {
  const secret = "test-secret-with-at-least-32-bytes-123456";
  test("infere IdentityOf e valida claims no sign/verify", async () => {
    const access = jwt({
      name: "typed-access",
      secret,
      claims: t.Object({
        sub: t.String(),
        tenantId: t.String(),
      }),
    });
    type AccessIdentity = IdentityOf<typeof access>;
    const identity: AccessIdentity = {
      sub: "user-1",
      tenantId: "tenant-1",
    };

    const token = await access.sign(identity);
    expect(await access.verify(token)).toMatchObject(identity);
    await expect(
      access.sign({ sub: "user-1" } as AccessIdentity),
    ).rejects.toThrow("claims não correspondem");
  });

  test("separa token inválido de claims inválidas sem expor detalhes", async () => {
    const typed = jwt({
      name: "typed-auth",
      secret,
      claims: t.Object({ sub: t.String(), tenantId: t.String() }),
    });
    const untyped = jwt({ name: "untyped-auth", secret });
    let authHandler: ((token: string) => Promise<unknown>) | undefined;
    await typed.auth().descriptor.register(
      {
        provider() {},
        onClose() {},
        healthCheck() {},
        provideCapability() {},
        postgres() {},
        auth(handler) {
          authHandler = handler;
        },
      },
      undefined,
    );

    const invalidClaimsToken = await untyped.sign({ sub: "user-1" });
    expect(await authHandler?.(invalidClaimsToken)).toEqual({
      valid: false,
      failure: "invalid-claims",
    });
    expect(await authHandler?.("not-a-token")).toEqual({
      valid: false,
      failure: "invalid-token",
    });
  });
  test("assina e verifica um token com claims configuradas", async () => {
    const service = jwt({
      name: "access",
      secret,
      issuer: "empilha",
      audience: "api",
      expiresIn: "1h",
    });

    const token = await service.sign({ sub: "user-1", roles: ["admin"] });
    const payload = await service.verify(token);

    expect(payload).toMatchObject({
      sub: "user-1",
      roles: ["admin"],
      iss: "empilha",
      aud: "api",
    });
  });

  test("retorna false para token inválido ou claims incompatíveis", async () => {
    const service = jwt({
      name: "access",
      secret,
      issuer: "empilha",
    });
    const otherIssuer = jwt({
      name: "access",
      secret,
      issuer: "other",
    });

    expect(await service.verify("invalid-token")).toBe(false);
    expect(
      await service.verify(await otherIssuer.sign({ sub: "user-1" })),
    ).toBe(false);
  });

  test("integra autenticação e roles com o plugin do Empilha", async () => {
    const service = jwt({ name: "access", secret });
    let authHandler: ((token: string) => Promise<unknown>) | undefined;
    const registered: string[] = [];

    const plugin = service.auth();
    await plugin.descriptor.register(
      {
        provider() {},
        onClose() {},
        healthCheck() {},
        provideCapability() {},
        postgres() {},
        auth(handler) {
          authHandler = handler;
        },
      },
      undefined,
    );

    const token = await service.sign({ sub: "user-1", roles: ["admin"] });
    expect(await authHandler?.(token)).toEqual({
      valid: true,
      payload: expect.objectContaining({ sub: "user-1" }),
      roles: ["admin"],
    });
  });

  test("aceita roles customizadas e valida opções obrigatórias", async () => {
    expect(() => jwt({ name: "", secret: "secret" })).toThrow("nome do JWT");
    expect(() => jwt({ name: "access", secret: "" })).toThrow("segredo JWT");

    const service = jwt({ name: "access", secret });
    let authHandler: ((token: string) => Promise<unknown>) | undefined;
    const plugin = service.auth({ roles: () => ["custom"] });
    await plugin.descriptor.register(
      {
        provider() {},
        onClose() {},
        healthCheck() {},
        provideCapability() {},
        postgres() {},
        auth(handler) {
          authHandler = handler;
        },
      },
      undefined,
    );

    const token = await service.sign({ sub: "user-1" });
    expect(await authHandler?.(token)).toEqual({
      valid: true,
      payload: expect.objectContaining({ sub: "user-1" }),
      roles: ["custom"],
    });
  });

  test("emite novo access token a partir de refresh token válido", async () => {
    const access = jwt({ name: "access", secret: `${secret}-access` });
    const refresh = jwt({ name: "refresh", secret: `${secret}-refresh` });
    const refreshToken = await refresh.sign({ sub: "user-1", roles: ["user"] });

    const accessToken = await refreshAccessToken(access, refresh, refreshToken);
    expect(accessToken).toBeString();
    expect(await access.verify(accessToken as string)).toMatchObject({
      sub: "user-1",
      roles: ["user"],
    });
    expect(await refreshAccessToken(access, refresh, "invalid")).toBe(false);
  });

  test("rejeita segredo fraco e purpose incorreto", async () => {
    expect(() => jwt({ name: "access", secret: "short" })).toThrow("32 bytes");

    const access = jwt({ name: "access", secret });
    const refresh = jwt({ name: "refresh", secret: `${secret}-refresh-2` });
    const accessToken = await access.sign({ sub: "user-1" });
    expect(await refreshAccessToken(access, refresh, accessToken)).toBe(false);
  });

  test("rejeita token de refresh no verificador e no auth de access com segredo compartilhado", async () => {
    const access = jwt({ name: "access", secret });
    const refresh = jwt({ name: "refresh", secret });
    const refreshToken = await refresh.sign({ sub: "user-1" });
    let authHandler: ((token: string) => Promise<unknown>) | undefined;

    await access.auth().descriptor.register(
      {
        provider() {},
        onClose() {},
        healthCheck() {},
        provideCapability() {},
        postgres() {},
        auth(handler) {
          authHandler = handler;
        },
      },
      undefined,
    );

    expect(await access.verify(refreshToken)).toBe(false);
    expect(await authHandler?.(refreshToken)).toEqual({
      valid: false,
      failure: "invalid-claims",
    });
    expect(await refresh.verify(refreshToken)).toMatchObject({
      sub: "user-1",
      token_use: "refresh",
    });
  });

  test("usa o decorator Inject do framework para serviços JWT", () => {
    const service = jwt({ name: "access", secret });
    class Controller {
      method(_service: unknown) {}
    }

    expect(() =>
      Inject(service.token)(Controller.prototype, "method", 0),
    ).not.toThrow();
  });
});
