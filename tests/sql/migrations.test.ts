import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { runMigrations } from "../../src/sql";

describe("runtime migrations", () => {
  test("aplica e registra migrations sem depender de psql", async () => {
    const directory = `/tmp/empilha-migrations-${crypto.randomUUID()}`;
    await mkdir(directory, { recursive: true });
    await Bun.write(
      join(directory, "001-create.sql"),
      "CREATE TABLE users (id INT)",
    );
    const calls: string[] = [];
    const rows: unknown[] = [];
    const runner = {
      async query() {
        return { rows: [] };
      },
      async connect() {
        return {
          async query(sql: string) {
            calls.push(sql);
            if (sql.startsWith("SELECT name")) return { rows };
            if (sql.startsWith("INSERT INTO")) {
              rows.push({
                name: "001-create.sql",
                checksum: sql.match(
                  /VALUES \('001-create.sql', '([^']+)'\)/,
                )?.[1],
              });
            }
            return { rows: [] };
          },
          release() {},
        };
      },
    };

    const result = await runMigrations(runner, { directory: `${directory}/` });
    expect(result.applied).toEqual(["001-create.sql"]);
    expect(calls).toContain("BEGIN");
    expect(calls).toContain("COMMIT");
    await rm(directory, { recursive: true, force: true });
  });
});
