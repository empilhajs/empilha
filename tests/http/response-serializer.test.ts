import { describe, expect, test } from "bun:test";
import { t } from "../../src";
import { compileResponseSerializer } from "../../src/http/response-serializer";

describe("response serializer", () => {
  test("serializa tipos primitivos, arrays e fallback", () => {
    const serializeString = compileResponseSerializer(t.String());

    const serializeNumber = compileResponseSerializer(t.Number());

    const serializeUnsupported = compileResponseSerializer({
      type: "unsupported",
    } as never);

    expect(serializeString("x")).toBe('"x"');

    expect(serializeNumber(3)).toBe("3");

    expect(compileResponseSerializer(t.Array(t.Integer()))([1, 2])).toBe(
      "[1,2]",
    );

    expect(serializeUnsupported(undefined)).toBe("null");
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
});
