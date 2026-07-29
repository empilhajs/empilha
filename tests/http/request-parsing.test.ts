import { describe, expect, test } from "bun:test";
import { parseRequestQuery } from "../../src/http/request-parsing";

describe("request query parsing", () => {
  test("preserva a semântica pública em entradas codificadas e repetidas", () => {
    const cases = [
      ["/?name=ana", { name: "ana" }],
      ["/?name=", { name: "" }],
      ["/?name", { name: "" }],
      ["/?name=ana&name=joao", { name: "joao" }],
      ["/?other=1&name=ana", { other: "1", name: "ana" }],
      ["/?name=ana&other=1", { name: "ana", other: "1" }],
      ["/?name=hello+world", { name: "hello world" }],
      ["/?name=hello%20world", { name: "hello world" }],
      ["/?na%6De=ana", { name: "ana" }],
      ["/?name=%E2%9C%93", { name: "✓" }],
      ["/?name=a=b=c", { name: "a=b=c" }],
    ] as const;

    for (const [url, expected] of cases) {
      expect(parseRequestQuery(`http://test${url}`)).toEqual(expected);
    }
  });

  test("rejeita percent encoding inválido", () => {
    expect(() => parseRequestQuery("http://test/?name=%ZZ")).toThrow(URIError);
  });

  test("mantém as bordas do formato de query e ignora fragmento", () => {
    const cases = [
      ["/?name", { name: "" }],
      ["/?name=a=b=c", { name: "a=b=c" }],
      ["/?name=hello+world", { name: "hello world" }],
      ["/?name=%E2%9C%93", { name: "✓" }],
      ["/?name=ana#fragment", { name: "ana" }],
      ["/?name=ana&", { name: "ana" }],
    ] as const;

    for (const [url, expected] of cases) {
      expect(parseRequestQuery(`http://test${url}`)).toEqual(expected);
    }
  });
});
