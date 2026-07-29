import { SignJWT, jwtVerify, type JWTPayload } from "jose"
import {
  definePlugin,
  type AuthResult,
  type EmpilhaPlugin,
} from "empilha"

type JwtClaims = JWTPayload & Record<string, unknown>

export type JwtOptions = {
  name: string
  secret: string
  algorithm?: "HS256" | "HS384" | "HS512"
  expiresIn?: string | number
  issuer?: string
  audience?: string | string[]
}

export type JwtService<TPayload extends JwtClaims = JwtClaims> = {
  readonly name: string
  sign(payload: TPayload): Promise<string>
  verify(token: string): Promise<TPayload | false>
  auth(options?: {
    roles?: (payload: TPayload) => readonly string[] | undefined
  }): EmpilhaPlugin
}

export type JwtPlugin<TPayload extends JwtClaims = JwtClaims> =
  EmpilhaPlugin & JwtService<TPayload>

/** Verifica um refresh token e emite um novo access token sem copiar claims registradas. */
export async function refreshAccessToken<TPayload extends JwtClaims = JwtClaims>(
  access: JwtService<TPayload>,
  refresh: JwtService,
  refreshToken: string,
): Promise<string | false> {
  const payload = await refresh.verify(refreshToken)
  if (!payload) return false

  const {
    exp: _exp,
    iat: _iat,
    nbf: _nbf,
    iss: _iss,
    aud: _aud,
    ...claims
  } = payload

  return access.sign(claims as TPayload)
}

/** Cria um plugin JWT opcional, baseado em `jose`. */
export function jwt<TPayload extends JwtClaims = JwtClaims>(
  options: JwtOptions,
): JwtPlugin<TPayload> {
  const name = options.name.trim()
  if (!name) throw new Error("O nome do JWT não pode ser vazio.")
  if (!options.secret) throw new Error("O segredo JWT não pode ser vazio.")

  const algorithm = options.algorithm ?? "HS256"
  const secret = new TextEncoder().encode(options.secret)

  const service: JwtService<TPayload> = {
    name,
    async sign(payload) {
      let token = new SignJWT(payload)
        .setProtectedHeader({ alg: algorithm })
        .setIssuedAt()

      if (options.expiresIn !== undefined)
        token = token.setExpirationTime(options.expiresIn)
      if (options.issuer) token = token.setIssuer(options.issuer)
      if (options.audience) token = token.setAudience(options.audience)

      return token.sign(secret)
    },
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, secret, {
          algorithms: [algorithm],
          issuer: options.issuer,
          audience: options.audience,
        })
        return payload as TPayload
      } catch {
        return false
      }
    },
    auth(authOptions) {
      return definePlugin((app) => {
        app.registerPluginService(name, service)
        app.auth(async (token): Promise<AuthResult<TPayload>> => {
          const payload = await service.verify(token)
          if (!payload) return { valid: false }
          return {
            valid: true,
            payload,
            roles: (authOptions?.roles?.(payload) ??
              rolesFromPayload(payload)) as string[] | undefined,
          }
        })
      })
    },
  }

  return Object.assign(
    definePlugin((app) => app.registerPluginService(name, service)),
    service,
  )
}

function rolesFromPayload(payload: JwtClaims): string[] | undefined {
  const roles = payload.roles

  if (
    !Array.isArray(roles) ||
    !roles.every((role) => typeof role === "string")
  ) {
    return undefined
  }

  return roles
}
