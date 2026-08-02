import { resolve } from "node:path";
import { assertReleaseVersions, readPackage } from "./release";

const root = resolve(import.meta.dir, "../..");
const version = process.argv[2] ?? String(readPackage(root).version);
assertReleaseVersions(root, version);

const commands = [
  ["bun", "test"],
  ["bun", "run", "release:artifacts"],
] as const;
for (const command of commands) {
  const result = Bun.spawnSync([...command], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, TMPDIR: process.env.TMPDIR ?? "/tmp" },
  });
  if (result.exitCode !== 0)
    throw new Error(`Validação RC falhou: ${command.join(" ")}`);
}
console.log(
  `Release candidate ${version} validado pelas referências e artefatos.`,
);
