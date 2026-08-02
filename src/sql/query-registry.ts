import { compileNamedSQL } from "./sql-bindings";
import type { GeneratedQuery } from "./generated-query";

/**
 * Armazena as queries registradas.
 *
 * A chave representa o nome único da query.
 * O valor representa o comando SQL associado.
 */
export class QueryRegistry {
  private readonly queries = new Map<string, string>();

  register(name: string, sql: string): void {
    const normalizedName = name.trim();
    const normalizedSql = sql.trim();

    if (!normalizedName) {
      throw new Error("O nome da query não pode ser vazio.");
    }

    if (!normalizedSql) {
      throw new Error(`Query "${normalizedName}" não pode ser vazia.`);
    }

    compileNamedSQL(normalizedSql);

    if (this.queries.has(normalizedName)) {
      throw new Error(`Query "${normalizedName}" já foi registrada.`);
    }

    this.queries.set(normalizedName, normalizedSql);
  }

  registerGeneratedQuery(query: GeneratedQuery): void {
    if (!query.sql)
      throw new Error(
        `Query gerada "${query.id}" não contém SQL para registro em runtime (${query.source}).`,
      );
    const existing = this.queries.get(query.id);
    if (existing !== undefined) {
      if (existing === query.sql) return;
      throw new Error(`Query "${query.id}" já foi registrada com outro SQL.`);
    }
    this.register(query.id, query.sql);
  }

  get(name: string): string {
    const normalizedName = name.trim();
    const sql = this.queries.get(normalizedName);

    if (sql === undefined) {
      throw new Error(`Query "${normalizedName}" não encontrada.`);
    }

    return sql;
  }
}
