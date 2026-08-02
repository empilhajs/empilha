import { getOrCreateRoute } from "../core/metadata";

/**
 * Exige uma ou mais roles para autorizar a rota.
 *
 * O framework extrai o bearer token e passa a decisão para o
 * `AuthorizationService`. Com várias roles, basta o token possuir uma delas.
 *
 * @param roles - Nome da role ou lista de roles aceitas.
 * @returns Um decorator de método.
 * @throws {Error} Quando uma role vazia é informada.
 *
 * @example
 * @Roles("admin")
 * deleteUser() {}
 */
export function Roles(...roles: string[]): MethodDecorator {
  const normalizedRoles = roles.map((role) => role.trim());

  if (normalizedRoles.length === 0 || normalizedRoles.some((role) => !role)) {
    throw new Error("O nome do papel de acesso não pode ser vazio.");
  }

  const authRule =
    normalizedRoles.length === 1 ? normalizedRoles[0] : normalizedRoles;

  return (target, propertyKey) => {
    getOrCreateRoute(target, propertyKey).auth = authRule;
  };
}

/** Cria decorators de role com autocomplete e validação de tipos. */
export function defineRoles<const TRoles extends readonly string[]>(
  ..._roles: TRoles
): {
  require(role: TRoles[number] | readonly TRoles[number][]): MethodDecorator;
} {
  return {
    require(role) {
      return Roles(...(Array.isArray(role) ? role : [role]));
    },
  };
}

/**
 * Autoriza a rota usando diretamente o bearer token.
 *
 * Use este decorator quando a aplicação autoriza diretamente pelo bearer
 * token, sem roles nomeadas.
 *
 * @param handler - Função síncrona ou assíncrona que decide o acesso.
 * @returns Um decorator de método.
 * @throws {TypeError} Quando o handler não é uma função.
 */
export function Guard(
  handler: (token: string) => boolean | Promise<boolean>,
): MethodDecorator {
  if (typeof handler !== "function") {
    throw new TypeError("O autorizador deve ser uma função.");
  }

  return (target, propertyKey) => {
    getOrCreateRoute(target, propertyKey).auth = handler;
  };
}
