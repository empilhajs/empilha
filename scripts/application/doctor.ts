#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type DoctorDiagnostic = {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly module?: string;
  readonly hint?: string;
};

type GeneratedQueryManifest = {
  readonly version: 1;
  readonly queries: readonly {
    readonly id: string;
    readonly source: string;
    readonly cardinality: "one" | "many" | "exec";
    readonly sqlHash: string;
  }[];
};

async function loadFramework(): Promise<typeof import("empilha")> {
  const sourceEntry = resolve(import.meta.dir, "../../src/index.ts");
  return import(
    existsSync(sourceEntry) ? pathToFileURL(sourceEntry).href : "empilha"
  ) as Promise<typeof import("empilha")>;
}

type DoctorOptions = {
  modulePath: string;
  json: boolean;
  strict: boolean;
  moduleName?: string;
  moduleFilter?: string;
  manifestPath?: string;
  manifestExport: string;
};

function parseArgs(args: readonly string[]): DoctorOptions {
  const getValue = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  const moduleArgument = getValue("--module");
  const modulePath = moduleArgument && existsSync(resolve(moduleArgument));
  return {
    modulePath: modulePath ? moduleArgument : "src/app.module.ts",
    json: args.includes("--json"),
    strict: args.includes("--strict"),
    moduleName: getValue("--module-name"),
    moduleFilter:
      getValue("--module-filter") ??
      (moduleArgument && !modulePath ? moduleArgument : undefined),
    manifestPath: getValue("--manifest"),
    manifestExport: getValue("--manifest-export") ?? "queryManifest",
  };
}

export async function runDoctor(args = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(args);
  const framework = await loadFramework();
  try {
    const resolvedModulePath = resolve(options.modulePath);
    const moduleUrl = pathToFileURL(resolvedModulePath);
    const moduleStat = Bun.file(resolvedModulePath);
    moduleUrl.searchParams.set(
      "version",
      `${moduleStat.lastModified}-${moduleStat.size}`,
    );
    const loaded = await import(moduleUrl.href);
    const candidate = options.moduleName
      ? loaded[options.moduleName]
      : (loaded.default ?? loaded.AppModule);
    if (!framework.isModuleDefinition(candidate)) {
      throw new Error(
        `O módulo "${options.modulePath}" não exporta um ModuleDefinition ` +
          "como default ou AppModule.",
      );
    }
    const graphDiagnostics = framework.diagnoseApplication(candidate);
    const manifestDiagnostics: DoctorDiagnostic[] = [];
    if (options.manifestPath) {
      const loadedManifest = await import(
        pathToFileURL(resolve(options.manifestPath)).href
      );
      const manifest = (loadedManifest[options.manifestExport] ??
        loadedManifest.default) as GeneratedQueryManifest | undefined;
      if (!manifest)
        throw new Error(
          `O arquivo "${options.manifestPath}" não exporta ${options.manifestExport}.`,
        );
      manifestDiagnostics.push(
        ...framework.verifyGeneratedQueryManifest(manifest, process.cwd()),
      );
    }
    const diagnostics = options.moduleFilter
      ? graphDiagnostics.filter(
          (diagnostic) => diagnostic.module === options.moduleFilter,
        )
      : graphDiagnostics;
    const report = framework.createDoctorReport(
      [...diagnostics, ...manifestDiagnostics],
      options.strict,
    );
    console.log(
      options.json
        ? JSON.stringify(report, null, 2)
        : framework.formatDoctorReport(report),
    );
    return report.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      console.log(
        JSON.stringify(
          framework.createDoctorReport([
            { code: "E_DOCTOR_LOAD", severity: "error", message },
          ]),
          null,
          2,
        ),
      );
    } else console.error(`✖ [E_DOCTOR_LOAD] ${message}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runDoctor();
