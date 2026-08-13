import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const packages = [".", "packages/jwt", "packages/pg", "scaffold"] as const;
const version = (
  JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    version: string;
  }
).version;
const npmCache = mkdtempSync(join(tmpdir(), "empilha-npm-cache-"));

try {
  for (const directory of packages) {
    const cwd = resolve(root, directory);
    const manifest = JSON.parse(
      readFileSync(resolve(cwd, "package.json"), "utf8"),
    ) as { name: string; version: string };
    if (manifest.version !== version)
      throw new Error(
        `${manifest.name} está em ${manifest.version}; esperado ${version}`,
      );
    const result = Bun.spawnSync(["npm", "pack", "--dry-run", "--json"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, npm_config_cache: npmCache },
    });
    if (result.exitCode !== 0)
      throw new Error(new TextDecoder().decode(result.stderr));
    const output = JSON.parse(
      new TextDecoder().decode(result.stdout),
    ) as Array<{
      files?: Array<{ path: string }>;
    }>;
    const files = output[0]?.files ?? [];
    if (files.length === 0)
      throw new Error(`${manifest.name} não contém arquivos publicáveis`);
    if (
      files.some(
        ({ path }) =>
          path.includes("node_modules") ||
          path === ".env" ||
          path.endsWith("/.env"),
      )
    )
      throw new Error(`${manifest.name} contém arquivo privado no pacote`);
    console.log(
      `${manifest.name}@${version}: ${files.length} arquivos publicáveis`,
    );
  }
} finally {
  rmSync(npmCache, { recursive: true, force: true });
}
