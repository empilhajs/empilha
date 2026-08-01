import { describe, expect, test } from "bun:test";
import {
  parseRequestPath,
  parseRequestQuery,
} from "../../src/http/request-parsing";

describe("request parsing fuzz regressions", () => {
  test("preserva caminhos e queries codificados em entradas variadas", () => {
    const values = [
      "Ada Lovelace",
      "100%",
      "a/b",
      "ümlaut",
      "__proto__",
      "?&=+#",
      "0",
      "",
    ];

    for (let index = 0; index < 512; index++) {
      const value = `${values[index % values.length]}-${index}`;
      const encoded = encodeURIComponent(value);
      const parsed = parseRequestPath(
        `https://example.test/items/${encoded}?q=${encoded}`,
      );
      const query = parseRequestQuery(
        `https://example.test/items/${encoded}?q=${encoded}`,
        parsed.queryStart,
      );

      expect(parsed.pathname).toBe(`/items/${decodeURI(encoded)}`);
      expect(query.q).toBe(value);
    }
  });

  test("rejeita percent encoding inválido sem lançar tipos inesperados", () => {
    const invalid = ["%", "%0", "%GG", "%E0%A4%A"];

    for (const value of invalid) {
      expect(() => parseRequestPath(`https://example.test/${value}`)).toThrow(
        URIError,
      );
    }
  });
});
