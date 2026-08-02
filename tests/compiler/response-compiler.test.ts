import { describe, expect, test } from "bun:test";
import { t } from "../../src";
import {
  compileResponseFactory,
  statusCode,
} from "../../src/compiler/response-compiler";
import type { RouteMetadata } from "../../src/core/types";

const route = (extra: Partial<RouteMetadata> = {}): RouteMetadata => ({
  propertyKey: "run",
  method: "GET",
  path: "/",
  parameters: [],
  ...extra,
});

describe("response compiler", () => {
  test("usa status padrão 200, POST 201, DELETE 204 e @Status", () => {
    expect(statusCode(route())).toBe(200);
    expect(statusCode(route({ method: "POST" }))).toBe(201);
    expect(statusCode(route({ method: "DELETE" }))).toBe(204);
    expect(statusCode(route({ status: 202 }))).toBe(202);
  });

  test("serializa texto, undefined e resposta sem schema", () => {
    const createTextResponse = compileResponseFactory(
      route({ contentType: "text/plain" }),
      () => true,
    );

    expect(createTextResponse("hello")).toEqual(
      expect.objectContaining({ status: 200, body: "hello" }),
    );

    const createResponse = compileResponseFactory(route(), () => true);
    expect(createResponse(undefined)).toEqual(
      expect.objectContaining({ status: 200, body: "null" }),
    );
  });

  test("valida schema, permite desativar validação e rejeita resposta inválida", () => {
    const schema = t.Object({ id: t.Integer(), name: t.String() });
    const create = compileResponseFactory(
      route({ responseSchema: schema }),
      () => true,
    );

    expect(create({ id: 1, name: "Ana" })).toEqual(
      expect.objectContaining({ body: '{"id":1,"name":"Ana"}' }),
    );
    expect(() => create({ id: "bad" })).toThrow("schema declarado");

    const createWithoutValidation = compileResponseFactory(
      route({ responseSchema: schema }),
      () => false,
    );
    expect(
      createWithoutValidation({ id: 1, name: "Ana", extra: true }).body,
    ).toBe('{"id":1,"name":"Ana"}');
  });

  test("não envia body em 204", () => {
    expect(
      compileResponseFactory(
        route({ method: "DELETE" }),
        () => true,
      )({
        deleted: true,
      }),
    ).toEqual({ status: 204, body: "" });
  });
});
