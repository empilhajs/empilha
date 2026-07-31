/** Opções usadas ao normalizar um caminho de rota. */
export type NormalizePathOptions = {
  allowEmpty?: boolean;
  label?: string;
};

/**
 * Normaliza um método HTTP removendo espaços e convertendo para maiúsculas.
 *
 * @param method - Método recebido na declaração ou na requisição.
 * @returns Método normalizado.
 * @throws {Error} Quando o método está vazio.
 */
export function normalizeMethod(method: string): string {
  if (
    method === "GET" ||
    method === "POST" ||
    method === "PUT" ||
    method === "PATCH" ||
    method === "DELETE" ||
    method === "HEAD" ||
    method === "OPTIONS"
  ) {
    return method;
  }

  const normalized = method.trim().toUpperCase();

  if (!normalized) {
    throw new Error("O método da rota não pode ser vazio.");
  }

  return normalized;
}

/**
 * Normaliza um caminho de rota.
 *
 * Barras duplicadas são reduzidas, a barra final é removida e caminhos não
 * vazios precisam começar com `/`. O parâmetro `allowEmpty` é usado pelo
 * decorator `@Controller("")` e por rotas raiz.
 *
 * @param path - Caminho que será normalizado.
 * @param options - Regras específicas da chamada.
 * @returns Caminho no formato canônico do router.
 * @throws {Error} Quando o caminho não começa com `/`.
 *
 * @example
 * normalizePath("/users//") // "/users"
 * normalizePath("", { allowEmpty: true }) // ""
 */
export function normalizePath(
  path: string,
  options: NormalizePathOptions = {},
): string {
  const { allowEmpty = false, label = "caminho" } = options;

  // O servidor já entrega paths decodificados e canônicos para o router na
  // maioria das requisições. Evita trim/replace/regex nesse hot path.
  if (
    !allowEmpty &&
    path.length > 0 &&
    path[0] === "/" &&
    (path.length === 1 ||
      (path[path.length - 1] !== "/" && !path.includes("//")))
  ) {
    return path;
  }

  let normalized = path.trim().replace(/\/{2,}/g, "/");

  if (!normalized) {
    return allowEmpty ? "" : "/";
  }

  if (!normalized.startsWith("/")) {
    throw new Error(`O ${label} deve começar com "/": "${path}".`);
  }

  if (normalized.length > 1) {
    normalized = normalized.replace(/\/+$/, "");
  }

  return normalized || "/";
}

/**
 * Divide um caminho em segmentos não vazios.
 *
 * @param path - Caminho normalizado ou bruto.
 * @returns Segmentos usados pelo `RouteTree`.
 */
export function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/**
 * Combina prefixo de controller e caminho de método.
 *
 * @param prefix - Prefixo do controller.
 * @param path - Caminho específico da rota.
 * @returns Caminho final normalizado.
 */
export function joinPaths(prefix: string, path: string): string {
  return normalizePath(`${prefix}/${path}`);
}
