import type { TSchema } from "@sinclair/typebox";
import { serializeJson } from "../utils/serialize-json";

/**
 * Função responsável por serializar um valor
 * para uma string JSON.
 */
type Serializer = (value: unknown) => string;

/**
 * Representa as propriedades de schema utilizadas
 * pelo compilador de serialização.
 */
type SchemaNode = TSchema & {
  type?: string;
  items?: TSchema;
  properties?: Record<string, TSchema>;
  anyOf?: TSchema[];
  oneOf?: TSchema[];
};

/**
 * Representa uma propriedade de objeto preparada
 * para serialização.
 */
type CompiledProperty = {
  name: string;
  serializedName: string;
  serialize: Serializer;
};

/**
 * Serializa um valor usando `JSON.stringify`.
 *
 * Valores que não podem ser serializados diretamente,
 * como `undefined`, são convertidos para `null`.
 *
 * @param value - Valor que será serializado.
 *
 * @returns A representação JSON do valor.
 */
/**
 * Compila um serializer para schemas de array.
 *
 * Cada item é serializado usando o serializer
 * correspondente ao schema definido em `items`.
 *
 * @param items - Schema dos itens do array.
 *
 * @returns O serializer compilado ou `null`
 * quando o schema dos itens não é suportado.
 */
function compileArray(items: TSchema | undefined): Serializer | null {
  if (!items) {
    return null;
  }

  const serializeItem = compile(items);

  if (!serializeItem) {
    return null;
  }

  return (value) => {
    if (!Array.isArray(value)) {
      return serializeJson(value);
    }

    const serializedItems = new Array<string>(value.length);

    for (let index = 0; index < value.length; index++) {
      serializedItems[index] = serializeItem(value[index]);
    }

    return `[${serializedItems.join(",")}]`;
  };
}

/**
 * Compila um serializer para schemas de objeto.
 *
 * Apenas propriedades declaradas no schema são incluídas.
 * Propriedades ausentes ou com valor `undefined` são ignoradas.
 *
 * @param properties - Propriedades declaradas no schema.
 *
 * @returns O serializer compilado ou `null`
 * quando alguma propriedade não é suportada.
 */
function compileObject(
  properties: Record<string, TSchema> | undefined,
): Serializer | null {
  if (!properties) {
    return null;
  }

  const compiledProperties: CompiledProperty[] = [];
  for (const [name, propertySchema] of Object.entries(properties)) {
    const serialize = compile(propertySchema);

    if (!serialize) {
      return null;
    }

    compiledProperties.push({
      name,
      serializedName: serializeJson(name),
      serialize,
    });
  }

  return (value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return serializeJson(value);
    }

    const source = value as Record<string, unknown>;

    const fields: string[] = [];

    for (const property of compiledProperties) {
      if (!Object.hasOwn(source, property.name)) {
        continue;
      }

      const fieldValue = source[property.name];

      if (fieldValue === undefined) {
        continue;
      }

      fields.push(
        `${property.serializedName}:` + property.serialize(fieldValue),
      );
    }

    return `{${fields.join(",")}}`;
  };
}

function matchesSchema(value: unknown, schema: TSchema): boolean {
  const node = schema as SchemaNode;
  if (node.anyOf || node.oneOf) {
    return (node.anyOf ?? node.oneOf ?? []).some((item) =>
      matchesSchema(value, item),
    );
  }

  switch (node.type) {
    case "undefined":
      return value === undefined;
    case "null":
      return value === null;
    case "string":
      return typeof value === "string";
    case "number":
    case "integer":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return (
        value !== null && typeof value === "object" && !Array.isArray(value)
      );
    default:
      return true;
  }
}

function compileUnion(schemas: TSchema[] | undefined): Serializer | null {
  if (!schemas?.length) return null;
  const compiled = schemas.map((schema) => compile(schema));
  if (compiled.some((serializer) => !serializer)) return null;

  return (value) => {
    for (let index = 0; index < compiled.length; index++) {
      if (matchesSchema(value, schemas[index])) {
        return (compiled[index] as Serializer)(value);
      }
    }
    return serializeJson(value);
  };
}

/**
 * Compila um serializer a partir de um schema TypeBox.
 *
 * Schemas primitivos utilizam `JSON.stringify`, enquanto
 * arrays e objetos recebem serializers especializados.
 *
 * @param schema - Schema que será compilado.
 *
 * @returns O serializer compilado ou `null`
 * quando o tipo de schema não é suportado.
 */
function compile(schema: TSchema | undefined): Serializer | null {
  if (!schema) {
    return null;
  }

  const node = schema as SchemaNode;

  const union = compileUnion(node.anyOf ?? node.oneOf);
  if (union) return union;

  switch (node.type) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
    case "null":
      return serializeJson;

    case "array":
      return compileArray(node.items);

    case "object":
      return compileObject(node.properties);

    default:
      return null;
  }
}

/**
 * Compila um serializer de resposta para um schema TypeBox.
 *
 * Quando o schema não possui um serializer especializado,
 * utiliza `JSON.stringify` como fallback.
 *
 * @param schema - Schema da resposta.
 *
 * @returns Uma função que serializa valores para JSON.
 *
 * @example
 * const serialize = compileResponseSerializer(UserSchema)
 *
 * serialize({
 *   id: 1,
 *   name: "Everton",
 * })
 */
export function compileResponseSerializer(schema: TSchema): Serializer {
  return compile(schema) ?? serializeJson;
}
