import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type BundleProfile = {
  name: string;
  entrypoint: string;
};

const profiles: BundleProfile[] = [
  { name: "root", entrypoint: "src/index.ts" },
  { name: "http", entrypoint: "src/http/index.ts" },
  { name: "sql", entrypoint: "src/sql/index.ts" },
];

const coldStartEntries = [
  { name: "root", entrypoint: "./src/index.ts" },
  { name: "http", entrypoint: "./src/http/index.ts" },
  { name: "sql", entrypoint: "./src/sql/index.ts" },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

async function measureBundles(): Promise<void> {
  const outputDir = mkdtempSync(join(tmpdir(), "empilha-bundle-"));

  try {
    console.log("\n=== bundle e tree-shaking ===");
    for (const profile of profiles) {
      const result = await Bun.build({
        entrypoints: [profile.entrypoint],
        outdir: join(outputDir, profile.name),
        target: "bun",
        format: "esm",
        minify: true,
        external: ["@sinclair/typebox"],
      });

      if (!result.success) {
        throw new AggregateError(result.logs, `falha ao gerar ${profile.name}`);
      }

      const bytes = result.outputs.reduce(
        (total, output) => total + output.size,
        0,
      );
      console.log(`  ${profile.name.padEnd(8)} ${formatBytes(bytes)}`);
    }

    console.log(
      "  (cada entrypoint é compilado isoladamente; http/sql medem o efeito dos subpaths)",
    );
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

function measureColdStart(): void {
  const samples = 15;
  console.log("\n=== cold start ===");

  for (const profile of coldStartEntries) {
    const durations: number[] = [];

    for (let index = 0; index < samples; index++) {
      const start = performance.now();
      const processResult = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `await import(${JSON.stringify(profile.entrypoint)})`,
        ],
        {
          cwd: process.cwd(),
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      const duration = performance.now() - start;

      if (processResult.exitCode !== 0) {
        throw new Error(`falha ao importar ${profile.entrypoint}`);
      }
      durations.push(duration);
    }

    durations.sort((left, right) => left - right);
    const median = durations[Math.floor(durations.length / 2)];
    const average =
      durations.reduce((total, duration) => total + duration, 0) /
      durations.length;
    console.log(
      `  ${profile.name.padEnd(8)} mediana ${median.toFixed(2)} ms · média ${average.toFixed(2)} ms · ${samples} processos`,
    );
  }
}

await measureBundles();
measureColdStart();
