import fs from "node:fs";
import path from "node:path";
import { runMigrations } from "./migrations";

const entryFile = process.argv[2] ?? "src/app.ts";
const databaseDirectory = path.resolve("src/database");
const queriesDirectory = path.resolve("src/queries");

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

function generateQueryNames(): void {
  if (!fs.existsSync(queriesDirectory)) return;
  run([
    "bun",
    path.join(import.meta.dir, "generate-query-types.ts"),
    queriesDirectory,
    path.join(queriesDirectory, "query-names.ts"),
    "queryNames",
  ]);
}

await initializeDatabase();
generateQueryNames();
const server = Bun.spawn(["bun", "--watch", entryFile], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

let stopping = false;
let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

const stopServer = (signal: "SIGINT" | "SIGTERM") => {
  if (stopping) return;

  stopping = true;
  server.kill(signal);

  forceKillTimer = setTimeout(() => {
    server.kill("SIGKILL");
  }, 5_000);
};

const onSigint = () => stopServer("SIGINT");
const onSigterm = () => stopServer("SIGTERM");

process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);

try {
  process.exitCode = await server.exited;
} finally {
  if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
}
