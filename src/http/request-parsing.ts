import { normalizePath } from "../router/path";
import { createStringRecord, EMPTY_STRING_RECORD } from "../utils/records";

/** Resultado do parsing normalizado de um caminho de requisição. */
export type ParsedRequestPath = {
  pathname: string;
  queryStart: number;
};

type UrlParts = readonly [pathStart: number | null, queryStart: number];

function findUrlParts(raw: string): UrlParts {
  const protocolIndex = raw.indexOf("://");

  if (protocolIndex === -1) {
    return [0, raw.indexOf("?")];
  }

  const authorityStart = protocolIndex + 3;
  const slashIndex = raw.indexOf("/", authorityStart);
  const queryIndex = raw.indexOf("?", authorityStart);

  if (slashIndex === -1 || (queryIndex !== -1 && queryIndex < slashIndex)) {
    return [null, queryIndex];
  }

  return [slashIndex, raw.indexOf("?", slashIndex)];
}

function rawPathFromUrl(raw: string, parts = findUrlParts(raw)): string {
  const [pathStart, queryStart] = parts;

  if (pathStart === null) {
    return "/";
  }

  const fragmentStart = raw.indexOf("#", pathStart);
  const end = [
    queryStart === -1 ? raw.length : queryStart,
    fragmentStart === -1 ? raw.length : fragmentStart,
  ].reduce((lowest, value) => Math.min(lowest, value));

  return raw.slice(pathStart, end) || "/";
}

/**
 * Extrai e normaliza o pathname de uma URL de requisição.
 *
 * URLs absolutas e relativas são aceitas. A query string é ignorada e o path
 * é normalizado para o formato usado pelo `RouteTree`.
 *
 * @param raw - URL original da requisição.
 * @returns Path normalizado e a posição inicial da query string.
 * @throws {URIError} Quando o path percent-encoded é inválido.
 */
export function parseRequestPath(raw: string): ParsedRequestPath {
  const parts = findUrlParts(raw);
  const rawPath = rawPathFromUrl(raw, parts);
  const decodedPath = rawPath.includes("%") ? decodeURI(rawPath) : rawPath;

  return {
    pathname: normalizePath(decodedPath),
    queryStart: parts[1],
  };
}

function decodeQueryComponent(value: string): string {
  if (value.indexOf("+") === -1 && value.indexOf("%") === -1) return value;
  return decodeURIComponent(value.replace(/\+/g, " "));
}

/**
 * Converte a query string em um mapa de valores decodificados.
 *
 * Valores sem `=` são tratados como string vazia e o sinal `+` representa um
 * espaço, seguindo o formato tradicional de query string.
 *
 * @param raw - URL original da requisição.
 * @returns Registro com chaves e valores decodificados.
 * @throws {URIError} Quando uma chave ou valor possui encoding inválido.
 */
export function parseRequestQuery(
  raw: string,
  knownQueryStart?: number,
): Record<string, string> {
  const queryStart = knownQueryStart ?? findUrlParts(raw)[1];

  if (queryStart === -1) {
    return EMPTY_STRING_RECORD;
  }

  const query = createStringRecord();
  const fragmentStart = raw.indexOf("#", queryStart + 1);
  const queryEnd = fragmentStart === -1 ? raw.length : fragmentStart;
  const queryString = raw.slice(queryStart + 1, queryEnd);

  let start = 0;

  while (start < queryString.length) {
    const separator = queryString.indexOf("&", start);
    const end = separator === -1 ? queryString.length : separator;
    const part = queryString.slice(start, end);
    start = end + 1;

    if (!part) continue;

    const equalsIndex = part.indexOf("=");
    const rawKey = equalsIndex === -1 ? part : part.slice(0, equalsIndex);
    const rawValue = equalsIndex === -1 ? "" : part.slice(equalsIndex + 1);

    query[decodeQueryComponent(rawKey)] = decodeQueryComponent(rawValue);
  }

  return query;
}

/**
 * Converte `Headers` para um mapa simples indexado por nome.
 *
 * Os nomes já chegam normalizados pelo runtime para a forma usada pelo
 * framework.
 *
 * @param headers - Coleção de headers da requisição.
 * @returns Registro com os headers recebidos.
 */
export function headersToRecord(headers: Headers): Record<string, string> {
  let result: Record<string, string> | undefined;

  headers.forEach((value, name) => {
    result ??= createStringRecord();
    result[name] = value;
  });

  return result ?? EMPTY_STRING_RECORD;
}
