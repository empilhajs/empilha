import { normalizePath, splitPath } from "../src/router/path";

const iterations = Number(Bun.argv[2] ?? 5_000_000);

function measure(label: string, callback: () => void): void {
  const started = performance.now();
  for (let index = 0; index < iterations; index++) callback();
  const elapsed = performance.now() - started;
  console.log(
    `${label}: ${iterations.toLocaleString("pt-BR")} ops em ${elapsed.toFixed(2)} ms ` +
      `(${Math.round((iterations / elapsed) * 1_000).toLocaleString("pt-BR")} ops/s)`,
  );
}

measure("normalizePath fast path", () => {
  normalizePath("/users/42");
});

measure("normalizePath normalização", () => {
  normalizePath(" //users//42/ ");
});

measure("splitPath", () => {
  splitPath("/users/42/posts");
});
