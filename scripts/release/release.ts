import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PACKAGE_DIRECTORIES = [
  ".",
  "packages/jwt",
  "packages/pg",
  "scaffold",
] as const;
const RELEASE_VERSION =
  /^0\.2\.(?:0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.(?:0|[1-9]\d*))?$/;
const VERSION_PATTERN = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.(?:0|[1-9]\d*))?`;
const PLUGIN_VERSION_FILES = [
  "packages/jwt/src/index.ts",
  "packages/pg/src/index.ts",
] as const;
const LOCKFILE_DIRECTORIES = [
  "packages/jwt",
  "packages/pg",
  "scaffold",
] as const;

export function readPackage(directory: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(directory, "package.json"), "utf8"),
  ) as Record<string, unknown>;
}

export function prepareRelease(
  root: string,
  version: string,
  options: { regenerateLockfiles?: boolean } = {},
): void {
  if (!RELEASE_VERSION.test(version))
    throw new Error(`Versão de release inválida: ${version}`);
  for (const directory of PACKAGE_DIRECTORIES) {
    const path = resolve(root, directory, "package.json");
    const manifest = readPackage(resolve(root, directory));
    manifest.version = version;
    if (directory === "scaffold") {
      const dependencies = manifest.dependencies as Record<string, string>;
      dependencies.empilha = `^${version}`;
    } else if (directory !== ".") {
      const devDependencies = manifest.devDependencies as Record<
        string,
        string
      >;
      const peerDependencies = manifest.peerDependencies as Record<
        string,
        string
      >;
      devDependencies.empilha = `^${version}`;
      peerDependencies.empilha = `>=${version}`;
    }
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  for (const relativePath of PLUGIN_VERSION_FILES) {
    const path = resolve(root, relativePath);
    const source = readFileSync(path, "utf8");
    writeFileSync(
      path,
      source.replace(
        new RegExp(`version: "${VERSION_PATTERN}"`, "g"),
        `version: "${version}"`,
      ),
    );
  }
  if (options.regenerateLockfiles === true) regenerateLockfiles(root, version);
}

/** Recalcula versões, resoluções e integrities com o resolvedor do Bun. */
export function regenerateLockfiles(root: string, version: string): void {
  for (const directory of LOCKFILE_DIRECTORIES) {
    const lockfile = resolve(root, directory, "bun.lock");
    const before = readFileSync(lockfile, "utf8");
    const beforeLock = Bun.JSON5.parse(before) as {
      packages?: Record<string, unknown>;
    };
    const beforePackages = new Set(Object.keys(beforeLock.packages ?? {}));
    const withoutEmpilha = (source: string): string => {
      const lock = Bun.JSON5.parse(source) as {
        workspaces?: Record<string, Record<string, unknown>>;
        packages?: Record<string, unknown>;
      };
      const workspace = lock.workspaces?.[""];
      for (const section of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
      ]) {
        const entries = workspace?.[section] as
          | Record<string, unknown>
          | undefined;
        if (entries) delete entries.empilha;
      }
      // Bun pode recalcular optionalPeers quando uma peer dependency passa a
      // vir do core. Esse campo não representa uma resolução independente.
      if (workspace) delete workspace.optionalPeers;

      // A nova versão do core pode introduzir dependências transitivas novas
      // (por exemplo, os assets do Swagger). Elas pertencem à atualização de
      // empilha e não devem ser classificadas como uma mudança independente.
      const relatedPackages = new Set(["empilha"]);
      const pending = ["empilha"];
      while (pending.length > 0) {
        const packageName = pending.pop()!;
        const entry = lock.packages?.[packageName] as
          | [string, string, { dependencies?: Record<string, string> }]
          | undefined;
        for (const dependency of Object.keys(entry?.[2]?.dependencies ?? {})) {
          if (
            !beforePackages.has(dependency) &&
            lock.packages?.[dependency] &&
            !relatedPackages.has(dependency)
          ) {
            relatedPackages.add(dependency);
            pending.push(dependency);
          }
        }
      }
      for (const packageName of relatedPackages)
        delete lock.packages?.[packageName];
      return JSON.stringify(lock);
    };
    // Bun preserva resoluções existentes mesmo com --force. Remover apenas a
    // entrada do core obriga uma consulta nova ao registry sem destravar o
    // restante da árvore de dependências.
    writeFileSync(lockfile, withoutEmpilha(before));
    const result = Bun.spawnSync(
      [process.execPath, "install", "--lockfile-only", "--force"],
      {
        cwd: resolve(root, directory),
        env: {
          ...process.env,
          BUN_TMPDIR: process.env.BUN_TMPDIR ?? "/tmp",
          BUN_INSTALL: process.env.BUN_INSTALL ?? "/tmp",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (result.exitCode !== 0) {
      writeFileSync(lockfile, before);
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(
        `Não foi possível regenerar o lockfile de ${directory}: ${stderr.trim()}`,
      );
    }
    const after = readFileSync(lockfile, "utf8");
    if (withoutEmpilha(before) !== withoutEmpilha(after)) {
      writeFileSync(lockfile, before);
      throw new Error(
        `Regeneração do lockfile de ${directory} alterou dependências não relacionadas a empilha.`,
      );
    }
    if (!after.includes(`"empilha@${version}"`)) {
      writeFileSync(lockfile, before);
      throw new Error(
        `Lockfile de ${directory} não resolveu empilha@${version}.`,
      );
    }
  }
}

export function assertReleaseVersions(
  root: string,
  version: string,
  options: { checkLockfiles?: boolean } = {},
): void {
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
  for (const directory of ["packages/jwt", "packages/pg"] as const) {
    const manifest = readPackage(resolve(root, directory));
    const devVersion = (manifest.devDependencies as Record<string, string>)[
      "empilha"
    ];
    const peerVersion = (manifest.peerDependencies as Record<string, string>)[
      "empilha"
    ];
    if (devVersion !== `^${version}` || peerVersion !== `>=${version}`) {
      throw new Error(`Dependências de ${directory} não acompanham ${version}`);
    }
  }
  for (const relativePath of PLUGIN_VERSION_FILES) {
    const source = readFileSync(resolve(root, relativePath), "utf8");
    const versions = [
      ...source.matchAll(new RegExp(`version: "(${VERSION_PATTERN})"`, "g")),
    ];
    if (versions.length === 0 || versions.some((match) => match[1] !== version))
      throw new Error(`Versão dessincronizada em ${relativePath}`);
  }
  if (options.checkLockfiles !== false) {
    for (const directory of LOCKFILE_DIRECTORIES) {
      const source = readFileSync(resolve(root, directory, "bun.lock"), "utf8");
      const versions = [
        ...source.matchAll(new RegExp(`"empilha@(${VERSION_PATTERN})"`, "g")),
      ];
      if (
        versions.length === 0 ||
        versions.some((match) => match[1] !== version)
      )
        throw new Error(`Lockfile dessincronizado em ${directory}`);
    }
  }
}

const root = resolve(import.meta.dir, "../..");
const releaseArgs = process.argv.slice(2);
const version =
  releaseArgs.find((argument) => !argument.startsWith("--")) ??
  String(readPackage(root).version);
if (import.meta.main && version) {
  const skipLockfiles =
    releaseArgs.includes("--skip-lockfiles") ||
    process.env.EMPILHA_RELEASE_SKIP_LOCKFILES === "1";
  if (releaseArgs.includes("--dry-run")) {
    assertReleaseVersions(root, version, {
      checkLockfiles: !skipLockfiles,
    });
  } else if (releaseArgs.includes("--prepare")) {
    prepareRelease(root, version);
  } else if (releaseArgs.includes("--refresh-lockfiles")) {
    regenerateLockfiles(root, version);
    assertReleaseVersions(root, version);
  } else {
    assertReleaseVersions(root, version, {
      checkLockfiles: !skipLockfiles,
    });
  }
  console.log(`Release ${version} validada.`);
}
