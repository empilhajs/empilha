import { describe, expect, test } from "bun:test"
import { Inject } from "empilha"
import { jwt, refreshAccessToken } from "../src"

describe("@empilha/jwt", () => {
  const secret = "test-secret-with-at-least-32-bytes-123456"
  test("assina e verifica um token com claims configuradas", async () => {
    const service = jwt({
      name: "access",
      secret,
      issuer: "empilha",
      audience: "api",
      expiresIn: "1h",
    })

    const token = await service.sign({ sub: "user-1", roles: ["admin"] })
    const payload = await service.verify(token)

    expect(payload).toMatchObject({
      sub: "user-1",
      roles: ["admin"],
      iss: "empilha",
      aud: "api",
    })
  })

  test("retorna false para token inválido ou claims incompatíveis", async () => {
    const service = jwt({
      name: "access",
      secret,
      issuer: "empilha",
    })
    const otherIssuer = jwt({
      name: "access",
      secret,
      issuer: "other",
    })

    expect(await service.verify("invalid-token")).toBe(false)
    expect(
      await service.verify(await otherIssuer.sign({ sub: "user-1" })),
    ).toBe(false)
  })

  test("integra autenticação e roles com o plugin do Empilha", async () => {
    const service = jwt({ name: "access", secret })
    let authHandler: ((token: string) => Promise<unknown>) | undefined
    const registered: string[] = []

    service.auth().install({
      registerPluginService(name) {
        registered.push(name)
      },
      auth(handler) {
        authHandler = handler
      },
    } as never)

    const token = await service.sign({ sub: "user-1", roles: ["admin"] })
    expect(registered).toEqual(["access"])
    expect(await authHandler?.(token)).toEqual({
      valid: true,
      payload: expect.objectContaining({ sub: "user-1" }),
      roles: ["admin"],
    })
  })

  test("aceita roles customizadas e valida opções obrigatórias", async () => {
    expect(() => jwt({ name: "", secret: "secret" })).toThrow("nome do JWT")
    expect(() => jwt({ name: "access", secret: "" })).toThrow("segredo JWT")

    const service = jwt({ name: "access", secret })
    let authHandler: ((token: string) => Promise<unknown>) | undefined
    service.auth({ roles: () => ["custom"] }).install({
      registerPluginService() {},
      auth(handler) {
        authHandler = handler
      },
    } as never)

    const token = await service.sign({ sub: "user-1" })
    expect(await authHandler?.(token)).toEqual({
      valid: true,
      payload: expect.objectContaining({ sub: "user-1" }),
      roles: ["custom"],
    })
  })

  test("emite novo access token a partir de refresh token válido", async () => {
    const access = jwt({ name: "access", secret: `${secret}-access` })
    const refresh = jwt({ name: "refresh", secret: `${secret}-refresh` })
    const refreshToken = await refresh.sign({ sub: "user-1", roles: ["user"] })

    const accessToken = await refreshAccessToken(access, refresh, refreshToken)
    expect(accessToken).toBeString()
    expect(await access.verify(accessToken as string)).toMatchObject({
      sub: "user-1",
      roles: ["user"],
    })
    expect(await refreshAccessToken(access, refresh, "invalid")).toBe(false)
  })

  test("rejeita segredo fraco e purpose incorreto", async () => {
    expect(() => jwt({ name: "access", secret: "short" })).toThrow("32 bytes")

    const access = jwt({ name: "access", secret })
    const refresh = jwt({ name: "refresh", secret: `${secret}-refresh-2` })
    const accessToken = await access.sign({ sub: "user-1" })
    expect(await refreshAccessToken(access, refresh, accessToken)).toBe(false)
  })

  test("usa o decorator Inject do framework para serviços JWT", () => {
    class Controller {
      method(_service: unknown) {}
    }

    expect(() =>
      Inject("access")(Controller.prototype, "method", 0),
    ).not.toThrow()
  })
})
