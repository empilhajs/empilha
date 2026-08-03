import type { TSchema } from "@sinclair/typebox";
import type { ParameterMetadata, RegisteredRouteMetadata } from "../core/types";
import {
  parseRoutePattern,
  type PatternSegment,
} from "../router/route-pattern";
import type { OpenApiParameter, OpenApiSchema } from "./openapi-types";

export function schemaForParameter(
  parameter: ParameterMetadata,
): OpenApiSchema {
  if (parameter.schema) return parameter.schema;
  if (parameter.type === Number) return { type: "number" };
  if (parameter.type === Boolean) return { type: "boolean" };
  return { type: "string" };
}

function parametersForSchema(
  schema:
    | (TSchema & {
        properties?: Record<string, TSchema>;
        required?: string[];
      })
    | undefined,
  location: "query" | "header",
  route: RegisteredRouteMetadata,
): OpenApiParameter[] {
  if (!schema || !schema.properties) return [];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, property]) => ({
    name,
    in: location,
    required:
      required.has(name) &&
      (location === "header" || route.queryDefaults?.[name] === undefined),
    schema: {
      ...property,
      ...(location === "query" && route.queryDefaults?.[name] !== undefined
        ? { default: route.queryDefaults[name] }
        : {}),
    },
  }));
}

function parametersForQuerySchema(
  route: RegisteredRouteMetadata,
): OpenApiParameter[] {
  return parametersForSchema(
    route.querySchema as
      | (TSchema & {
          properties?: Record<string, TSchema>;
          required?: string[];
        })
      | undefined,
    "query",
    route,
  );
}

function parametersForHeaderSchema(
  route: RegisteredRouteMetadata,
): OpenApiParameter[] {
  return parametersForSchema(
    route.headerSchema as
      | (TSchema & {
          properties?: Record<string, TSchema>;
          required?: string[];
        })
      | undefined,
    "header",
    route,
  );
}

export function parametersForRoute(
  route: RegisteredRouteMetadata,
  segments: readonly PatternSegment[],
  omittedOptionalParameter?: string,
): OpenApiParameter[] {
  if (
    route.parameters.length === 0 &&
    route.querySchema === undefined &&
    route.headerSchema === undefined &&
    !segments.some((segment) => segment.kind !== "static")
  )
    return [];

  const routeParameters = new Map(
    segments.flatMap((segment) =>
      segment.kind === "param" || segment.kind === "wildcard"
        ? [[segment.name, segment] as const]
        : [],
    ),
  );
  const parameters: OpenApiParameter[] = route.parameters.flatMap(
    (parameter): OpenApiParameter[] => {
      if (
        parameter.source !== "param" &&
        parameter.source !== "query" &&
        parameter.source !== "header"
      )
        return [];

      const name = parameter.name as string;
      if (parameter.source === "param" && name === omittedOptionalParameter)
        return [];
      const segment = routeParameters.get(name);
      const schema = schemaForParameter(parameter);
      return [
        {
          name,
          in: parameter.source === "param" ? "path" : parameter.source,
          required: parameter.source === "param",
          schema:
            segment?.kind === "param" && segment.expressionSource
              ? ({
                  ...schema,
                  pattern: segment.expressionSource,
                } as OpenApiSchema)
              : schema,
        },
      ];
    },
  );

  const addMissing = (
    items: OpenApiParameter[],
    location: OpenApiParameter["in"],
  ) => {
    const declared = new Set(
      parameters
        .filter((parameter) => parameter.in === location)
        .map((parameter) => parameter.name),
    );
    for (const parameter of items) {
      if (!declared.has(parameter.name)) parameters.push(parameter);
    }
  };
  addMissing(parametersForQuerySchema(route), "query");
  addMissing(parametersForHeaderSchema(route), "header");

  const declaredPath = new Set(
    parameters
      .filter((parameter) => parameter.in === "path")
      .map((parameter) => parameter.name),
  );
  for (const segment of segments) {
    if (segment.kind === "static") continue;
    if (
      segment.name === omittedOptionalParameter ||
      declaredPath.has(segment.name)
    )
      continue;
    parameters.push({
      name: segment.name,
      in: "path",
      required: true,
      schema: {
        type: "string",
        ...(segment.kind === "param" && segment.expressionSource
          ? { pattern: segment.expressionSource }
          : {}),
      },
    });
  }
  return parameters;
}

export type OpenApiPathVariant = {
  path: string;
  segments: PatternSegment[];
  omittedOptionalParameter?: string;
};

export function openApiPathVariants(path: string): OpenApiPathVariant[] {
  const segments = parseRoutePattern(path);
  const render = (items: readonly PatternSegment[]): string =>
    `/${items
      .map((segment) =>
        segment.kind === "static" ? segment.value : `{${segment.name}}`,
      )
      .join("/")}`;
  const optional = segments.at(-1);
  if (optional?.kind !== "param" || !optional.optional)
    return [{ path: render(segments), segments }];
  return [
    {
      path: render(segments.slice(0, -1)),
      segments,
      omittedOptionalParameter: optional.name,
    },
    { path: render(segments), segments },
  ];
}
