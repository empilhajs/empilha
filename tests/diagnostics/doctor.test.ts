import { describe, expect, test } from "bun:test";
import {
  createDoctorReport,
  formatDoctorReport,
  verifyGeneratedQueryManifest,
} from "../../src/diagnostics";
import { hashSQL } from "../../src/sql/generated-query";
import { runDoctor } from "../../scripts/application/doctor";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { ApplicationGraphBuilder } from "../../src/application/graph";
import { createApplication } from "../../src/application/application";
import { createToken } from "../../src/di";
import { defineModule } from "../../src/modules";

describe("doctor diagnostics", () => {
  test("mantém os mesmos códigos entre doctor e bootstrap", async () => {
    const missing = createToken("doctor/missing");
    const invalidModule = defineModule({
      name: "invalid-doctor",
      exports: [missing],
    });
    const graph = new ApplicationGraphBuilder().build(invalidModule);
    const doctorCodes = graph.diagnostics.map((diagnostic) => diagnostic.code);
    let bootstrapMessage = "";
    try {
      await createApplication(invalidModule);
    } catch (error) {
      bootstrapMessage = String(error);
    }

    const runtimeDirectory = mkdtempSync(join(tmpdir(), "empilha-doctor-"));
    const runtimeFixture = join(runtimeDirectory, "fixture-invalid-runtime.ts");
    const diImport = pathToFileURL(`${process.cwd()}/src/di/index.ts`).href;
    const modulesImport = pathToFileURL(
      `${process.cwd()}/src/modules/index.ts`,
    ).href;
    writeFileSync(
      runtimeFixture,
      `import { createToken } from "${diImport}";\n` +
        `import { defineModule } from "${modulesImport}";\n` +
        `const missing = createToken("doctor/missing");\n` +
        `export default defineModule({ name: "invalid-doctor", exports: [missing] });\n`,
    );
    try {
      expect(doctorCodes).toEqual(["E_MODULE_INVALID_EXPORT"]);
      expect(bootstrapMessage).toContain("E_MODULE_INVALID_EXPORT");
      expect(await runDoctor(["--module", runtimeFixture, "--json"])).toBe(1);
    } finally {
      rmSync(runtimeDirectory, { recursive: true, force: true });
    }
  });

  test("mascara secrets e caminhos no relatório", () => {
    const report = createDoctorReport([
      {
        code: "E_CONFIG",
        severity: "error",
        message:
          `DATABASE_URL=postgres://user:real-password@localhost/app ` +
          `source=${process.cwd()}/config.ts`,
        hint: "Use secret=do-not-print e api_key=also-private.",
      },
    ]);

    const diagnostic = report.diagnostics[0];
    expect(diagnostic?.message).not.toContain("real-password");
    expect(diagnostic?.message).not.toContain(process.cwd());
    expect(diagnostic?.hint).not.toContain("do-not-print");
    expect(diagnostic?.hint).toContain("***");
  });

  test("emite relatório versionado e considera warning no strict", () => {
    const report = createDoctorReport(
      [
        {
          code: "W_EXAMPLE",
          severity: "warning",
          module: "app",
          message: "Configuração incompleta.",
          hint: "Declare a configuração explicitamente.",
        },
      ],
      true,
    );

    expect(report).toMatchObject({ schemaVersion: 1, ok: false });
    expect(formatDoctorReport(report)).toContain("W_EXAMPLE");
    expect(formatDoctorReport(report)).toContain("Sugestão");
  });

  test("formata sujeito e origem de diagnostics em estrutura estável", () => {
    const report = createDoctorReport([
      {
        code: "E_SQL_BINDING_INVALID",
        severity: "error",
        module: "tasks",
        subject: {
          module: "tasks",
          controller: "TaskController",
          method: "list",
        },
        message: "Binding incompatível.",
        source: { file: `${process.cwd()}/src/tasks.sql`, line: 7, column: 3 },
        found: ["body.title", "body.details"],
        hint: "Regere o artifact.",
      },
    ]);

    const output = formatDoctorReport(report);
    expect(output).toContain(
      "✖ [E_SQL_BINDING_INVALID] (tasks > TaskController > list)",
    );
    expect(output).toContain("Origem: <project>/src/tasks.sql:7:3");
    expect(output).toContain("Encontrado: body.title, body.details");
    expect(output).toContain("Sugestão: Regere o artifact.");
    expect(output).toMatchSnapshot();
  });

  test("mantém snapshot dos diagnostics P0 representativos", () => {
    const report = createDoctorReport([
      {
        code: "E_MODULE_INVALID_EXPORT",
        severity: "error",
        module: "modules",
        message: "Export inválido.",
        hint: "Declare o provider.",
      },
      {
        code: "E_PROVIDER_CYCLE",
        severity: "error",
        module: "di",
        message: "Ciclo de providers.",
        hint: "Extraia um token de fronteira.",
      },
      {
        code: "E_PLUGIN_DUPLICATE",
        severity: "error",
        module: "plugins",
        message: "Plugin duplicado.",
        hint: "Remova a segunda instalação.",
      },
      {
        code: "E_ROUTE_DUPLICATE",
        severity: "error",
        module: "routes",
        subject: { controller: "UsersController", method: "list" },
        message: "Rota duplicada.",
        hint: "Mantenha uma única rota.",
      },
      {
        code: "E_SQL_BINDING_INVALID",
        severity: "error",
        module: "sql",
        message: "Binding incompatível.",
        source: { file: "src/tasks.sql", line: 7 },
        hint: "Regere o artifact.",
      },
    ]);

    expect(formatDoctorReport(report)).toMatchSnapshot();
  });

  test("detecta manifest de query desatualizado contra a fonte", () => {
    const directory = mkdtempSync(join(tmpdir(), "empilha-doctor-query-"));
    try {
      writeFileSync(
        join(directory, "tasks.sql"),
        "-- @query taskList many\nSELECT 1;\n",
      );
      const manifest = {
        version: 1 as const,
        queries: [
          {
            id: "taskList",
            source: "tasks.sql:1",
            cardinality: "many" as const,
            sqlHash: hashSQL("SELECT 1;"),
          },
        ],
      };
      expect(verifyGeneratedQueryManifest(manifest, directory)).toEqual([]);
      writeFileSync(
        join(directory, "tasks.sql"),
        "-- @query taskList many\nSELECT 2;\n",
      );
      expect(
        verifyGeneratedQueryManifest(manifest, directory).map(
          (diagnostic) => diagnostic.code,
        ),
      ).toEqual(["E_QUERY_STALE"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("doctor valida manifest importado e falha para SQL stale", async () => {
    const directory = mkdtempSync(join(tmpdir(), "empilha-doctor-cli-"));
    const source = join(directory, "tasks.sql");
    const manifest = join(directory, "manifest.ts");
    try {
      writeFileSync(source, "-- @query taskList many\nSELECT 1;\n");
      writeFileSync(
        manifest,
        `export const queryManifest = ${JSON.stringify({
          version: 1,
          queries: [
            {
              id: "taskList",
              source: `${source}:1`,
              cardinality: "many",
              sqlHash: hashSQL("SELECT 1;"),
            },
          ],
        })} as const;\n`,
      );
      expect(
        await runDoctor([
          "--module",
          "tests/diagnostics/fixture-module.ts",
          "--manifest",
          manifest,
          "--json",
        ]),
      ).toBe(0);
      writeFileSync(source, "-- @query taskList many\nSELECT 2;\n");
      expect(
        await runDoctor([
          "--module",
          "tests/diagnostics/fixture-module.ts",
          "--manifest",
          manifest,
          "--json",
        ]),
      ).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("--module filtra diagnostics pelo nome do módulo", async () => {
    const directory = mkdtempSync(join(tmpdir(), "empilha-doctor-filter-"));
    const sourceRoot = process.cwd();
    const modulesImport = pathToFileURL(
      join(sourceRoot, "src/modules/index.ts"),
    ).href;
    const diImport = pathToFileURL(join(sourceRoot, "src/di/index.ts")).href;
    try {
      mkdirSync(join(directory, "src"));
      writeFileSync(
        join(directory, "src/app.module.ts"),
        `import { defineModule } from "${modulesImport}";
import { createToken } from "${diImport}";
const missing = createToken("doctor/filter-missing");
const tasks = defineModule({ name: "tasks" });
const broken = defineModule({ name: "broken", exports: [missing] });
export default defineModule({ name: "app", imports: [tasks, broken] });
`,
      );
      process.chdir(directory);
      expect(await runDoctor(["--module", "tasks", "--json"])).toBe(0);
      expect(await runDoctor(["--module", "src/app.module.ts", "--json"])).toBe(
        1,
      );
    } finally {
      process.chdir(sourceRoot);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
