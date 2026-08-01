import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("generate-query-types", () => {
  test("gera nomes a partir dos cabeçalhos SQL explícitos", () => {
    const directory = mkdtempSync(join(tmpdir(), "empilha-query-types-"));
    const queries = join(directory, "queries");
    const output = join(directory, "query-names.ts");

    try {
      mkdirSync(queries, { recursive: true });
      writeFileSync(
        join(queries, "tasks.sql"),
        "-- comentário\n-- @query taskList\nSELECT 1;\n-- @query taskFind\nSELECT 2;\n",
      );

      const result = Bun.spawnSync({
        cmd: [
          "bun",
          "scripts/generate-query-types.ts",
          queries,
          output,
          "queryNames",
        ],
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(output, "utf8")).toContain('taskFind: "taskFind",');
      expect(readFileSync(output, "utf8")).toContain('taskList: "taskList",');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
