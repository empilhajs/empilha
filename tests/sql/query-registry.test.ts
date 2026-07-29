import { describe, expect, test } from "bun:test";
import { QueryRegistry } from "../../src/sql/query-registry";

describe("query registry", () => {
  test("registra, normaliza e recupera uma query", () => {
    const registry = new QueryRegistry();
    registry.register(" find ", " SELECT 1 ");

    expect(registry.get("find")).toBe("SELECT 1");
  });

  test("rejeita nome, SQL e registro duplicado", () => {
    const registry = new QueryRegistry();

    expect(() => {
      registry.register(" ", "SELECT 1");
    }).toThrow();

    expect(() => {
      registry.register("empty", " ");
    }).toThrow();

    registry.register("same", "SELECT 1");

    expect(() => {
      registry.register("same", "SELECT 2");
    }).toThrow();

    expect(() => {
      registry.get("missing");
    }).toThrow();
  });

  test("valida bindings ao registrar a query", () => {
    const registry = new QueryRegistry();

    expect(() => registry.register("invalid", "SELECT :session.user")).toThrow(
      'Origem de binding SQL desconhecida "session"',
    );
  });
});
