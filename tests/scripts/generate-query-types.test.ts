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
  test("scaffold expõe o comando de geração documentado", () => {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), "scaffold/package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");

    expect(manifest.scripts["generate:queries"]).toContain(
      "generate-query-types.ts",
    );
    expect(readme).toContain("bun run generate:queries");
  });
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
          "scripts/application/generate-query-types.ts",
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

  test("gera artifacts com origem, bindings e cardinalidade", () => {
    const directory = mkdtempSync(join(tmpdir(), "empilha-query-artifacts-"));
    const queries = join(directory, "queries");
    const output = join(directory, "query-artifacts.ts");

    try {
      mkdirSync(queries, { recursive: true });
      writeFileSync(
        join(queries, "tasks.sql"),
        "-- @query taskList many\nSELECT * FROM tasks WHERE owner = :auth.sub AND page = :query.page::int;\n-- @query taskDelete exec\nDELETE FROM tasks WHERE id = :param.id?;\n",
      );

      const result = Bun.spawnSync({
        cmd: [
          "bun",
          "scripts/application/generate-query-types.ts",
          queries,
          output,
          "queryArtifacts",
          "--artifacts",
        ],
        stdout: "pipe",
        stderr: "pipe",
      });

      const generated = readFileSync(output, "utf8");
      expect(result.exitCode).toBe(0);
      expect(generated).toContain("defineGeneratedQuery");
      expect(generated).toContain('"cardinality": "many"');
      expect(generated).toContain('"cardinality": "exec"');
      expect(generated).toContain('"auth.sub": "unknown"');
      expect(generated).toContain('"query.page": "number"');
      expect(generated).toContain('"param.id?": "boolean"');
      expect(generated).toContain('"sqlHash":');
      expect(generated).toContain("queryArtifactsManifest");
      expect(generated).toContain("export type TaskListInput");
      expect(generated).toContain("defineGeneratedQuery<never, TaskListInput>");
      expect(generated).toContain("tasks.sql:1");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
