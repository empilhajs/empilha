import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type BunVersionCheck = Readonly<{
  readonly current: string;
  readonly minimum: string;
  readonly typeBaseline: string;
  readonly ok: boolean;
  readonly errors: readonly string[];
}>;

type Version = readonly [number, number, number];

function parseVersion(value: string): Version | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : undefined;
}

function compareVersions(left: Version, right: Version): number {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function versionFromEngine(engine: string): string {
  const match = />=\s*(\d+\.\d+\.\d+)/.exec(engine);
  if (!match) throw new Error(`Engine Bun não suportado: ${engine}`);
  return match[1]!;
}

export function checkBunVersion(
  current: string,
  minimum: string,
  typeBaseline: string,
): BunVersionCheck {
  const currentVersion = parseVersion(current);
  const minimumVersion = parseVersion(minimum);
  const baselineVersion = parseVersion(typeBaseline);
  const errors: string[] = [];
  if (!currentVersion || !minimumVersion || !baselineVersion) {
    errors.push("Versão Bun inválida no runtime ou nos manifestos.");
  } else {
    if (compareVersions(currentVersion, minimumVersion) < 0)
      errors.push(`Bun ${current} está abaixo do mínimo ${minimum}.`);
    if (compareVersions(currentVersion, baselineVersion) < 0)
      errors.push(
        `Bun ${current} está abaixo da baseline estável testada ${typeBaseline}.`,
      );
  }
  return Object.freeze({
    current,
    minimum,
    typeBaseline,
    ok: errors.length === 0,
    errors: Object.freeze(errors),
  });
}

export function readBunVersionCheck(root = process.cwd()): BunVersionCheck {
  const manifest = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf8"),
  ) as {
    engines?: { bun?: string };
    devDependencies?: { "@types/bun"?: string };
  };
  const typeManifest = JSON.parse(
    readFileSync(resolve(root, "node_modules/@types/bun/package.json"), "utf8"),
  ) as { version: string };
  const minimum = versionFromEngine(manifest.engines?.bun ?? "");
  return checkBunVersion(
    Bun.version,
    minimum,
    typeManifest.version || manifest.devDependencies?.["@types/bun"] || "",
  );
}

if (import.meta.main) {
  const result = readBunVersionCheck();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
