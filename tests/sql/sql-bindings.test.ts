import { describe, expect, test } from "bun:test";
import { compileNamedSQL, compileSqlBinding } from "../../src/sql/sql-bindings";

describe("SQL bindings", () => {
  const request = {
    body: {
      user: {
        name: "Ana",
      },
    },
    params: {
      id: "7",
    },
    query: {
      page: "2",
    },
    headers: {
      authorization: "Bearer token",
    },
    auth: {
      sub: "user-123",
      roles: ["user"],
    },
    identity: {
      sub: "user-456",
    },
  };

  test("resolve body, param, query, header, auth, identity e caminhos ausentes", () => {
    expect(compileSqlBinding("body.user.name")(request)).toBe("Ana");
    expect(compileSqlBinding("param.id")(request)).toBe("7");
    expect(compileSqlBinding("query.page")(request)).toBe("2");
    expect(compileSqlBinding("header.authorization")(request)).toBe(
      "Bearer token",
    );
    expect(compileSqlBinding("auth.sub")(request)).toBe("user-123");
    expect(compileSqlBinding("identity.sub")(request)).toBe("user-456");
    expect(compileSqlBinding("body.user.missing")(request)).toBeUndefined();
  });

  test("resolve binding de presença distinguindo campo ausente de null", () => {
    const compiled = compileNamedSQL(
      "SELECT :body.description? AS provided, :body.description AS value",
    );
    const getProvided = compileSqlBinding(compiled.bindings[0]!);
    const getValue = compileSqlBinding(compiled.bindings[1]!);

    expect(getProvided({ body: {} })).toBe(false);
    expect(getProvided({ body: { description: null } })).toBe(true);
    expect(getValue({ body: { description: null } })).toBeNull();
  });

  test("compila SQL e bindings sem depender da requisição", () => {
    const compiled = compileNamedSQL(
      "SELECT :body.user.name, :param.id::int, :query.missing, :auth.sub",
    );

    expect(compiled).toEqual({
      sql: "SELECT $1, $2::int, $3, $4",
      bindings: ["body.user.name", "param.id", "query.missing", "auth.sub"],
      named: true,
    });
  });

  test("não substitui bindings dentro de strings ou comentários", () => {
    const sql = [
      "SELECT ':body.user.name',",
      '"body.user.name",',
      "-- :param.id",
      "\n/* :query.page */",
      ":param.id::int",
    ].join(" ");

    const compiled = compileNamedSQL(sql);
    expect(compiled.sql).toBe(
      "SELECT ':body.user.name', \"body.user.name\", -- :param.id \n/* :query.page */ $1::int",
    );
    expect(compileSqlBinding(compiled.bindings[0])(request)).toBe("7");
  });

  test("explica quando a origem do binding não existe", () => {
    expect(() => compileNamedSQL("SELECT :session.user_id")).toThrow(
      'Origem de binding SQL desconhecida "session"',
    );
  });

  test("não substitui bindings dentro de strings dollar-quoted", () => {
    const prepared = compileNamedSQL(
      "SELECT $$:param.id$$, $tag$:query.page$tag$, :param.id",
    );

    expect(prepared.sql).toBe(
      "SELECT $$:param.id$$, $tag$:query.page$tag$, $1",
    );
    expect(compileSqlBinding(prepared.bindings[0])(request)).toBe("7");
  });

  test("rejeita bindings malformados em vez de enviá-los ao banco", () => {
    for (const sql of [
      "SELECT :body",
      "SELECT :body.",
      "SELECT :body.1title",
      "SELECT :body.title??",
      "SELECT :body.title?extra",
    ]) {
      expect(() => compileNamedSQL(sql)).toThrow("Binding SQL inválido");
    }
  });

  test("preserva casts e escapes de strings PostgreSQL", () => {
    expect(
      compileNamedSQL("SELECT :body.title?::text, E'\\' :body.ignored'").sql,
    ).toBe("SELECT $1::text, E'\\' :body.ignored'");
  });

  test("preserva bindings em comentários de bloco aninhados", () => {
    const compiled = compileNamedSQL(
      "/* outer :body.ignored /* inner :query.ignored */ still ignored */ SELECT :param.id",
    );

    expect(compiled.sql).toBe(
      "/* outer :body.ignored /* inner :query.ignored */ still ignored */ SELECT $1",
    );
    expect(compiled.bindings).toEqual(["param.id"]);
  });

  test("não substitui tokens protegidos em entradas variadas", () => {
    const protectedFragments = [
      "':body.value'",
      '"query.value"',
      "-- :param.value\n",
      "/* :header.value */",
      "$$:identity.value$$",
      "$tag$:auth.value$tag$",
    ];

    for (let index = 0; index < 100; index++) {
      const fragment = protectedFragments[index % protectedFragments.length]!;
      const compiled = compileNamedSQL(
        `SELECT ${fragment}, :param.id, ${fragment}`,
      );

      expect(compiled.bindings).toEqual(["param.id"]);
      expect(compiled.sql).toContain(fragment);
      expect(compiled.sql).toContain("$1");
    }
  });
});
