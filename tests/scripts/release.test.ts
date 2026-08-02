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
    assertReleaseVersions(root, "0.2.0-rc.1");
    const scaffold = JSON.parse(
      readFileSync(resolve(root, "scaffold/package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(scaffold.dependencies.empilha).toBe("^0.2.0-rc.1");
  });

  test("rejeita versão fora da linha 0.2", () => {
    expect(() => prepareRelease(tmpdir(), "1.0.0")).toThrow(
      "Versão de release inválida",
    );
  });
});
