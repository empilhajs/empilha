import { FormatRegistry, type Static, type TSchema } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import {
  createToken,
  defineDeclarativePlugin,
  type DeclarativePlugin,
  type AuthResult,
  type Token,
} from "empilha";

export type JwtClaims = JWTPayload & Record<string, unknown>;

type ClaimsPayload<TSchemaValue> = TSchemaValue extends TSchema
  ? JwtClaims & Static<TSchemaValue>
  : JwtClaims;

export type JwtOptions<TClaimsSchema extends TSchema | undefined = undefined> =
  {
    name: string;
    secret: string;
    algorithm?: "HS256" | "HS384" | "HS512";
    expiresIn?: string | number;
    /** Tokens de acesso e de atualização devem utilizar finalidades diferentes. */
    tokenUse?: "access" | "refresh";
    issuer?: string;
    audience?: string | string[];
    /** Schema TypeBox usado para validar e inferir as claims do token. */
    claims?: TClaimsSchema;
  };

export type JwtService<TPayload extends JwtClaims = JwtClaims> = {
  readonly name: string;
  readonly tokenUse: "access" | "refresh";
  readonly token: Token<JwtService<TPayload>>;
  readonly claims?: TSchema;
  sign(payload: TPayload): Promise<string>;
  verify(token: string): Promise<TPayload | false>;
  auth(options?: {
    roles?: (payload: TPayload) => readonly string[] | undefined;
  }): DeclarativePlugin<undefined>;
};

/** Extrai o payload tipado de um serviço JWT configurado. */
export type IdentityOf<TAccess> =
  TAccess extends JwtService<infer TPayload> ? TPayload : never;

export type JwtPlugin<TPayload extends JwtClaims = JwtClaims> =
  DeclarativePlugin<undefined> & JwtService<TPayload>;

function ensureJwtBuiltinFormats(): void {
  if (!FormatRegistry.Has("email")) {
    FormatRegistry.Set("email", (value) =>
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
    );
  }
  if (!FormatRegistry.Has("date")) {
    FormatRegistry.Set("date", (value) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const date = new Date(`${value}T00:00:00.000Z`);
      return date.toISOString().startsWith(`${value}T`);
    });
  }
}

/** Verifica um refresh token e emite um novo access token sem copiar claims registradas. */
export async function refreshAccessToken<
  TPayload extends JwtClaims = JwtClaims,
>(
  access: JwtService<TPayload>,
  refresh: JwtService,
  refreshToken: string,
): Promise<string | false> {
  const payload = await refresh.verify(refreshToken);
  if (!payload) return false;
  if (refresh.tokenUse !== "refresh" || payload.token_use !== "refresh") {
    return false;
  }

  const {
    exp: _exp,
    iat: _iat,
    nbf: _nbf,
    iss: _iss,
    aud: _aud,
    ...claims
  } = payload;

  return access.sign(claims as TPayload);
}

/** Cria um plugin JWT opcional, baseado em `jose`. */
export function jwt<TClaimsSchema extends TSchema | undefined = undefined>(
  options: JwtOptions<TClaimsSchema>,
): JwtPlugin<ClaimsPayload<TClaimsSchema>> {
  const name = options.name.trim();
  if (!name) throw new Error("O nome do JWT não pode ser vazio.");
  if (!options.secret) throw new Error("O segredo JWT não pode ser vazio.");

  const secretBytes = new TextEncoder().encode(options.secret);
  const minimumSecretBytes = algorithmMinimumSecretBytes(
    options.algorithm ?? "HS256",
  );
  if (secretBytes.byteLength < minimumSecretBytes) {
    throw new Error(
      `O segredo JWT deve conter pelo menos ${minimumSecretBytes} bytes de material aleatório.`,
    );
  }

  const algorithm = options.algorithm ?? "HS256";
  const tokenUse =
    options.tokenUse ?? (name === "refresh" ? "refresh" : "access");
  const expiresIn =
    options.expiresIn ?? (tokenUse === "refresh" ? "7d" : "15m");
  const secret = secretBytes;
  const claimsValidator = options.claims
    ? (ensureJwtBuiltinFormats(), TypeCompiler.Compile(options.claims))
    : undefined;
  const token = createToken<JwtService<ClaimsPayload<TClaimsSchema>>>(
    `@empilha/jwt/${name}`,
  );

  const verifyDetailed = async (
    rawToken: string,
  ): Promise<
    | { readonly ok: true; readonly payload: ClaimsPayload<TClaimsSchema> }
    | {
        readonly ok: false;
        readonly reason: "invalid-token" | "invalid-claims";
      }
  > => {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(rawToken, secret, {
        algorithms: [algorithm],
        issuer: options.issuer,
        audience: options.audience,
      }));
    } catch {
      return { ok: false, reason: "invalid-token" };
    }
    if (typeof payload.exp !== "number") {
      return { ok: false, reason: "invalid-claims" };
    }
    if (payload.token_use !== tokenUse) {
      return { ok: false, reason: "invalid-claims" };
    }
    if (claimsValidator && !claimsValidator.Check(payload)) {
      return { ok: false, reason: "invalid-claims" };
    }
    return {
      ok: true,
      payload: payload as ClaimsPayload<TClaimsSchema>,
    };
  };

  const service: JwtService<ClaimsPayload<TClaimsSchema>> = {
    name,
    tokenUse,
    token,
    claims: options.claims,
    async sign(payload) {
      if (claimsValidator && !claimsValidator.Check(payload)) {
        throw new TypeError("As claims não correspondem ao schema JWT.");
      }
      let token = new SignJWT({ ...payload, token_use: tokenUse })
        .setProtectedHeader({ alg: algorithm })
        .setIssuedAt();

      token = token.setExpirationTime(expiresIn);
      if (options.issuer) token = token.setIssuer(options.issuer);
      if (options.audience) token = token.setAudience(options.audience);

      return token.sign(secret);
    },
    async verify(token) {
      const result = await verifyDetailed(token);
      return result.ok ? result.payload : false;
    },
    auth(authOptions) {
      return defineDeclarativePlugin({
        name: `@empilha/jwt/${name}/auth`,
        version: "0.2.1",
        provides: ["auth/handler"],
        requires: [`auth/jwt/${name}`],
        register(context) {
          context.auth(
            async (
              rawToken,
            ): Promise<AuthResult<ClaimsPayload<TClaimsSchema>>> => {
              const result = await verifyDetailed(rawToken);
              if (!result.ok) return { valid: false, failure: result.reason };
              const payload = result.payload;
              return {
                valid: true,
                payload,
                roles: (authOptions?.roles?.(payload) ??
                  rolesFromPayload(payload)) as string[] | undefined,
              };
            },
          );
        },
      });
    },
  };

  const plugin = defineDeclarativePlugin({
    name: `@empilha/jwt/${name}`,
    version: "0.2.1",
    provides: [`auth/jwt/${name}`],
    register(context) {
      context.provider({ provide: token, useValue: service });
    },
  });
  return Object.freeze(Object.assign({}, plugin, service)) as JwtPlugin<
    ClaimsPayload<TClaimsSchema>
  >;
}

function rolesFromPayload(payload: JwtClaims): string[] | undefined {
  const roles = payload.roles;

  if (
    !Array.isArray(roles) ||
    !roles.every((role) => typeof role === "string")
  ) {
    return undefined;
  }

  return roles;
}

function algorithmMinimumSecretBytes(
  algorithm: JwtOptions["algorithm"],
): number {
  switch (algorithm) {
    case "HS384":
      return 48;
    case "HS512":
      return 64;
    default:
      return 32;
  }
}
