import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const tarball = join(
  mkdtempSync(join(tmpdir(), "empilha-core-")),
  "empilha.tgz",
);
const packageDirectories = ["packages/jwt", "packages/pg", "scaffold"] as const;
const originalManifests = new Map<string, string>();
const originalLockfiles = new Map<string, string>();
const pack = Bun.spawnSync(
  ["bun", "pm", "pack", "--filename", tarball, "--quiet"],
  { cwd: root, stdout: "pipe", stderr: "pipe" },
);
if (pack.exitCode !== 0) throw new Error(new TextDecoder().decode(pack.stderr));
for (const directory of packageDirectories) {
  const packageRoot = resolve(root, directory);
  const manifestPath = resolve(packageRoot, "package.json");
  originalManifests.set(manifestPath, readFileSync(manifestPath, "utf8"));
  const lockfilePath = resolve(packageRoot, "bun.lock");
  if (existsSync(lockfilePath))
    originalLockfiles.set(lockfilePath, readFileSync(lockfilePath, "utf8"));
  const add = Bun.spawnSync(["bun", "add", `empilha@${tarball}`], {
    cwd: packageRoot,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, TMPDIR: tmpdir() },
  });
  if (add.exitCode !== 0)
    throw new Error(`Falha ao linkar o core em ${directory}.`);
}
for (const [manifestPath, contents] of originalManifests)
  writeFileSync(manifestPath, contents);
for (const [lockfilePath, contents] of originalLockfiles)
  writeFileSync(lockfilePath, contents);
console.log(
  "Core linkado temporariamente por tarball Bun em JWT, PG e scaffold; manifests restaurados.",
);
