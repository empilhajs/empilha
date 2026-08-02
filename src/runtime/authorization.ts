import type { ServerRequest, ServerResponse } from "../http/http-adapter";
import type { RouteMetadata } from "../core/types";
import { requestContext } from "../context";
import { createErrorResponse } from "./error-pipeline";

/** Resultado da validação de um bearer token. */
export type AuthResult<TPayload = unknown> = {
  valid: boolean;
  roles?: string[];
  payload?: TPayload;
  /** Motivo interno da rejeição, sem detalhes criptográficos. */
  failure?: "invalid-token" | "invalid-claims";
};

/** Função da aplicação usada para validar tokens e obter suas roles. */
export type AuthTokenHandler<TPayload = unknown> = (
  token: string,
) => AuthResult<TPayload> | Promise<AuthResult<TPayload>>;

/** Níveis de herança usados para comparar roles. Números maiores têm mais acesso. */
export type RoleHierarchy = Readonly<Record<string, number>>;

/** Middleware compilado que protege uma rota autorizada. */
export type AuthorizationGuard = (
  request: ServerRequest,
) => Promise<ServerResponse | null>;

function extractBearerToken(request: ServerRequest): string | null {
  const authorization = request.headers.authorization;

  if (!authorization) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());

  return match?.[1]?.trim() || null;
}

export class AuthorizationService {
  private tokenHandler: AuthTokenHandler | null = null;

  private roleHierarchy: Map<string, number> | null = null;

  /** Configura o validador de tokens usado pelas rotas protegidas por role. */
  configure(handler: AuthTokenHandler): void {
    this.tokenHandler = handler;
  }

  /** Configura níveis opcionais de herança entre roles. */
  configureHierarchy(hierarchy: RoleHierarchy): void {
    if (
      typeof hierarchy !== "object" ||
      hierarchy === null ||
      Array.isArray(hierarchy)
    ) {
      throw new TypeError("A hierarquia de roles deve ser um objeto.");
    }

    const levels = new Map<string, number>();

    for (const [role, level] of Object.entries(hierarchy)) {
      if (!role.trim() || !Number.isInteger(level) || level < 0) {
        throw new RangeError(
          "Cada role deve ter nome não vazio e nível inteiro não negativo.",
        );
      }

      levels.set(role, level);
    }

    this.roleHierarchy = levels;
  }

  /** Indica se um validador de tokens foi configurado. */
  isConfigured(): boolean {
    return this.tokenHandler !== null;
  }

  /**
   * Cria o guard que aplica a regra de autorização de uma rota.
   *
   * @param rule - Role exigida ou função que valida diretamente o token.
   * @returns Guard que responde com erro ou libera a execução com `null`.
   */
  createGuard(
    rule: RouteMetadata["auth"],
    requiresAuthentication = false,
  ): AuthorizationGuard {
    return async (request) => {
      if (!rule && !requiresAuthentication) {
        return null;
      }

      const token = extractBearerToken(request);

      if (!token) {
        return createErrorResponse(401, "Token não fornecido");
      }

      if (typeof rule === "function") {
        return (await rule(token))
          ? null
          : createErrorResponse(403, "Acesso negado");
      }

      if (!this.tokenHandler) {
        return createErrorResponse(500, "Identity não configurado");
      }

      const result = await this.tokenHandler(token);

      if (!result.valid) {
        return createErrorResponse(
          401,
          result.failure === "invalid-claims"
            ? "Claims inválidas"
            : "Token inválido",
        );
      }

      if (result.payload !== undefined) {
        requestContext().user = result.payload;
      }

      if (!rule) {
        return null;
      }

      const requiredRoles = Array.isArray(rule) ? rule : [rule];

      return requiredRoles.some((requiredRole) =>
        result.roles?.some((grantedRole) =>
          this.roleSatisfies(grantedRole, requiredRole),
        ),
      )
        ? null
        : createErrorResponse(403, "Acesso negado");
    };
  }

  private roleSatisfies(grantedRole: string, requiredRole: string): boolean {
    if (grantedRole === requiredRole) return true;

    if (!this.roleHierarchy) return false;

    const grantedLevel = this.roleHierarchy.get(grantedRole);
    const requiredLevel = this.roleHierarchy.get(requiredRole);

    return (
      grantedLevel !== undefined &&
      requiredLevel !== undefined &&
      grantedLevel >= requiredLevel
    );
  }
}
