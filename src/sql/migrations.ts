import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { PostgresQueryRunner, QueryClient } from "./postgres-executor";

export type MigrationOptions = {
  directory: string;
  table?: string;
  lockKey?: string;
};

export type MigrationResult = {
  applied: readonly string[];
  skipped: readonly string[];
};

async function filesIn(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesIn(file)));
    else if (entry.isFile() && entry.name.endsWith(".sql")) files.push(file);
  }
  return files.sort();
}

function identifier(value: string, label: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
    throw new TypeError(`${label} inválido: ${value}`);
  return `"${value}"`;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Aplica migrations usando o runner configurado, sem depender de `psql`. */
export async function runMigrations(
  runner: PostgresQueryRunner,
  options: MigrationOptions,
): Promise<MigrationResult> {
  if (!runner.connect)
    throw new Error("Migrations exigem um PostgresQueryRunner com connect().");
  const table = identifier(
    options.table ?? "empilha_migrations",
    "Tabela de migrations",
  );
  const directory = resolve(options.directory);
  const files = await filesIn(directory);
  const migrations = await Promise.all(
    files.map(async (file) => {
      const sql = await readFile(file, "utf8");
      return {
        file,
        name: relative(directory, file).replaceAll("\\", "/"),
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
  const client = await runner.connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext(${literal(options.lockKey ?? "empilha:migrations")}))`,
    );
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${table} (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    );
    const existing = await client.query(`SELECT name, checksum FROM ${table}`);
    const records = new Map(
      existing.rows.map((row) => {
        const value = row as { name: string; checksum: string };
        return [value.name, value.checksum];
      }),
    );
    const applied: string[] = [];
    const skipped: string[] = [];
    for (const migration of migrations) {
      const previous = records.get(migration.name);
      if (previous) {
        if (previous !== migration.checksum)
          throw new Error(
            `Migration alterada depois de aplicada: ${migration.name}`,
          );
        skipped.push(migration.name);
        continue;
      }
      await client.query(migration.sql);
      await client.query(
        `INSERT INTO ${table} (name, checksum) VALUES (${literal(migration.name)}, ${literal(migration.checksum)})`,
      );
      applied.push(migration.name);
    }
    await client.query("COMMIT");
    committed = true;
    return { applied, skipped };
  } finally {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined);
    client.release(!committed);
  }
}

export type { QueryClient };
