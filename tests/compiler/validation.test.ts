import { describe, expect, test } from "bun:test";
import { compileValidator } from "../../src/decorators/validation";
import { t } from "../../src";

describe("validator compilation", () => {
  test("reutiliza o schema compartilhado entre validators", () => {
    const schema = t.Object({ ok: t.Boolean() });
    const first = compileValidator(schema);
    const second = compileValidator(schema);

    expect(() => first({ ok: true })).not.toThrow();
    expect(() => second({ ok: true })).not.toThrow();
    expect(() => first({ ok: "invalid" })).toThrow();
    expect(() => second({ ok: "invalid" })).toThrow();
  });
});
