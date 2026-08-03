import { splitPath } from "./path";

export type PatternSegment =
  | { kind: "static"; value: string }
  | {
      kind: "param";
      name: string;
      expression?: RegExp;
      expressionSource?: string;
      optional: boolean;
    }
  | { kind: "wildcard"; name: string };

/** Interpreta e valida a gramática de paths compartilhada pelo router/OpenAPI. */
export function parseRoutePattern(normalizedPath: string): PatternSegment[] {
  const segments = splitPath(normalizedPath);
  return segments.map((segment, index): PatternSegment => {
    if (segment.startsWith("*")) {
      if (!/^\*[A-Za-z_]\w*$/.test(segment)) {
        throw new Error(
          `Wildcard inválido "${segment}" na rota "${normalizedPath}".`,
        );
      }
      if (index !== segments.length - 1) {
        throw new Error(
          `Wildcard deve ser o último segmento na rota "${normalizedPath}".`,
        );
      }
      return { kind: "wildcard", name: segment.slice(1) };
    }

    const match = segment.match(/^:([A-Za-z_]\w*)(?:<(.+)>)?(\?)?$/);
    if (match) {
      if (match[3] && index !== segments.length - 1) {
        throw new Error(
          `Parâmetro opcional deve ser o último segmento na rota "${normalizedPath}".`,
        );
      }
      return {
        kind: "param",
        name: match[1],
        expression: match[2] ? new RegExp(`^(?:${match[2]})$`) : undefined,
        expressionSource: match[2],
        optional: match[3] === "?",
      };
    }

    if (segment.startsWith(":") || segment.includes("*")) {
      throw new Error(
        `Parâmetro inválido "${segment}" na rota "${normalizedPath}".`,
      );
    }
    return { kind: "static", value: segment };
  });
}

export function routeHasPattern(segments: readonly PatternSegment[]): boolean {
  return segments.some(
    (segment) =>
      segment.kind === "wildcard" ||
      (segment.kind === "param" &&
        (segment.optional || segment.expression !== undefined)),
  );
}
