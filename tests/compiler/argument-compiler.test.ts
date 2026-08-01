import { describe, expect, test } from "bun:test";
import { compileArgGetters } from "../../src/compiler/argument-compiler";
import type { RouteMetadata } from "../../src/types";

const route = (parameters: RouteMetadata["parameters"]): RouteMetadata => ({
  propertyKey: "run",
  parameters,
});

describe("argument compiler", () => {
  test("ordena por índice e aceita parâmetros não contíguos na metadata ordenada", () => {
    const compile = compileArgGetters(
      route([
        { index: 2, source: "header", name: "token" },
        { index: 0, source: "param", name: "id" },
        { index: 1, source: "query", name: "page" },
      ]),
    );

    const result = compile({
      params: { id: "7" },
      query: { page: "2" },
      body: undefined,
      headers: { token: "abc" },
    });

    expect(result).toEqual(["7", "2", "abc"]);
  });

  test("rejeita índice não contíguo e nome ausente", () => {
    expect(() => {
      compileArgGetters(route([{ index: 1, source: "request" }]));
    }).toThrow("parâmetro 0");

    expect(() => {
      compileArgGetters(route([{ index: 0, source: "param" }]));
    }).toThrow("não possui nome");
  });

  test("converte Number, Boolean, boolean já convertido e valor ausente", () => {
    const compile = compileArgGetters(
      route([
        { index: 0, source: "param", name: "id", type: Number },
        { index: 1, source: "query", name: "active", type: Boolean },
        { index: 2, source: "param", name: "enabled", type: Boolean },
        {
          index: 3,
          source: "param",
          name: "missingBoolean",
          type: Boolean,
        },
        { index: 4, source: "param", name: "missing", type: Number },
      ]),
    );

    const result = compile({
      params: { id: "42", enabled: false, missing: undefined },
      query: { active: "true" },
      body: false,
      headers: {},
    });

    expect(result).toEqual([42, true, false, undefined, undefined]);
  });

  test("executa validator", () => {
    let received: unknown;

    const compile = compileArgGetters({
      ...route([{ index: 0, source: "param", name: "payload" }]),
      validators: new Map([[0, (value) => (received = value)]]),
    });

    compile({
      params: { payload: "payload" },
      query: {},
      body: undefined,
      headers: {},
    });

    expect(received).toBe("payload");
  });

  test("rejeita string vazia como número com erro estruturado", () => {
    const compile = compileArgGetters(
      route([{ index: 0, source: "query", name: "page", type: Number }]),
    );

    try {
      compile({
        params: {},
        query: { page: "" },
        body: undefined,
        headers: {},
      });
      throw new Error("expected conversion to fail");
    } catch (error) {
      expect(error).toMatchObject({
        errors: [{ path: "page", message: "Expected a valid number." }],
      });
    }
  });
});
