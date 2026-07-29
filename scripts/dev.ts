import fs from "node:fs";
import path from "node:path";

const entryFile = process.argv[2] ?? "src/app.ts";
const databaseDirectory = path.resolve("src/database");
const queriesDirectory = path.resolve("src/queries");

function sqlFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) return sqlFiles(file);
      return entry.isFile() && entry.name.endsWith(".sql") ? [file] : [];
    })
    .sort();
}

function run(command: string[]): void {
  const result = Bun.spawnSync({
    cmd: command,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0)
    throw new Error(`Comando falhou: ${command.join(" ")}`);
}

function databaseParts(
  connectionString: string,
): { database: string; maintenanceUrl: string } | null {
  try {
    const url = new URL(connectionString);
    if (!url.protocol.startsWith("postgres")) return null;
    const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (!database) return null;
    url.pathname = "/postgres";
    return { database, maintenanceUrl: url.toString() };
  } catch {
    return null;
  }
}

function ensureDatabase(connectionString: string): void {
  const parts = databaseParts(connectionString);
  if (!parts) return;

  const escapedLiteral = parts.database.replaceAll("'", "''");
  const escapedIdentifier = parts.database.replaceAll('"', '""');
  const check = Bun.spawnSync({
    cmd: [
      "psql",
      parts.maintenanceUrl,
      "-tAc",
      `SELECT 1 FROM pg_database WHERE datname = '${escapedLiteral}'`,
    ],
    stdout: "pipe",
    stderr: "inherit",
  });
  if (check.exitCode !== 0)
    throw new Error(
      "Não foi possível conectar ao banco postgres para verificar DATABASE_URL.",
    );
  if (new TextDecoder().decode(check.stdout).trim() === "1") return;

  run([
    "psql",
    parts.maintenanceUrl,
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `CREATE DATABASE "${escapedIdentifier}"`,
  ]);
  console.log(`Banco ${parts.database} criado.`);
}

async function initializeDatabase(): Promise<void> {
  if (!fs.existsSync(databaseDirectory)) return;

  const files = sqlFiles(databaseDirectory);
  if (files.length === 0) return;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.warn(
      "database/ encontrado, mas DATABASE_URL não está configurada; banco não inicializado.",
    );
    return;
  }

  ensureDatabase(connectionString);
  for (const file of files) {
    console.log(`Executando ${path.relative(process.cwd(), file)}`);
    run(["psql", connectionString, "-q", "-v", "ON_ERROR_STOP=1", "-f", file]);
  }
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
