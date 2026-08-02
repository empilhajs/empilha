import type { TSchema } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import type { ServerResponse } from "../http/http-adapter";
import { compileResponseSerializer } from "../http/response-serializer";
import { ensureBuiltinFormats } from "../schema/formats";
import type { RouteMetadata } from "../core/types";

/**
 * Cria uma resposta HTTP a partir do valor
 * retornado pelo método do controller.
 */
type ResponseFactory = (value: unknown) => ServerResponse;

type ValidationSetting = boolean | (() => boolean);

function validationEnabled(setting: ValidationSetting): boolean {
  return typeof setting === "function" ? setting() : setting;
}

function responseSchemaForStatus(
  route: RouteMetadata,
  status: number,
): TSchema | undefined {
  return route.responses?.[String(status)] ?? route.responseSchema;
}

/**
 * Representa um schema de resposta já preparado
 * para validação e serialização.
 */
type CompiledResponseSchema = {
  check: (value: unknown) => boolean;
  error: (value: unknown) => string;
  serialize: (value: unknown) => string;
};

/**
 * Armazena validators e serializers compilados.
 *
 * O uso de `WeakMap` permite reutilizar a compilação
 * sem impedir que schemas não utilizados sejam coletados.
 */
const compiledSchemas = new WeakMap<TSchema, CompiledResponseSchema>();

/**
 * Retorna a versão compilada de um schema de resposta.
 *
 * O resultado é reutilizado quando o mesmo objeto
 * de schema já foi compilado anteriormente.
 *
 * @param schema - Schema TypeBox da resposta.
 *
 * @returns As funções de validação e serialização.
 */
function getCompiledSchema(schema: TSchema): CompiledResponseSchema {
  const cached = compiledSchemas.get(schema);

  if (cached) {
    return cached;
  }

  ensureBuiltinFormats();
  const validator = TypeCompiler.Compile(schema);

  const compiled: CompiledResponseSchema = {
    check: (value) => validator.Check(value),
    error: (value) => {
      const first = validator.Errors(value).First();
      return first
        ? `${first.path || "/"}: ${first.message}`
        : "valor incompatível";
    },

    serialize: compileResponseSerializer(schema),
  };

  compiledSchemas.set(schema, compiled);

  return compiled;
}

/**
 * Aplica o contrato de resposta declarado para um status produzido pelo
 * error pipeline. Catchers e erros HTTP já devolvem uma resposta intermediária
 * serializada; aqui ela volta a um valor JSON para receber a mesma validação e
 * serialização das respostas de sucesso.
 */
export function normalizeResponseForRoute(
  route: RouteMetadata,
  response: ServerResponse,
  shouldValidate: ValidationSetting,
): ServerResponse {
  const responseSchema = route.responses?.[String(response.status)];
  if (!responseSchema) return response;

  let value = response.jsonValue;
  if (value === undefined) {
    try {
      value = JSON.parse(response.body);
    } catch {
      throw new Error(
        `A resposta de erro da rota ${String(route.propertyKey)} ` +
          `para o status ${response.status} não contém JSON válido.`,
      );
    }
  }

  const compiled = getCompiledSchema(responseSchema);
  if (validationEnabled(shouldValidate)) {
    assertResponseMatchesSchema(route, value, compiled);
  }

  return {
    ...response,
    body: compiled.serialize(value),
    jsonValue: undefined,
  };
}

/**
 * Verifica se o valor retornado corresponde
 * ao schema declarado pela rota.
 *
 * @param route - Metadados da rota.
 * @param value - Valor retornado pelo controller.
 * @param check - Função de validação compilada.
 *
 * @throws {Error} Quando o valor não corresponde
 * ao schema da resposta.
 */
function assertResponseMatchesSchema(
  route: RouteMetadata,
  value: unknown,
  compiled: Pick<CompiledResponseSchema, "check" | "error">,
): void {
  if (!compiled.check(value)) {
    throw new Error(
      `A resposta da rota ` +
        `${String(route.propertyKey)} ` +
        `não corresponde ao schema declarado (${compiled.error(value)}).`,
    );
  }
}

/**
 * Cria uma resposta de texto simples.
 *
 * Valores `null` ou `undefined` são convertidos
 * para uma string vazia.
 *
 * @param status - Status HTTP da resposta.
 * @param value - Valor que será convertido para texto.
 *
 * @returns A resposta preparada com content type textual.
 */
function textResponse(
  status: number,
  value: unknown,
  contentType = "text/plain; charset=utf-8",
): ServerResponse {
  return {
    status,
    body: value == null ? "" : String(value),
    headers: {
      "Content-Type": contentType,
    },
  };
}

/**
 * Determina o status HTTP padrão de uma rota.
 *
 * Rotas POST usam `201`, rotas DELETE usam `204`
 * e as demais usam `200`, salvo quando `@Status`
 * define um valor explícito.
 *
 * @param route - Metadados da rota.
 *
 * @returns O status HTTP da resposta.
 */
export function statusCode(route: RouteMetadata): number {
  if (route.status !== undefined) {
    return route.status;
  }

  if (route.method === "POST") {
    return 201;
  }

  if (route.method === "DELETE") {
    return 204;
  }

  return 200;
}

/**
 * Compila a factory de respostas de uma rota.
 *
 * A factory considera o status HTTP, o tipo de resposta,
 * o schema declarado e a configuração de validação.
 *
 * @param route - Metadados da rota.
 * @param shouldValidate - Função que informa se a resposta
 * deve ser validada em tempo de execução.
 *
 * @returns Uma função que transforma o valor retornado
 * pelo controller em `ServerResponse`.
 */
export function compileResponseFactory(
  route: RouteMetadata,
  shouldValidate: ValidationSetting,
): ResponseFactory {
  const status = statusCode(route);

  if (status === 204) {
    return () => ({
      status,
      body: "",
    });
  }

  if (route.contentType?.startsWith("text/")) {
    return (value) => textResponse(status, value, route.contentType);
  }

  const responseSchema = responseSchemaForStatus(route, status);
  if (!responseSchema) {
    return (value) => {
      if (value === undefined) {
        return {
          status,
          body: "null",
          headers: route.contentType
            ? { "Content-Type": route.contentType }
            : undefined,
        };
      }

      return {
        status,
        body: "",
        jsonValue: value,
        headers: route.contentType
          ? { "Content-Type": route.contentType }
          : undefined,
      };
    };
  }

  const compiled = getCompiledSchema(responseSchema);

  return (value) => {
    if (validationEnabled(shouldValidate)) {
      assertResponseMatchesSchema(route, value, compiled);
    }

    return {
      status,
      body: compiled.serialize(value),
      headers: route.contentType
        ? { "Content-Type": route.contentType }
        : undefined,
    };
  };
}
