import { assertSqlBinding, compileNamedSQL } from "../../sql";
import type { RegisteredRouteMetadata } from "../../core/types";

export type RequestDataSource =
  | "body"
  | "param"
  | "query"
  | "header"
  | "auth"
  | "identity";

export function collectSqlSources(sql: string): Set<RequestDataSource> {
  const sources = new Set<RequestDataSource>();
  for (const binding of compileNamedSQL(sql).bindings) {
    sources.add(binding.split(".", 1)[0] as RequestDataSource);
  }
  return sources;
}

export function usesSqlBindingSource(
  route: RegisteredRouteMetadata,
  source: RequestDataSource,
): boolean {
  return Boolean(
    route.sqlParams?.some((binding) => binding.startsWith(`${source}.`)),
  );
}

/** Garante que cada @Param aponta para um segmento real da rota. */
export function assertRoutePathParameters(
  route: RegisteredRouteMetadata,
  path: string,
): void {
  const pathParameters = new Set(
    [...path.matchAll(/:([A-Za-z_$][\w$]*)/g)].map((match) => match[1]),
  );
  for (const parameter of route.parameters) {
    if (parameter.source !== "param" || !parameter.name) continue;
    if (pathParameters.has(parameter.name)) continue;
    throw new Error(
      `@Param("${parameter.name}") na rota ${route.method} ${path} ` +
        "não corresponde a nenhum parâmetro declarado no path.",
    );
  }
}

type SchemaPathFailure = {
  name: string;
  candidates: string[];
  index: number;
};

type SchemaPropertyLookup = {
  schemas: unknown[];
  candidates: string[];
  guaranteed: boolean;
};

function schemaPropertyLookup(
  schema: unknown,
  name: string,
): SchemaPropertyLookup {
  const node = schema as {
    properties?: Record<string, unknown>;
    allOf?: unknown[];
    anyOf?: unknown[];
    oneOf?: unknown[];
  };

  if (node.properties) {
    return {
      schemas: Object.hasOwn(node.properties, name)
        ? [node.properties[name]]
        : [],
      candidates: Object.keys(node.properties),
      guaranteed: Object.hasOwn(node.properties, name),
    };
  }

  const composition = node.allOf ?? node.anyOf ?? node.oneOf;
  if (!composition) {
    return { schemas: [], candidates: [], guaranteed: false };
  }

  const lookups = composition.map((branch) =>
    schemaPropertyLookup(branch, name),
  );
  const candidates = [
    ...new Set(lookups.flatMap((lookup) => lookup.candidates)),
  ];
  const schemas = lookups.flatMap((lookup) => lookup.schemas);
  const isAllOf = node.allOf !== undefined;

  return {
    schemas,
    candidates,
    guaranteed: isAllOf
      ? lookups.some((lookup) => lookup.guaranteed)
      : lookups.every((lookup) => lookup.guaranteed),
  };
}

function invalidSchemaPath(
  schema: unknown,
  parts: readonly string[],
  index = 0,
): SchemaPathFailure | undefined {
  if (index >= parts.length) return undefined;

  const name = parts[index];
  const lookup = schemaPropertyLookup(schema, name);
  if (!lookup.guaranteed) {
    return { name, candidates: lookup.candidates, index };
  }

  for (const child of lookup.schemas) {
    const invalid = invalidSchemaPath(child, parts, index + 1);
    if (invalid) return invalid;
  }

  return undefined;
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );
  for (let row = 1; row <= left.length; row++) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column++) {
      const above = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + Number(left[row - 1] !== right[column - 1]),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

function closestName(
  value: string,
  candidates: readonly string[],
): string | undefined {
  return candidates
    .map((candidate) => ({
      candidate,
      distance: levenshtein(value, candidate),
    }))
    .filter(
      ({ distance, candidate }) =>
        distance <= Math.max(2, candidate.length / 2),
    )
    .sort((left, right) => left.distance - right.distance)[0]?.candidate;
}

export function assertRouteSqlBindings(
  route: RegisteredRouteMetadata,
  bindings: readonly string[],
  path: string,
): void {
  for (const binding of bindings) {
    assertSqlBinding(binding);
    const normalized = binding.endsWith("?") ? binding.slice(0, -1) : binding;
    const [source, ...parts] = normalized.split(".");
    const property = parts[0];

    if (
      (source === "auth" || source === "identity") &&
      !route.auth &&
      !route.requiresAuth
    ) {
      throw new Error(
        `Binding SQL "${binding}" exige uma rota protegida por @Identity ou @Roles.`,
      );
    }

    if (source === "param") {
      const declared = route.parameters.some(
        (parameter) =>
          parameter.source === "param" && parameter.name === property,
      );
      const inPath = new RegExp(`:${property}(?=/|$)`).test(path);
      if (!declared && !inPath) {
        throw new Error(
          `Binding SQL "${binding}" não corresponde a nenhum parâmetro em ${path}.`,
        );
      }
    }

    if (
      (source === "auth" || source === "identity") &&
      route.identitySchema &&
      parts.length > 0
    ) {
      assertSchemaBinding(
        binding,
        parts,
        route.identitySchema,
        `schema de claims da identidade${route.identity ? ` "${route.identity}"` : ""}`,
        source,
      );
    }

    if (parts.length === 0) continue;

    const schemaContract =
      source === "body"
        ? {
            schema: route.bodySchema,
            description: "schema declarado em @Body()",
          }
        : source === "query"
          ? {
              schema: route.querySchema,
              description: "schema declarado em @QueryParams()",
            }
          : source === "header"
            ? {
                schema: route.headerSchema,
                description: "schema declarado em @HeaderParams()",
              }
            : undefined;

    if (!schemaContract) continue;
    if (!schemaContract.schema) {
      throw new Error(
        `Binding SQL "${binding}" não possui schema declarado para a origem "${source}". ` +
          `Use ${source === "body" ? "@Body()" : source === "query" ? "@QueryParams()" : "@HeaderParams()"}.`,
      );
    }

    assertSchemaBinding(
      binding,
      parts,
      schemaContract.schema,
      schemaContract.description,
      source,
    );
  }
}

/** Impede comandos mutáveis dentro de uma transação declarada como read-only. */
export function assertReadOnlyTransactionQuery(
  route: RegisteredRouteMetadata,
  sql: string,
): void {
  if (route.transaction !== "read") return;
  const keyword = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\r\n]*/g, " ")
    .trim()
    .match(/^([A-Za-z]+)/)?.[1]
    ?.toLowerCase();
  if (!keyword || !["insert", "update", "delete", "merge"].includes(keyword))
    return;
  throw new Error(
    `A query da rota está marcada como ${keyword.toUpperCase()}, mas ` +
      'a transação foi declarada como "read". Use @Transaction("write").',
  );
}

function assertSchemaBinding(
  binding: string,
  parts: readonly string[],
  schema: unknown,
  description: string,
  source: string,
): void {
  const invalid = invalidSchemaPath(schema, parts);
  if (!invalid) return;
  const suggestion = closestName(invalid.name, invalid.candidates);
  const prefix = [source, ...parts.slice(0, invalid.index)].join(".");
  throw new Error(
    `Binding SQL "${binding}" não existe no ${description}.` +
      (suggestion
        ? ` Você quis dizer "${prefix ? `${prefix}.` : ""}${suggestion}"?`
        : ""),
  );
}

/** Garante que um query artifact não perdeu nem inventou bindings. */
export function assertGeneratedQueryBindings(
  route: RegisteredRouteMetadata,
  bindings: readonly string[],
  kind: "SQL" | "rota" = "SQL",
): void {
  const artifact = route.queryArtifact;
  if (!artifact) return;
  const declared = Object.keys(artifact.bindings);
  const actual = [...new Set(bindings)];
  const missing = declared.filter((binding) => !actual.includes(binding));
  const extra = actual.filter((binding) => !declared.includes(binding));
  if (missing.length === 0 && extra.length === 0) return;

  const details = [
    missing.length > 0 ? `ausentes: ${missing.join(", ")}` : "",
    extra.length > 0 ? `extras: ${extra.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  throw new Error(
    `Bindings do artifact "${artifact.id}" não correspondem aos bindings da ${kind} (${details}). ` +
      `Origem do artifact: ${artifact.source}.`,
  );
}

/** Compara tipos inferidos pelos casts SQL com os tipos do artefato gerado. */
export function assertGeneratedQueryBindingTypes(
  route: RegisteredRouteMetadata,
  bindingTypes: Readonly<Record<string, string>>,
): void {
  const artifact = route.queryArtifact;
  if (!artifact) return;

  for (const [binding, actualType] of Object.entries(bindingTypes)) {
    const declaredType = artifact.bindings[binding];
    if (
      !declaredType ||
      declaredType === "unknown" ||
      actualType === "unknown" ||
      declaredType === actualType
    )
      continue;
    throw new Error(
      `Tipo do binding "${binding}" no artifact "${artifact.id}" é "${declaredType}", mas o SQL infere "${actualType}". ` +
        `Origem do artifact: ${artifact.source}.`,
    );
  }
}
