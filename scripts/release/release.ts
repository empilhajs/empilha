import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PACKAGE_DIRECTORIES = [
  ".",
  "packages/jwt",
  "packages/pg",
  "scaffold",
] as const;
const RELEASE_VERSION = /^0\.2\.0(?:-(?:alpha|beta|rc)\.\d+)?$/;

export function readPackage(directory: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(directory, "package.json"), "utf8"),
  ) as Record<string, unknown>;
}

export function prepareRelease(root: string, version: string): void {
  if (!RELEASE_VERSION.test(version))
    throw new Error(`Versão de release inválida: ${version}`);
  for (const directory of PACKAGE_DIRECTORIES) {
    const path = resolve(root, directory, "package.json");
    const manifest = readPackage(resolve(root, directory));
    manifest.version = version;
    if (directory === "scaffold") {
      const dependencies = manifest.dependencies as Record<string, string>;
      dependencies.empilha = `^${version}`;
    }
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

export function assertReleaseVersions(root: string, version: string): void {
  if (!RELEASE_VERSION.test(version))
    throw new Error(`Versão de release inválida: ${version}`);
  for (const directory of PACKAGE_DIRECTORIES) {
    const manifest = readPackage(resolve(root, directory));
    if (manifest.version !== version) {
      throw new Error(
        `Versão dessincronizada em ${directory}: ${String(manifest.version)} != ${version}`,
      );
    }
  }
  const scaffold = readPackage(resolve(root, "scaffold"));
  const dependencies = scaffold.dependencies as Record<string, string>;
  for (const name of ["empilha"]) {
    if (dependencies[name] !== `^${version}`)
      throw new Error(
        `Dependência ${name} do scaffold não acompanha ${version}`,
      );
  }
}

const root = resolve(import.meta.dir, "../..");
const version = process.argv[2] ?? String(readPackage(root).version);
if (import.meta.main && version) {
  if (process.argv.includes("--prepare")) prepareRelease(root, version);
  else assertReleaseVersions(root, version);
  console.log(`Release ${version} validada.`);
}
