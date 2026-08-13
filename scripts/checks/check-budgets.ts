import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type Budget = {
  readonly compileMs: number;
  readonly firstResponseMs: number;
  readonly rssAfterCompile?: number;
};
type Baseline = {
  readonly samples: readonly (Budget & {
    readonly routes: number;
    readonly rssAfterCompile: number;
  })[];
};
type Reference = {
  readonly runtime: Record<
    string,
    { readonly compileMs: number; readonly firstResponseMs: number }
  >;
};
const root = resolve(import.meta.dir, "../..");
const budgets = JSON.parse(
  readFileSync(resolve(root, "benchmarks/budgets.json"), "utf8"),
) as { readonly samples: Record<string, Budget> };
const platformBaseline =
  process.env.EMPILHA_BENCHMARK_BASELINE ??
  (process.platform === "darwin" ? "0.2.3-macos.json" : "0.2.3-linux.json");
const platformPath = resolve(root, "benchmarks/baselines", platformBaseline);
const referencePath = existsSync(platformPath)
  ? platformPath
  : resolve(root, "benchmarks/baselines/0.2.3.json");
const reference = JSON.parse(readFileSync(referencePath, "utf8")) as Reference;
const result = Bun.spawnSync(
  [
    "bun",
    "--expose-gc",
    resolve(root, "benchmarks/runtime/baseline.ts"),
    ...Object.keys(budgets.samples),
  ],
  { cwd: root, stdout: "pipe", stderr: "pipe" },
);
if (result.exitCode !== 0) {
  console.error(new TextDecoder().decode(result.stderr));
  process.exit(result.exitCode ?? 1);
}
const baseline = JSON.parse(
  new TextDecoder().decode(result.stdout),
) as Baseline;
const failures: string[] = [];
const maxRegression =
  (budgets as { readonly maxRegressionPercent?: number })
    .maxRegressionPercent ?? 0;
for (const sample of baseline.samples) {
  const budget = budgets.samples[String(sample.routes)];
  if (!budget) continue;
  for (const key of ["compileMs", "firstResponseMs"] as const) {
    if (sample[key] > budget[key])
      failures.push(
        `${sample.routes} rotas: ${key} ${sample[key].toFixed(2)} > ${budget[key]}`,
      );
  }
  if (budget.rssAfterCompile && sample.rssAfterCompile > budget.rssAfterCompile)
    failures.push(
      `${sample.routes} rotas: rssAfterCompile ${sample.rssAfterCompile} > ${budget.rssAfterCompile}`,
    );

  if (maxRegression > 0) {
    const previous = reference.runtime[`routes${sample.routes}`];
    if (previous) {
      const multiplier = 1 + maxRegression / 100;
      for (const key of ["compileMs", "firstResponseMs"] as const) {
        if (sample[key] > previous[key] * multiplier) {
          failures.push(
            `${sample.routes} rotas: ${key} ${sample[key].toFixed(2)} > ` +
              `baseline ${previous[key].toFixed(2)} x ${multiplier.toFixed(2)}`,
          );
        }
      }
    }
  }
}
console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      bun: Bun.version,
      maxRegressionPercent: maxRegression,
      baseline: referencePath,
      samples: baseline.samples,
      failures,
    },
    null,
    2,
  ),
);
if (failures.length) process.exit(1);
