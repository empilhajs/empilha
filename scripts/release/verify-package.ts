import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type PackageManifest = {
  name: string;
  version: string;
  files?: string[];
  exports?: Record<string, { types?: string; import?: string }>;
};

function verifyVersions(root: string): void {
  const expected = readManifest(root).version;
  const directories = [
    root,
    resolve(root, "packages/jwt"),
    resolve(root, "packages/pg"),
    resolve(root, "scaffold"),
  ];
  for (const directory of directories) {
    const manifest = readManifest(directory);
    if (manifest.version !== expected) {
      throw new Error(
        `Versão dessincronizada: ${manifest.name}=${manifest.version}; esperado ${expected}.`,
      );
    }
  }
}

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
verifyVersions(process.cwd());

function run(
  command: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
): void {
  const result = Bun.spawnSync({
    cmd: command,
    cwd,
    env: { ...process.env, TMPDIR: tmpdir(), ...extraEnv },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0)
    throw new Error(
      `Comando falhou (${result.exitCode}): ${command.join(" ")}`,
    );
}

function verifyTarballConsumer(): void {
  const root = process.cwd();
  const temporaryRoot = mkdtempSync(join(tmpdir(), "empilha-consumer-"));
  try {
    run(["bun", "run", "build"], root);
    run(["bun", "run", "build"], join(root, "packages/jwt"));
    run(["bun", "run", "build"], join(root, "packages/pg"));

    const pack = (directory: string, filename: string): string => {
      const staging = join(temporaryRoot, `${filename}-stage`);
      mkdirSync(staging);
      const manifest = readManifest(directory);
      writeFileSync(
        join(staging, "package.json"),
        readFileSync(join(directory, "package.json")),
      );
      for (const pattern of manifest.files ?? []) {
        if (pattern.includes("*")) continue;
        const source = join(directory, pattern);
        if (!existsSync(source)) continue;
        const target = join(staging, pattern);
        mkdirSync(resolve(target, ".."), { recursive: true });
        cpSync(source, target, { recursive: true });
      }
      run(["bun", "pm", "pack", "--filename", filename, "--quiet"], staging);
      cpSync(join(staging, filename), join(temporaryRoot, filename));
      return join(temporaryRoot, filename);
    };

    const empilha = pack(root, "empilha-consumer.tgz");
    const jwt = pack(join(root, "packages/jwt"), "empilha-jwt-consumer.tgz");
    const pg = pack(join(root, "packages/pg"), "empilha-pg-consumer.tgz");

    mkdirSync(join(temporaryRoot, "src"));
    writeFileSync(
      join(temporaryRoot, "package.json"),
      JSON.stringify(
        {
          name: "empilha-tarball-consumer",
          private: true,
          type: "module",
          scripts: { check: "tsc --noEmit && bun src/smoke.ts" },
          devDependencies: {
            "@types/bun": "^1.3.14",
            typescript: "^7.0.2",
          },
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(
      join(temporaryRoot, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ESNext",
            module: "ESNext",
            moduleResolution: "bundler",
            experimentalDecorators: true,
            strict: true,
            skipLibCheck: true,
            types: ["bun"],
          },
          include: ["src/**/*.ts"],
          exclude: ["node_modules", "*-stage", "bun-cache"],
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(
      join(temporaryRoot, "src/smoke.ts"),
      `import { Controller, Get, createApplication, defineModule } from "empilha";
import * as application from "empilha/application";
import * as context from "empilha/context";
import * as decorators from "empilha/decorators";
import * as di from "empilha/di";
import * as errors from "empilha/errors";
import * as http from "empilha/http";
import * as openapi from "empilha/openapi";
import * as schema from "empilha/schema";
import * as sql from "empilha/sql";
import { postgres } from "@empilha/pg";
import { jwt } from "@empilha/jwt";

for (const subpath of [application, context, decorators, di, errors, http, openapi, schema, sql]) {
  if (!subpath) throw new Error("Subpath público não carregou");
}

@Controller("/tarball")
class TarballController {
  @Get("/")
  get() {
    return { ok: true };
  }
}

const access = jwt({ name: "access", secret: "a".repeat(32) });
const module = defineModule({
  name: "tarball-consumer",
  controllers: [TarballController],
  plugins: [
    postgres({ url: "postgresql://postgres:postgres@localhost:5432/app", healthCheck: false }),
    access,
    access.auth(),
  ],
});

const app = await createApplication(module);
const response = await app.fetch(new Request("http://test/tarball"));
if (response.status !== 200) throw new Error("Resposta inesperada: " + response.status);
await app.close();
`,
    );

    // Instala os artefatos publicados diretamente; --no-save impede que o
    // consumidor transforme os tarballs em dependências file: no manifest.
    run(
      [
        "bun",
        "add",
        "--no-save",
        "--cache-dir",
        join(temporaryRoot, "bun-cache"),
        empilha,
        jwt,
        pg,
        "@sinclair/typebox@^0.34.52",
        "jose@^6.2.4",
        "pg@^8.13.0",
        "typescript@^7.0.2",
        "@types/bun@^1.3.14",
        "@types/pg@^8.11.10",
      ],
      temporaryRoot,
    );
    const consumerManifest = readFileSync(
      join(temporaryRoot, "package.json"),
      "utf8",
    );
    if (consumerManifest.includes("file:")) {
      throw new Error(
        "Consumidor de tarball não pode conter dependências file:.",
      );
    }
    run(["bun", "run", "check"], temporaryRoot);

    const scaffoldRoot = join(temporaryRoot, "scaffold-consumer");
    cpSync(join(root, "scaffold"), scaffoldRoot, {
      recursive: true,
      filter: (source) => !source.endsWith("/bun.lock"),
    });
    const scaffoldManifestPath = join(scaffoldRoot, "package.json");
    const scaffoldManifest = JSON.parse(
      readFileSync(scaffoldManifestPath, "utf8"),
    ) as Record<string, unknown>;
    // O template é testado contra os artefatos recém-publicados, sem alterar
    // o manifest versionado nem introduzir um dependency specifier file:.
    scaffoldManifest.dependencies = {};
    scaffoldManifest.devDependencies = {};
    writeFileSync(
      scaffoldManifestPath,
      JSON.stringify(scaffoldManifest, null, 2) + "\n",
    );
    run(
      [
        "bun",
        "add",
        "--no-save",
        "--cache-dir",
        join(temporaryRoot, "scaffold-bun-cache"),
        empilha,
        jwt,
        pg,
        "@sinclair/typebox@^0.34.52",
        "jose@^6.2.4",
        "pg@^8.13.0",
        "typescript@^7.0.2",
        "@types/bun@^1.3.14",
        "@types/pg@^8.11.10",
      ],
      scaffoldRoot,
    );
    const scaffoldConsumerManifest = readFileSync(scaffoldManifestPath, "utf8");
    if (scaffoldConsumerManifest.includes("file:")) {
      throw new Error(
        "Consumidor do scaffold não pode conter dependências file:.",
      );
    }
    run(["bun", "run", "doctor", "--strict"], scaffoldRoot, {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      JWT_SECRET: "test-secret-with-at-least-32-bytes-long",
    });
    run(["bun", "run", "check"], scaffoldRoot);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv.includes("--consumer")) verifyTarballConsumer();
