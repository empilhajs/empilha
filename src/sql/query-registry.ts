import { compileNamedSQL } from "./sql-bindings";

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

  get(name: string): string {
    const normalizedName = name.trim();
    const sql = this.queries.get(normalizedName);

    if (sql === undefined) {
      throw new Error(`Query "${normalizedName}" não encontrada.`);
    }

    return sql;
  }
}
