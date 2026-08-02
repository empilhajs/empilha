import { describe, expect, test } from "bun:test";
import {
  createGeneratedQueryManifest,
  defineGeneratedQuery,
  hashSQL,
  verifyGeneratedQuerySQL,
  type GeneratedQuery,
  type GeneratedQueryInputOf,
} from "../../src/sql/generated-query";

describe("generated query artifact", () => {
  test("carrega origem, bindings, cardinalidade e hash estável", () => {
    const options = {
      id: "tasks/list",
      source: "src/tasks.sql:4",
      cardinality: "many" as const,
      bindings: { "query.limit": "number" },
      sql: "SELECT * FROM tasks LIMIT :query.limit",
    };
    const first = defineGeneratedQuery(options);
    const second = defineGeneratedQuery({ ...options });

    expect(first).toMatchObject({
      id: "tasks/list",
      source: "src/tasks.sql:4",
      cardinality: "many",
      bindings: options.bindings,
    });
    expect(first.hash).toBe(second.hash);
    expect(first.sqlHash).toBe(hashSQL(options.sql));
    expect(Object.isFrozen(first)).toBe(true);
  });

  test("detecta SQL fonte desatualizado e gera manifest versionado", () => {
    const query = defineGeneratedQuery({
      id: "tasks/list",
      source: "tasks.sql:1",
      cardinality: "many",
      sql: "SELECT 1",
    });
    expect(verifyGeneratedQuerySQL(query, "SELECT 2").ok).toBe(false);
    expect(verifyGeneratedQuerySQL(query, "SELECT 1").ok).toBe(true);
    expect(createGeneratedQueryManifest([query])).toMatchObject({
      version: 1,
      queries: [{ id: "tasks/list", sqlHash: query.sqlHash }],
    });
  });

  test("mantém o contrato de tipo como artefato público", () => {
    const query: GeneratedQuery = defineGeneratedQuery({
      id: "tasks/execute",
      source: "tasks.sql:1",
      cardinality: "exec",
    });
    expect(query.cardinality).toBe("exec");
  });

  test("expõe o tipo de input declarado pelo artifact", () => {
    type TaskInput = { "query.limit": number };
    const query = defineGeneratedQuery<never, TaskInput>({
      id: "tasks/typed",
      source: "tasks.sql:12",
      cardinality: "many",
    });
    const input: GeneratedQueryInputOf<typeof query> = { "query.limit": 10 };
    expect(input["query.limit"]).toBe(10);
  });
});
