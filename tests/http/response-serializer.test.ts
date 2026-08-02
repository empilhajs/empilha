import { describe, expect, test } from "bun:test";
import { t } from "../../src";
import { compileResponseSerializer } from "../../src/http/response-serializer";

describe("response serializer", () => {
  test("serializa tipos primitivos e arrays e rejeita schema inseguro", () => {
    const serializeString = compileResponseSerializer(t.String());

    const serializeNumber = compileResponseSerializer(t.Number());

    expect(serializeString("x")).toBe('"x"');

    expect(serializeNumber(3)).toBe("3");

    expect(compileResponseSerializer(t.Array(t.Integer()))([1, 2])).toBe(
      "[1,2]",
    );

    expect(() =>
      compileResponseSerializer({ type: "unsupported" } as never),
    ).toThrow("não suportado");
  });

  test("mantém apenas propriedades declaradas e preserva objetos aninhados", () => {
    const serialize = compileResponseSerializer(
      t.Object({
        id: t.Integer(),
        nested: t.Object({ ok: t.Boolean() }),
        optional: t.String(),
        nullable: t.Null(),
      }),
    );

    expect(
      serialize({
        id: 1,
        nested: { ok: true },
        optional: undefined,
        nullable: null,
        extra: "ignored",
      }),
    ).toBe('{"id":1,"nested":{"ok":true},"nullable":null}');
  });

  test("remove campos extras de objetos aninhados em schemas pequenos", () => {
    const serialize = compileResponseSerializer(
      t.Object({ profile: t.Object({ name: t.String() }) }),
    );

    expect(serialize({ profile: { name: "Ada", secret: "hidden" } })).toBe(
      '{"profile":{"name":"Ada"}}',
    );
  });

  test("serializa anyOf e propriedades opcionais", () => {
    const serialize = compileResponseSerializer(
      t.Union([t.String(), t.Number()]),
    );
    const serializeObject = compileResponseSerializer(
      t.Object({ value: t.Optional(t.String()) }),
    );

    expect(serialize("ok")).toBe('"ok"');
    expect(serialize(3)).toBe("3");
    expect(serializeObject({})).toBe("{}");
  });

  test("não escolhe serializer quando oneOf casa com mais de um schema", () => {
    const serialize = compileResponseSerializer({
      oneOf: [t.Object({ a: t.String() }), t.Object({ b: t.String() })],
    } as never);

    expect(() => serialize({ a: "x", b: "y" })).toThrow("único schema");
  });

  test("filtra campos extras em schemas compostos allOf", () => {
    const serialize = compileResponseSerializer(
      t.Intersect([
        t.Object({ id: t.Integer() }),
        t.Object({ name: t.String() }),
      ]),
    );

    expect(serialize({ id: 1, name: "Ada", passwordHash: "hidden" })).toBe(
      '{"id":1,"name":"Ada"}',
    );
  });
});
