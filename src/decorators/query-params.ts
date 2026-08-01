import type { TSchema } from "@sinclair/typebox";
import { getOrCreateRoute } from "../metadata";
import { compileValidator } from "./validation";
import { ValidationError } from "../errors/index";

function convertQueryValue(
  value: unknown,
  schema: Record<string, unknown>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => convertQueryValue(item, schema));
  }
  if (typeof value !== "string") return value;
  if (schema.type === "integer" || schema.type === "number") {
    if (value === "" || Number.isNaN(Number(value))) {
      throw new ValidationError([
        { path: "query", message: "Expected a valid number." },
      ]);
    }
    return Number(value);
  }
  if (schema.type === "boolean") return value === "true" || value === "1";
  return value;
}

export function normalizeQueryParams(
  value: Readonly<Record<string, unknown>>,
  schema: TSchema,
  defaults?: Record<string, unknown>,
): Record<string, unknown> {
  const properties = (
    schema as {
      properties?: Record<string, Record<string, unknown>>;
    }
  ).properties;
  const normalized = { ...defaults, ...value };
  if (!properties) return normalized;

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (normalized[key] !== undefined)
      normalized[key] = convertQueryValue(normalized[key], propertySchema);
  }
  return normalized;
}

/** Valida os parâmetros de query de uma rota e aplica defaults declarados. */
export function QueryParams(
  schema: TSchema,
  defaults?: Record<string, unknown>,
): MethodDecorator {
  const validator = compileValidator(schema);

  return (target, propertyKey) => {
    const route = getOrCreateRoute(target, propertyKey);
    route.querySchema = schema;
    route.queryValidator = validator;
    route.queryDefaults = defaults ? { ...defaults } : undefined;
  };
}
