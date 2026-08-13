import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  assertReleaseVersions,
  prepareRelease,
} from "../../scripts/release/release";

describe("release preparation", () => {
  test("sincroniza versões dos quatro pacotes e dependências do scaffold", () => {
    const root = mkdtempSync(join(tmpdir(), "empilha-release-"));
    const source = resolve(import.meta.dir, "../..");
    for (const directory of ["packages/jwt", "packages/pg", "scaffold"])
      cpSync(resolve(source, directory), resolve(root, directory), {
        recursive: true,
      });
    cpSync(resolve(source, "package.json"), resolve(root, "package.json"));
    prepareRelease(root, "0.2.0-rc.1");
    assertReleaseVersions(root, "0.2.0-rc.1", { checkLockfiles: false });
    const scaffold = JSON.parse(
      readFileSync(resolve(root, "scaffold/package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(scaffold.dependencies.empilha).toBe("^0.2.0-rc.1");
  });

  test("aceita patch e prerelease da série 0.2", () => {
    const root = mkdtempSync(join(tmpdir(), "empilha-release-next-"));
    const source = resolve(import.meta.dir, "../..");
    for (const directory of ["packages/jwt", "packages/pg", "scaffold"])
      cpSync(resolve(source, directory), resolve(root, directory), {
        recursive: true,
      });
    cpSync(resolve(source, "package.json"), resolve(root, "package.json"));
    prepareRelease(root, "0.2.1", { regenerateLockfiles: false });
    assertReleaseVersions(root, "0.2.1", { checkLockfiles: false });
    prepareRelease(root, "0.2.1-rc.1", { regenerateLockfiles: false });
    assertReleaseVersions(root, "0.2.1-rc.1", { checkLockfiles: false });
  });

  test("rejeita versões fora da política 0.2.x", () => {
    for (const version of [
      "v0.2.1",
      "0.2",
      "0.2.1.1",
      "0.2.1-preview.1",
      "0.2.01",
      "0.3.0",
    ]) {
      expect(() => prepareRelease(tmpdir(), version)).toThrow(
        "Versão de release inválida",
      );
    }
  });

  test("aceita dry-run sem alterar manifests", () => {
    const root = resolve(import.meta.dir, "../..");
    const result = Bun.spawnSync(
      [
        process.execPath,
        resolve(root, "scripts/release/release.ts"),
        "0.2.4",
        "--dry-run",
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
  });
});
