import { requestContext } from "../context";

/**
 * Representa as fontes de dados disponíveis em uma requisição
 * para resolver os bindings usados nas queries SQL.
 */
export type SqlRequest = {
  body?: unknown;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  auth?: Record<string, unknown>;
  identity?: Record<string, unknown>;
};

/**
 * Representa o resultado de uma query SQL preparada.
 */
/**
 * Define as origens válidas para os bindings SQL.
 */
type BindingSource =
  | "body"
  | "param"
  | "query"
  | "header"
  | "auth"
  | "identity";

const BINDING_SOURCES = new Set<BindingSource>([
  "body",
  "param",
  "query",
  "header",
  "auth",
  "identity",
]);

export type SqlValueGetter = (request: SqlRequest) => unknown;

export type CompiledNamedSQL = {
  sql: string;
  bindings: string[];
  named: boolean;
};

export type CompiledBindingTypes = Readonly<Record<string, string>>;
export type CompileNamedSQLOptions = {
  includeTypes?: boolean;
};

function typeScriptTypeForPostgresCast(cast: string): string {
  const normalized = cast.toLowerCase();
  if (["bool", "boolean"].includes(normalized)) return "boolean";
  if (
    [
      "smallint",
      "int2",
      "integer",
      "int",
      "int4",
      "bigint",
      "int8",
      "numeric",
      "decimal",
      "real",
      "float4",
      "double precision",
      "float8",
    ].includes(normalized)
  )
    return "number";
  if (
    [
      "text",
      "varchar",
      "character varying",
      "char",
      "character",
      "uuid",
      "date",
      "time",
      "timestamp",
      "timestamptz",
    ].includes(normalized)
  )
    return "string";
  if (["json", "jsonb"].includes(normalized)) return "unknown";
  return "unknown";
}

/** Valida a sintaxe de um binding antes de a rota ser registrada. */
export function assertSqlBinding(binding: string): void {
  const normalized = binding.endsWith("?") ? binding.slice(0, -1) : binding;
  const parts = normalized.split(".");
  const [source, ...path] = parts;

  if (!BINDING_SOURCES.has(source as BindingSource)) {
    throw new Error(
      `Origem de binding SQL desconhecida "${source}" em "${binding}". ` +
        "Use body.*, param.*, query.*, header.*, auth.* ou identity.*.",
    );
  }

  if (path.length === 0 || (binding.includes("?") && !binding.endsWith("?"))) {
    throw new Error(
      `Binding SQL inválido "${binding}": informe uma propriedade após a origem.`,
    );
  }

  if (
    path.some(
      (part) =>
        !part ||
        !(source === "header"
          ? /^[A-Za-z_$][\w$-]*$/.test(part)
          : /^[A-Za-z_$][\w$]*$/.test(part)),
    )
  ) {
    throw new Error(`Binding SQL inválido "${binding}".`);
  }
}

/**
 * Retorna o valor correspondente à origem informada.
 *
 * Cada origem é associada a uma parte específica da requisição.
 *
 * @param source - Nome da origem do binding.
 * @param req - Dados da requisição.
 *
 * @returns O valor da origem ou `undefined` se ela for inválida.
 */
function getSourceValue(source: string, req: SqlRequest): unknown {
  switch (source as BindingSource) {
    case "body":
      return req.body;
    case "param":
      return req.params;
    case "query":
      return req.query;
    case "header":
      return req.headers;
    case "auth":
      return req.auth ?? requestContext().user;
    case "identity":
      return req.identity ?? req.auth ?? requestContext().user;
    default:
      return undefined;
  }
}

function valueAtPathParts(
  source: string,
  parts: readonly string[],
  req: SqlRequest,
): unknown {
  let value = getSourceValue(source, req);

  for (const part of parts) {
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, part)
    ) {
      return undefined;
    }

    value = (value as Record<string, unknown>)[part];
  }

  return value;
}

function pathExists(
  source: string,
  parts: readonly string[],
  req: SqlRequest,
): boolean {
  let value = getSourceValue(source, req);
  for (const part of parts) {
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, part)
    )
      return false;
    value = (value as Record<string, unknown>)[part];
  }
  return true;
}

export function compileSqlBinding(binding: string): SqlValueGetter {
  assertSqlBinding(binding);
  const presence = binding.endsWith("?");
  const [source, ...parts] = (presence ? binding.slice(0, -1) : binding).split(
    ".",
  );

  return (request) =>
    presence
      ? pathExists(source, parts, request)
      : valueAtPathParts(source, parts, request);
}

/**
 * Compila bindings nomeados em parâmetros posicionais do PostgreSQL.
 *
 * Bindings como `:body.name` são substituídos por `$1`, `$2`
 * e assim por diante. Conversões nativas como `::int`
 * permanecem inalteradas.
 *
 * @param sql - Comando SQL com bindings nomeados.
 * @returns O SQL compilado, os paths dos bindings na ordem dos placeholders
 * e a indicação de que bindings nomeados foram encontrados.
 *
 * @example
 * compileNamedSQL(
 *   `
 *     SELECT *
 *     FROM users
 *     WHERE id = :param.id
 *       AND active = :query.active::boolean
 *   `,
 * )
 *
 * // {
 * //   sql: `
 * //     SELECT *
 * //     FROM users
 * //     WHERE id = $1
 * //       AND active = $2::boolean
 * //   `,
 * //   bindings: ["param.id", "query.active"],
 * //   named: true,
 * // }
 */
export function compileNamedSQL(sql: string): CompiledNamedSQL;
export function compileNamedSQL(
  sql: string,
  options: CompileNamedSQLOptions & { includeTypes: true },
): CompiledNamedSQL & { bindingTypes: CompiledBindingTypes };
export function compileNamedSQL(
  sql: string,
  options: CompileNamedSQLOptions = {},
):
  | CompiledNamedSQL
  | (CompiledNamedSQL & { bindingTypes: CompiledBindingTypes }) {
  const bindings: string[] = [];
  const bindingTypes = new Map<string, string>();
  let prepared = "";
  let index = 0;
  let state: "normal" | "single" | "double" | "dollar" | "line" | "block" =
    "normal";
  let dollarTag = "";
  let blockDepth = 0;

  while (index < sql.length) {
    const current = sql[index];
    const next = sql[index + 1];

    if (state === "single") {
      prepared += current;
      index++;

      if (current === "\\" && next !== undefined) {
        prepared += next;
        index++;
      } else if (current === "'" && next === "'") {
        prepared += next;
        index++;
      } else if (current === "'") {
        state = "normal";
      }

      continue;
    }

    if (state === "double") {
      prepared += current;
      index++;

      if (current === '"' && next === '"') {
        prepared += next;
        index++;
      } else if (current === '"') {
        state = "normal";
      }

      continue;
    }

    if (state === "line") {
      prepared += current;
      index++;

      if (current === "\n") {
        state = "normal";
      }

      continue;
    }

    if (state === "block") {
      prepared += current;
      index++;

      if (current === "/" && next === "*") {
        prepared += next;
        index++;
        blockDepth++;
      } else if (current === "*" && next === "/") {
        prepared += next;
        index++;
        blockDepth--;
        if (blockDepth === 0) state = "normal";
      }

      continue;
    }

    if (state === "dollar") {
      prepared += current;
      index++;

      if (sql.startsWith(dollarTag, index - 1)) {
        prepared += sql.slice(index, index - 1 + dollarTag.length);
        index += dollarTag.length - 1;
        state = "normal";
      }

      continue;
    }

    if (current === "'") {
      state = "single";
      prepared += current;
      index++;
      continue;
    }

    if (current === '"') {
      state = "double";
      prepared += current;
      index++;
      continue;
    }

    if (current === "$") {
      const delimiter = sql
        .slice(index)
        .match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];

      if (delimiter) {
        state = "dollar";
        dollarTag = delimiter;
        prepared += delimiter;
        index += delimiter.length;
        continue;
      }
    }

    if (current === "-" && next === "-") {
      state = "line";
      prepared += "--";
      index += 2;
      continue;
    }

    if (current === "/" && next === "*") {
      state = "block";
      blockDepth = 1;
      prepared += "/*";
      index += 2;
      continue;
    }

    if (current === ":" && sql[index - 1] !== ":") {
      const binding = sql
        .slice(index)
        .match(/^:([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$-]*)+)(\?)?/);

      if (binding) {
        const source = binding[1] as BindingSource;
        const path = binding[2];
        bindings.push(`${source}${path}${binding[3] ?? ""}`);
        const bindingName = bindings.at(-1)!;
        const cast = sql
          .slice(index + binding[0].length)
          .match(/^::\s*([A-Za-z_][\w$]*(?:\s+precision|\s+varying)?)/i);
        const inferredType = binding[3]
          ? "boolean"
          : cast
            ? typeScriptTypeForPostgresCast(cast[1] ?? "")
            : "unknown";
        const previousType = bindingTypes.get(bindingName);
        bindingTypes.set(
          bindingName,
          previousType && previousType !== inferredType
            ? "unknown"
            : inferredType,
        );
        prepared += `$${bindings.length}`;
        index += binding[0].length;

        const following = sql[index];
        if (
          following === "." ||
          following === "?" ||
          (following !== undefined && /[A-Za-z0-9_$-]/.test(following))
        ) {
          throw new Error(
            `Binding SQL inválido "${sql.slice(index - binding[0].length, index + 1)}". ` +
              "Use o formato origem.propriedade ou origem.propriedade?.",
          );
        }

        continue;
      }

      const sourceOnly = sql.slice(index).match(/^:([A-Za-z_$][\w$]*)/);
      if (sourceOnly) {
        throw new Error(
          `Binding SQL inválido "${sql.slice(index, index + sourceOnly[0].length + 1)}". ` +
            "Use o formato origem.propriedade ou origem.propriedade?.",
        );
      }
    }

    prepared += current;
    index++;
  }

  for (const binding of bindings) assertSqlBinding(binding);

  const result = {
    sql: prepared,
    bindings,
    named: bindings.length > 0,
  };
  return options.includeTypes
    ? { ...result, bindingTypes: Object.fromEntries(bindingTypes) }
    : result;
}
