import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryRegistry } from "../../src/sql/query-registry";
import { loadSQL } from "../../src/sql/sql-loader";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "framework-sql-"));
}

describe("SQL loader", () => {
  test("carrega arquivo SQL único com BOM, CRLF e blocos nomeados", () => {
    const dir = tempDir();
    const registry = new QueryRegistry();

    try {
      const file = join(dir, "queries.sql");

      writeFileSync(
        file,
        "\uFEFF-- @query list\r\nSELECT 1\r\n\r\n-- @query find\r\nSELECT 2\r\n",
      );

      loadSQL(file, registry);

      expect(registry.get("list")).toBe("SELECT 1");
      expect(registry.get("find")).toBe("SELECT 2");
    } finally {
      rmSync(dir, {
        recursive: true,
        force: true,
      });
    }
  });

  test("carrega diretório em ordem determinística e ignora query vazia", () => {
    const dir = tempDir();
    const registry = new QueryRegistry();

    try {
      writeFileSync(join(dir, "b.sql"), "SELECT B");
      writeFileSync(join(dir, "a.sql"), "SELECT A");
      writeFileSync(join(dir, "empty.sql"), "-- @query nothing\n");

      loadSQL(dir, registry);

      expect(registry.get("a")).toBe("SELECT A");
      expect(registry.get("b")).toBe("SELECT B");

      expect(() => {
        registry.get("empty");
      }).toThrow();
    } finally {
      rmSync(dir, {
        recursive: true,
        force: true,
      });
    }
  });

  test("falha para arquivo ou diretório inexistente", () => {
    expect(() => {
      loadSQL("/path/does/not/exist.sql", new QueryRegistry());
    }).toThrow();
  });
});
