import fs from "node:fs";
import path from "node:path";
import { runMigrations } from "../database/migrations";

const devArgs = process.argv.slice(2);
const hotReload = devArgs.includes("--hot");
const positional = devArgs.filter((arg) => !arg.startsWith("--"));
const entryFile = positional[0] ?? "src/app.ts";
const databaseDirectory = path.resolve("src/database");
const queriesDirectory = path.resolve("src/queries");
const queryArtifactFile = path.join(queriesDirectory, "query-artifacts.ts");
const moduleFile = path.resolve(
  positional[1] ??
    (fs.existsSync(path.resolve("src/modules/app.module.ts"))
      ? "src/modules/app.module.ts"
      : entryFile),
);

function run(command: string[]): void {
  const result = Bun.spawnSync({
    cmd: command,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0)
    throw new Error(`Comando falhou: ${command.join(" ")}`);
}

async function initializeDatabase(): Promise<void> {
  await runMigrations({
    directory: databaseDirectory,
    missingConnection: "warn",
  });
}

function generateQueryArtifacts(): void {
  if (!fs.existsSync(queriesDirectory)) return;
  run([
    "bun",
    path.join(import.meta.dir, "generate-query-types.ts"),
    queriesDirectory,
    queryArtifactFile,
    "queryArtifacts",
    "--artifacts",
  ]);
}

function diagnose(): void {
  const command = [
    "bun",
    path.join(import.meta.dir, "doctor.ts"),
    "--module",
    moduleFile,
    "--strict",
  ];
  if (fs.existsSync(queryArtifactFile)) {
    command.push(
      "--manifest",
      queryArtifactFile,
      "--manifest-export",
      "queryArtifactsManifest",
    );
  }
  run(command);
}

function refreshBuild(): void {
  generateQueryArtifacts();
  diagnose();
}

try {
  refreshBuild();
} catch (error) {
  console.error("✖ Build inválido; o servidor não será iniciado.");
  throw error;
}

await initializeDatabase();
type DevServer = ReturnType<typeof Bun.spawn>;

function startServer(): DevServer {
  return Bun.spawn(["bun", ...(hotReload ? ["--hot"] : []), entryFile], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
}

let server = startServer();

let stopping = false;
let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
let resolveShutdown: (() => void) | undefined;

const stopServer = async (signal: "SIGINT" | "SIGTERM") => {
  if (stopping) return;

  stopping = true;
  server.kill(signal);

  forceKillTimer = setTimeout(() => {
    server.kill("SIGKILL");
  }, 5_000);
  await server.exited;
  if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
  forceKillTimer = undefined;
  resolveShutdown?.();
};

const onSigint = () => void stopServer("SIGINT");
const onSigterm = () => void stopServer("SIGTERM");

process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);

async function restartServer(): Promise<void> {
  const previous = server;
  previous.kill("SIGTERM");
  await Promise.race([
    previous.exited,
    new Promise<void>((resolve) =>
      setTimeout(() => {
        previous.kill("SIGKILL");
        void previous.exited.then(() => resolve());
      }, 5_000),
    ),
  ]);
  if (stopping) return;
  server = startServer();
  monitorServer(server);
}

function monitorServer(processHandle: DevServer): void {
  processHandle.exited.then((exitCode) => {
    if (stopping) {
      resolveShutdown?.();
      return;
    }
    console.error(
      `⚠ Servidor encerrou com código ${exitCode ?? "desconhecido"}; aguardando rebuild válido.`,
    );
  });
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let rebuildRunning = false;
let rebuildQueued = false;

async function rebuild(): Promise<void> {
  if (stopping) return;
  if (rebuildRunning) {
    rebuildQueued = true;
    return;
  }
  rebuildRunning = true;
  try {
    refreshBuild();
    await restartServer();
    console.log("✓ Rebuild válido; servidor reiniciado.");
  } catch (error) {
    console.error(
      "⚠ Build inválido; o processo atual continua até um rebuild válido.",
    );
    console.error(error instanceof Error ? error.message : String(error));
  } finally {
    rebuildRunning = false;
    if (rebuildQueued) {
      rebuildQueued = false;
      void rebuild();
    }
  }
}

function watchSource(directory: string): fs.FSWatcher | undefined {
  if (!fs.existsSync(directory)) return undefined;
  return fs.watch(directory, { recursive: true }, (_event, filename) => {
    const changed = filename?.toString();
    if (!changed || changed.endsWith("query-artifacts.ts")) return;
    if (!/\.(?:ts|tsx|sql|json)$/.test(changed)) return;
    if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void rebuild();
    }, 100);
  });
}

const watchers = hotReload
  ? []
  : [
      watchSource(path.resolve("src")),
      fs.existsSync(path.resolve("empilha.config.ts"))
        ? fs.watch(path.resolve("empilha.config.ts"), () => void rebuild())
        : undefined,
    ].filter((watcher): watcher is fs.FSWatcher => watcher !== undefined);

monitorServer(server);
console.log("✓ Build válido; iniciando o servidor.");

try {
  await new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });
} finally {
  for (const watcher of watchers) watcher.close();
  if (refreshTimer !== undefined) clearTimeout(refreshTimer);
  if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
}
