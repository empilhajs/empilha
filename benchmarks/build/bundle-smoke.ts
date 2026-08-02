import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";

type BundleFixture = {
  readonly name: string;
  readonly entrypoint: string;
  readonly mustNotContain?: readonly string[];
};

type BundleResult = {
  readonly name: string;
  readonly bytes: number;
  readonly files: number;
};

const fixtures: readonly BundleFixture[] = [
  {
    name: "hello-world",
    entrypoint: "benchmarks/fixtures/bundle-hello.ts",
    mustNotContain: ["jose", "pg"],
  },
  {
    name: "schema",
    entrypoint: "benchmarks/fixtures/bundle-schema.ts",
    mustNotContain: ["jose", "pg"],
  },
  {
    name: "openapi",
    entrypoint: "benchmarks/fixtures/bundle-openapi.ts",
    mustNotContain: ["jose", "pg"],
  },
  {
    name: "postgres",
    entrypoint: "benchmarks/fixtures/bundle-postgres.ts",
    mustNotContain: ["jose"],
  },
  {
    name: "postgres-jwt",
    entrypoint: "benchmarks/fixtures/bundle-postgres-jwt.ts",
  },
];

const publicSubpaths = [
  "src/index.ts",
  "src/application/index.ts",
  "src/context/index.ts",
  "src/decorators/index.ts",
  "src/di/index.ts",
  "src/errors/index.ts",
  "src/http/index.ts",
  "src/openapi/index.ts",
  "src/schema/index.ts",
  "src/sql/index.ts",
  "packages/pg/src/index.ts",
  "packages/jwt/src/index.ts",
] as const;

async function buildFixture(
  fixture: BundleFixture,
  outdir: string,
): Promise<BundleResult> {
  const result = await Bun.build({
    entrypoints: [resolve(fixture.entrypoint)],
    outdir: resolve(outdir, fixture.name),
    target: "bun",
    format: "esm",
    minify: true,
    external: ["@sinclair/typebox"],
  });
  if (!result.success)
    throw new AggregateError(result.logs, `Falha no fixture ${fixture.name}.`);

  let bytes = 0;
  let files = 0;
  for (const output of result.outputs) {
    files++;
    bytes += output.size;
    if (fixture.mustNotContain?.length) {
      const source = await output.text();
      for (const forbidden of fixture.mustNotContain) {
        if (source.includes(forbidden)) {
          throw new Error(
            `O bundle ${fixture.name} contém a dependência proibida "${forbidden}".`,
          );
        }
      }
    }
  }
  return { name: fixture.name, bytes, files };
}

async function buildPublicSubpaths(outdir: string): Promise<BundleResult[]> {
  const results: BundleResult[] = [];
  for (const entrypoint of publicSubpaths) {
    const name = entrypoint.replaceAll(/[/.]/g, "-");
    const result = await Bun.build({
      entrypoints: [resolve(entrypoint)],
      outdir: resolve(outdir, "subpaths", name),
      target: "bun",
      format: "esm",
      minify: true,
      external: ["@sinclair/typebox", "empilha", "pg", "jose"],
    });
    if (!result.success)
      throw new AggregateError(result.logs, `Falha no subpath ${entrypoint}.`);
    results.push({
      name: entrypoint,
      bytes: result.outputs.reduce((total, output) => total + output.size, 0),
      files: result.outputs.length,
    });
  }
  return results;
}

const outputDirectory = mkdtempSync("/dev/shm/empilha-bundle-smoke-");
mkdirSync(outputDirectory, { recursive: true });
try {
  const results: BundleResult[] = [];
  for (const fixture of fixtures)
    results.push(await buildFixture(fixture, outputDirectory));
  const subpaths = await buildPublicSubpaths(outputDirectory);

  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        target: "bun",
        minify: true,
        fixtures: results,
        subpaths,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(outputDirectory, { recursive: true, force: true });
}
