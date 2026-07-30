import { describe, expect, test } from "bun:test";
import { testPostgres } from "../../src";

describe("testPostgres", () => {
  test("registra queries e compartilha resultados com transações", async () => {
    const database = testPostgres([{ id: 1 }]);

    expect(await database.query("SELECT 1")).toEqual({ rows: [{ id: 1 }] });
    const client = await database.connect!();
    expect(await client.query("SELECT 2")).toEqual({ rows: [{ id: 1 }] });

    expect(database.queries).toEqual(["SELECT 1", "SELECT 2"]);
    expect(database.params).toEqual([[], []]);
    database.reset();
    expect(database.queries).toEqual([]);
  });

  test("permite resultados por query", async () => {
    const database = testPostgres({
      rows: [{ id: 1 }],
      onQuery: (sql, params) =>
        sql.includes("DELETE") && params[0] === 1 ? { rows: [] } : undefined,
    });

    expect(await database.query("DELETE FROM users", [1])).toEqual({
      rows: [],
    });
    expect(await database.query("SELECT * FROM users")).toEqual({
      rows: [{ id: 1 }],
    });
  });

  test("seleciona fixtures pelo SQL completo", async () => {
    const database = testPostgres({
      rows: [],
      fixtures: {
        "SELECT * FROM users": [{ id: 1 }],
        "SELECT * FROM tasks": [{ id: 2 }],
      },
    });

    expect(await database.query("SELECT * FROM users")).toEqual({
      rows: [{ id: 1 }],
    });
    expect(await database.query("SELECT * FROM tasks")).toEqual({
      rows: [{ id: 2 }],
    });
  });

  test("seleciona fixtures pelo nome lógico da query", async () => {
    const database = testPostgres({
      rows: [],
      fixtures: {
        findUser: [{ id: 1 }],
      },
    });

    expect(
      await database.query("SELECT id FROM users", [], {
        queryName: "findUser",
      }),
    ).toEqual({ rows: [{ id: 1 }] });
  });
});
