import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

function runGenerator(script: string, target: string, ...args: string[]): void {
  const result = Bun.spawnSync([process.execPath, script, target, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

describe("project generators", () => {
  test("core generator leaves dependency resolution to the new project", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "empilha-create-core-"));
    const target = join(temporaryRoot, "app");

    runGenerator(
      resolve(root, "scripts/application/create-app.ts"),
      target,
      "--framework",
      root,
    );

    expect(existsSync(join(target, "bun.lock"))).toBe(false);
    const manifest = JSON.parse(
      readFileSync(join(target, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    const framework = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ) as { version: string };
    expect(manifest.dependencies.empilha).toBe(`^${framework.version}`);
  });

  test("standalone generator does not copy its publishing lockfile", () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "empilha-create-standalone-"),
    );
    const target = join(temporaryRoot, "app");

    runGenerator(resolve(root, "scaffold/bin/create-empilha.ts"), target);

    expect(existsSync(join(target, "bun.lock"))).toBe(false);
  });
});
