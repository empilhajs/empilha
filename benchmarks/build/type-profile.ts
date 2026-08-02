import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

type TypeProfile = {
  readonly routes: number;
  readonly totalMs: number;
  readonly instantiations: number;
  readonly memoryKb: number;
  readonly declarationBytes: number;
};

const sizes = process.argv
  .slice(2)
  .map(Number)
  .filter((size) => Number.isInteger(size) && size > 0);
const routeCounts = sizes.length > 0 ? sizes : [25, 100, 500];
const sourceRoot = resolve(process.cwd(), "src");
const typeScriptBin = resolve(process.cwd(), "node_modules/typescript/bin/tsc");

function fixtureSource(routes: number): string {
  const imports = [
    `import { Controller, Get } from ${JSON.stringify(join(sourceRoot, "decorators/index"))};`,
    `import { defineModule } from ${JSON.stringify(join(sourceRoot, "modules/index"))};`,
  ];
  const controllers: string[] = [];
  const modules: string[] = [];

  for (let index = 0; index < routes; index++) {
    const controller = `TypeController${index}`;
    const module = `TypeModule${index}`;
    controllers.push(
      `@Controller("/${index}") export class ${controller} { @Get("/") route${index}(): string { return "${index}"; } }`,
    );
    modules.push(
      `defineModule({ name: "${module}", controllers: [${controller}] })`,
    );
  }

  return `${imports.join("\n")}
${controllers.join("\n")}
export const modules = [${modules.join(",")}];
export const application = defineModule({ name: "type-profile-root", imports: modules });
`;
}

function fixtureConfig(source: string, declarationDirectory: string): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        rootDir: "/",
        experimentalDecorators: true,
        strict: true,
        skipLibCheck: true,
        types: ["node", "bun"],
        typeRoots: [resolve(process.cwd(), "node_modules/@types")],
        declaration: true,
        emitDeclarationOnly: true,
        outDir: declarationDirectory,
      },
      files: [source],
    },
    null,
    2,
  );
}

function runTypeScript(args: readonly string[]): {
  output: string;
  code: number;
} {
  const result = Bun.spawnSync([process.execPath, typeScriptBin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const decoder = new TextDecoder();
  return {
    output: decoder.decode(result.stdout) + decoder.decode(result.stderr),
    code: result.exitCode,
  };
}

function metric(output: string, label: string): number {
  const match = new RegExp(`^${label}:\\s+([\\d.]+)(?:s|K)?$`, "m").exec(
    output,
  );
  return Number(match?.[1] ?? 0);
}

function entryDeclarationSize(outputDirectory: string, source: string): number {
  const relativeSource = source.replace(/^\//, "").replace(/\.ts$/, ".d.ts");
  return readFileSync(join(outputDirectory, relativeSource)).byteLength;
}

function profile(routes: number): TypeProfile {
  const directory = mkdtempSync("/dev/shm/empilha-types-");
  const source = join(directory, `fixture-${routes}.ts`);
  const declarations = join(directory, "declarations");
  const config = join(directory, "tsconfig.json");
  mkdirSync(declarations, { recursive: true });
  writeFileSync(source, fixtureSource(routes));
  writeFileSync(config, fixtureConfig(source, declarations));

  try {
    const started = performance.now();
    const result = runTypeScript([
      "-p",
      config,
      "--extendedDiagnostics",
      "--noEmit",
    ]);
    const totalMs = performance.now() - started;
    if (result.code !== 0)
      throw new Error(`Type fixture ${routes} falhou:\n${result.output}`);

    const declarationsResult = runTypeScript(["-p", config]);
    if (declarationsResult.code !== 0)
      throw new Error(
        `Geração de declarations ${routes} falhou:\n${declarationsResult.output}`,
      );
    return {
      routes,
      totalMs,
      instantiations: metric(result.output, "Instantiations"),
      memoryKb: metric(result.output, "Memory used"),
      declarationBytes: entryDeclarationSize(declarations, source),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      bun: Bun.version,
      typescript: JSON.parse(
        readFileSync(
          resolve(process.cwd(), "node_modules/typescript/package.json"),
          "utf8",
        ),
      ).version,
      samples: routeCounts.map(profile),
    },
    null,
    2,
  ),
);
