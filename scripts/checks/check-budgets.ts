import { readFileSync } from "node:fs";
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
const root = resolve(import.meta.dir, "../..");
const budgets = JSON.parse(
  readFileSync(resolve(root, "benchmarks/budgets.json"), "utf8"),
) as { readonly samples: Record<string, Budget> };
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
}
console.log(
  JSON.stringify(
    { schemaVersion: 1, bun: Bun.version, samples: baseline.samples, failures },
    null,
    2,
  ),
);
if (failures.length) process.exit(1);
