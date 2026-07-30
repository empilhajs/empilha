import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type PackageManifest = {
  name: string;
  files?: string[];
  exports?: Record<string, { types?: string; import?: string }>;
};

function readManifest(directory: string): PackageManifest {
  return JSON.parse(
    readFileSync(resolve(directory, "package.json"), "utf8"),
  ) as PackageManifest;
}

function verify(directory: string): void {
  const manifest = readManifest(directory);
  const files = manifest.files ?? [];

  for (const pattern of files) {
    if (pattern.includes("*")) continue;
    if (!existsSync(resolve(directory, pattern))) {
      throw new Error(
        `${manifest.name}: arquivo publicado ausente: ${pattern}`,
      );
    }
  }

  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    for (const field of ["types", "import"] as const) {
      const value = target[field];
      if (value && !existsSync(resolve(directory, value))) {
        throw new Error(
          `${manifest.name} ${subpath}: export ${field} ausente: ${value}`,
        );
      }
    }
  }

  console.log(`Package válido: ${manifest.name}`);
}

verify(process.cwd());
verify(resolve(process.cwd(), "packages/jwt"));
verify(resolve(process.cwd(), "packages/pg"));
