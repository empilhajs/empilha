import { assertSqlBinding } from "../sql";
import type { RegisteredRouteMetadata } from "../types";

export type RequestDataSource =
  | "body"
  | "param"
  | "query"
  | "header"
  | "auth"
  | "identity";

const SQL_SOURCE_REGEX =
  /(?<!:):((?:body|param|query|header|auth|identity)\.)/g;

export function collectSqlSources(sql: string): Set<RequestDataSource> {
  const sources = new Set<RequestDataSource>();
  for (const match of sql.matchAll(SQL_SOURCE_REGEX)) {
    sources.add(match[1].slice(0, -1) as RequestDataSource);
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

    if (source === "body" && route.bodySchema && parts.length > 0) {
      const invalid = invalidSchemaPath(route.bodySchema, parts);
      if (invalid) {
        const suggestion = closestName(invalid.name, invalid.candidates);
        const prefix = ["body", ...parts.slice(0, invalid.index)].join(".");
        throw new Error(
          `Binding SQL "${binding}" não existe no schema declarado em @Body().` +
            (suggestion ? ` Você quis dizer "${prefix}.${suggestion}"?` : ""),
        );
      }
    }
  }
}
