import { Kind, type TSchema } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { ensureBuiltinFormats } from "../schema/formats";
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
  allOf?: TSchema[];
  required?: string[];
  const?: unknown;
  enum?: unknown[];
  additionalProperties?: boolean | TSchema;
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

function collectObjectProperties(
  schema: TSchema,
): Record<string, TSchema> | null {
  const node = schema as SchemaNode;
  if (node.type === "object" && node.properties) return node.properties;
  if (!node.allOf?.length) return null;

  const properties: Record<string, TSchema> = Object.create(null) as Record<
    string,
    TSchema
  >;
  for (const member of node.allOf) {
    const memberProperties = collectObjectProperties(member);
    if (!memberProperties) return null;
    Object.assign(properties, memberProperties);
  }
  return properties;
}

/** Compatibilidade para JSON Schema estrutural sem os símbolos do TypeBox. */
function matchesStructuralSchema(value: unknown, schema: TSchema): boolean {
  const node = schema as SchemaNode;
  if (node.const !== undefined && !Object.is(value, node.const)) return false;
  if (node.enum && !node.enum.some((item) => Object.is(value, item)))
    return false;
  if (
    node.anyOf &&
    !node.anyOf.some((item) => matchesStructuralSchema(value, item))
  )
    return false;
  if (
    node.oneOf &&
    node.oneOf.filter((item) => matchesStructuralSchema(value, item)).length !==
      1
  )
    return false;
  if (
    node.allOf &&
    !node.allOf.every((item) => matchesStructuralSchema(value, item))
  )
    return false;

  switch (node.type) {
    case "null":
      return value === null;
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return (
        Array.isArray(value) &&
        (!node.items ||
          value.every((item) =>
            matchesStructuralSchema(item, node.items as TSchema),
          ))
      );
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
      const object = value as Record<string, unknown>;
      const properties = node.properties ?? {};
      if (node.required?.some((name) => !Object.hasOwn(object, name)))
        return false;
      for (const [name, property] of Object.entries(properties)) {
        if (
          Object.hasOwn(object, name) &&
          !matchesStructuralSchema(object[name], property)
        )
          return false;
      }
      for (const [name, propertyValue] of Object.entries(object)) {
        if (Object.hasOwn(properties, name)) continue;
        if (node.additionalProperties === false) return false;
        if (
          typeof node.additionalProperties === "object" &&
          !matchesStructuralSchema(propertyValue, node.additionalProperties)
        )
          return false;
      }
      return true;
    }
    default:
      return true;
  }
}

function compileSchemaMatcher(schema: TSchema): (value: unknown) => boolean {
  if (Kind in schema) {
    const validator = TypeCompiler.Compile(schema);
    return (value) => validator.Check(value);
  }
  return (value) => matchesStructuralSchema(value, schema);
}

function compileUnion(
  schemas: TSchema[] | undefined,
  mode: "anyOf" | "oneOf",
): Serializer | null {
  if (!schemas?.length) return null;
  const compiled = schemas.map((schema) => compile(schema));
  if (compiled.some((serializer) => !serializer)) return null;
  ensureBuiltinFormats();
  const matches = schemas.map(compileSchemaMatcher);

  return (value) => {
    const matchingIndexes = matches.flatMap((matchesSchema, index) =>
      matchesSchema(value) ? [index] : [],
    );
    if (mode === "oneOf") {
      if (matchingIndexes.length !== 1) {
        throw new TypeError(
          "A resposta não corresponde a um único schema oneOf.",
        );
      }
      return (compiled[matchingIndexes[0]] as Serializer)(value);
    }
    if (matchingIndexes.length === 0) {
      throw new TypeError("A resposta não corresponde a nenhum schema anyOf.");
    }
    // anyOf significa "um ou mais". Quando há sobreposição, a primeira
    // declaração compatível fornece uma escolha determinística sem transformar
    // um valor válido pelo JSON Schema em erro 500.
    return (compiled[matchingIndexes[0]] as Serializer)(value);
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

  if (node.allOf) {
    return compileObject(collectObjectProperties(schema) ?? undefined);
  }

  const union = node.anyOf
    ? compileUnion(node.anyOf, "anyOf")
    : compileUnion(node.oneOf, "oneOf");
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
 * Schemas sem serializer seguro são rejeitados durante o registro da rota.
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
  const serializer = compile(schema);
  if (!serializer) {
    throw new TypeError(
      "Schema de resposta não suportado pelo serializer seguro.",
    );
  }
  return serializer;
}
