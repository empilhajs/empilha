import type { TSchema } from "@sinclair/typebox";
import { getOrCreateRoute } from "../core/metadata";

/**
 * Define o status HTTP retornado pela rota.
 *
 * @param code - Status entre 100 e 599.
 * @returns Um decorator de método.
 *
 * @throws {RangeError} Quando o status está fora do intervalo HTTP válido.
 *
 * @example
 * @Status(201)
 * create() {}
 */
export function Status(code: number): MethodDecorator {
  if (!Number.isInteger(code) || code < 100 || code > 599) {
    throw new RangeError(`Status HTTP inválido: ${code}`);
  }

  return (target, propertyKey) => {
    getOrCreateRoute(target, propertyKey).status = code;
  };
}

/**
 * Define o schema TypeBox usado para validar a resposta da rota.
 *
 * A validação acontece quando o handler produz a resposta. O schema também é
 * usado pela geração de documentação OpenAPI.
 *
 * @param schema - Schema TypeBox esperado no corpo da resposta.
 * @returns Um decorator de método.
 */
export function Returns(schema: TSchema): MethodDecorator {
  return (target, propertyKey) => {
    getOrCreateRoute(target, propertyKey).responseSchema = schema;
  };
}

/** Define schemas de resposta por status HTTP. */
export function Responses(
  responses: Readonly<Record<number, TSchema>>,
): MethodDecorator {
  const entries = Object.entries(responses);
  if (entries.length === 0) {
    throw new TypeError("@Responses() precisa declarar ao menos um status.");
  }

  const normalized: Record<string, TSchema> = {};
  for (const [rawStatus, schema] of entries) {
    const status = Number(rawStatus);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new RangeError(
        `Status HTTP inválido em @Responses(): ${rawStatus}`,
      );
    }
    if (!schema || typeof schema !== "object") {
      throw new TypeError(
        `O schema da resposta ${status} precisa ser um schema TypeBox válido.`,
      );
    }
    normalized[String(status)] = schema;
  }

  return (target, propertyKey) => {
    getOrCreateRoute(target, propertyKey).responses = Object.freeze({
      ...normalized,
    });
  };
}

/**
 * Marca a resposta da rota como texto simples.
 *
 * O retorno não é serializado como JSON, mesmo quando é uma string válida.
 *
 * @returns Um decorator de método.
 */
export function Produces(contentType: string): MethodDecorator {
  const normalized = contentType.trim().toLowerCase();
  if (!normalized) throw new TypeError("O content type não pode ser vazio.");

  return (target, propertyKey) => {
    getOrCreateRoute(target, propertyKey).contentType = normalized;
  };
}
