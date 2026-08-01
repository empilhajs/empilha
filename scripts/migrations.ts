import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Migration = {
  file: string;
  name: string;
  checksum: string;
};

export type RunMigrationsOptions = {
  directory: string;
  connectionString?: string;
  missingConnection?: "error" | "warn";
};

function run(command: string[]): void {
  const result = Bun.spawnSync({
    cmd: command,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0)
    throw new Error(`Comando falhou: ${command.join(" ")}`);
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

  const databaseLiteral = parts.database.replaceAll("'", "''");
  const databaseIdentifier = parts.database.replaceAll('"', '""');
  const exists = () => {
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
    return new TextDecoder().decode(check.stdout).trim() === "1";
  };

  if (exists()) return;

  try {
    run([
      "psql",
      parts.maintenanceUrl,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `CREATE DATABASE "${databaseIdentifier}"`,
    ]);
  } catch (error) {
    // Dois processos podem observar o banco como inexistente ao mesmo tempo.
    if (exists()) return;
    throw error;
  }
  console.log(`Banco ${parts.database} criado.`);
}

async function checksum(file: string): Promise<string> {
  const bytes = await Bun.file(file).arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Buffer.from(digest).toString("hex");
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function psqlFileName(file: string): string {
  return `'${file.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

/** Gera o script psql que aplica todas as migrations numa única transação. */
export function migrationScript(migrations: readonly Migration[]): string {
  const sections = migrations.flatMap((migration) => {
    const name = sqlLiteral(migration.name);
    const digest = sqlLiteral(migration.checksum);
    return [
      `DO $empilha$ BEGIN\n  IF EXISTS (\n    SELECT 1 FROM empilha_migrations\n    WHERE name = ${name} AND checksum <> ${digest}\n  ) THEN\n    RAISE EXCEPTION 'Migration alterada depois de aplicada: %. Crie uma nova migration.', ${name};\n  END IF;\nEND $empilha$;`,
      `SELECT CASE\n  WHEN NOT EXISTS (SELECT 1 FROM empilha_migrations WHERE name = ${name}) THEN 'true'\n  ELSE 'false'\nEND AS apply_migration;`,
      "\\gset",
      "\\if :apply_migration",
      "\\echo Executando migration",
      `\\i ${psqlFileName(migration.file)}`,
      `INSERT INTO empilha_migrations (name, checksum) VALUES (${name}, ${digest});`,
      "\\else",
      "\\echo Migration já aplicada",
      "\\endif",
    ];
  });

  return [
    "BEGIN;",
    "SELECT pg_advisory_xact_lock(hashtext('empilha:migrations'));",
    `CREATE TABLE IF NOT EXISTS empilha_migrations (\n  name TEXT PRIMARY KEY,\n  checksum TEXT NOT NULL,\n  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()\n);`,
    ...sections,
    "COMMIT;",
    "",
  ].join("\n");
}

export async function runMigrations(
  options: RunMigrationsOptions,
): Promise<void> {
  const files = sqlFiles(options.directory);
  if (files.length === 0) {
    console.log(`Nenhuma migration encontrada em ${options.directory}.`);
    return;
  }

  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    const message = "DATABASE_URL não está configurada.";
    if (options.missingConnection === "warn") {
      console.warn(`${message} Banco não inicializado.`);
      return;
    }
    throw new Error(message);
  }

  ensureDatabase(connectionString);
  const migrations = await Promise.all(
    files.map(async (file) => ({
      file,
      name: path.relative(options.directory, file).replaceAll("\\", "/"),
      checksum: await checksum(file),
    })),
  );
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "empilha-migrations-"),
  );
  const scriptFile = path.join(temporaryDirectory, "migrations.sql");

  try {
    await Bun.write(scriptFile, migrationScript(migrations));
    run([
      "psql",
      connectionString,
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      scriptFile,
    ]);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
