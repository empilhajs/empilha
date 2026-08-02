import type { PostgresQueryRunner, QueryResult } from "../../sql";

export type TestPostgres = PostgresQueryRunner & {
  readonly queries: string[];
  readonly params: unknown[][];
  readonly calls: TestPostgresCall[];
  readonly transactions: TestPostgresTransaction[];
  reset(): void;
};

export type TestPostgresCall = {
  readonly sql: string;
  readonly params: unknown[];
  readonly transaction: boolean;
};

export type TestPostgresTransaction = {
  readonly action: "begin" | "commit" | "rollback";
};

export type TestPostgresOptions<T> = {
  rows: T[];
  fixtures?: Record<string, T[]>;
  onQuery?: (
    sql: string,
    params: unknown[],
  ) => QueryResult | undefined | Promise<QueryResult | undefined>;
};

/**
 * Cria um runner PostgreSQL em memória para testes de rotas SQL.
 * Fixtures são indexadas pelo SQL compilado completo.
 */
export function testPostgres<T>(
  input: T[] | TestPostgresOptions<T>,
): TestPostgres {
  const options = Array.isArray(input) ? { rows: input } : input;
  const queries: string[] = [];
  const params: unknown[][] = [];
  const calls: TestPostgresCall[] = [];
  const transactions: TestPostgresTransaction[] = [];
  const execute = async (
    sql: string,
    queryParams?: unknown[],
    queryOptions?: { queryName?: string },
    inTransaction = false,
  ): Promise<QueryResult> => {
    const normalizedParams = queryParams ?? [];
    queries.push(sql);
    params.push(normalizedParams);
    calls.push({ sql, params: normalizedParams, transaction: inTransaction });
    const normalizedSql = sql.trim().toUpperCase();
    if (normalizedSql === "BEGIN") transactions.push({ action: "begin" });
    if (normalizedSql === "COMMIT") transactions.push({ action: "commit" });
    if (normalizedSql === "ROLLBACK") transactions.push({ action: "rollback" });
    return (
      (await options.onQuery?.(sql, normalizedParams)) ?? {
        rows:
          options.fixtures?.[queryOptions?.queryName ?? ""] ??
          options.fixtures?.[sql] ??
          options.rows,
      }
    );
  };
  const query = (
    sql: string,
    queryParams?: unknown[],
    queryOptions?: { queryName?: string },
  ): Promise<QueryResult> => execute(sql, queryParams, queryOptions);

  return {
    queries,
    params,
    calls,
    transactions,
    reset() {
      queries.length = 0;
      params.length = 0;
      calls.length = 0;
      transactions.length = 0;
    },
    query,
    connect: async () => {
      let inTransaction = false;
      return {
        query: (
          sql: string,
          queryParams?: unknown[],
          queryOptions?: { queryName?: string },
        ) => {
          const normalizedSql = sql.trim().toUpperCase();
          const result = execute(sql, queryParams, queryOptions, inTransaction);
          if (normalizedSql === "BEGIN") inTransaction = true;
          if (normalizedSql === "COMMIT" || normalizedSql === "ROLLBACK")
            inTransaction = false;
          return result;
        },
        release() {},
      };
    },
  };
}
