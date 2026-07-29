import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const directoryArg = args.find((arg) => arg.startsWith("--dir="));
const migrationsDirectory = path.resolve(
  directoryArg?.slice("--dir=".length) ?? "src/database",
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

function output(command: string[]): string {
  const result = Bun.spawnSync({
    cmd: command,
    stdout: "pipe",
    stderr: "inherit",
  });
  if (result.exitCode !== 0)
    throw new Error(`Comando falhou: ${command.join(" ")}`);
  return new TextDecoder().decode(result.stdout).trim();
}

async function checksum(file: string): Promise<string> {
  const bytes = await Bun.file(file).arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Buffer.from(digest).toString("hex");
}

function sqlFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) return sqlFiles(file);
      return entry.isFile() && entry.name.endsWith(".sql") ? [file] : [];
    })
    .sort();
}

function databaseParts(connectionString: string) {
  const url = new URL(connectionString);
  if (!url.protocol.startsWith("postgres")) return null;
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) return null;
  url.pathname = "/postgres";
  return { database, maintenanceUrl: url.toString() };
}

function ensureDatabase(connectionString: string): void {
  const parts = databaseParts(connectionString);
  if (!parts) return;

  const databaseLiteral = parts.database.replaceAll("'", "''");
  const databaseIdentifier = parts.database.replaceAll('"', '""');
  const check = Bun.spawnSync({
    cmd: [
      "psql",
      parts.maintenanceUrl,
      "-tAc",
      `SELECT 1 FROM pg_database WHERE datname = '${databaseLiteral}'`,
    ],
    stdout: "pipe",
    stderr: "inherit",
  });
  if (check.exitCode !== 0)
    throw new Error("Não foi possível conectar ao banco postgres.");
  if (new TextDecoder().decode(check.stdout).trim() === "1") return;

  run([
    "psql",
    parts.maintenanceUrl,
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `CREATE DATABASE "${databaseIdentifier}"`,
  ]);
  console.log(`Banco ${parts.database} criado.`);
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL não está configurada.");
    process.exitCode = 1;
    return;
  }

  const files = sqlFiles(migrationsDirectory);
  if (files.length === 0) {
    console.log(`Nenhuma migration encontrada em ${migrationsDirectory}.`);
    return;
  }

  ensureDatabase(connectionString);
  run([
    "psql",
    connectionString,
    "-q",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `CREATE TABLE IF NOT EXISTS empilha_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  ]);

  for (const file of files) {
    const name = path.relative(migrationsDirectory, file).replaceAll("\\", "/");
    const escapedName = name.replaceAll("'", "''");
    const digest = await checksum(file);
    const applied = output([
      "psql",
      connectionString,
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `SELECT checksum FROM empilha_migrations WHERE name = '${escapedName}'`,
    ]);

    if (applied === digest) {
      console.log(`Já aplicada: ${name}`);
      continue;
    }
    if (applied) {
      throw new Error(
        `Migration alterada depois de aplicada: ${name}. Crie uma nova migration.`,
      );
    }

    console.log(`Executando ${name}`);
    run([
      "psql",
      connectionString,
      "-q",
      "-1",
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      file,
    ]);
    run([
      "psql",
      connectionString,
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `INSERT INTO empilha_migrations (name, checksum) VALUES ('${escapedName}', '${digest}')`,
    ]);
  }
}

await main();
