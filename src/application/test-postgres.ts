import type { PostgresQueryRunner, QueryResult } from "../sql";

export type TestPostgres = PostgresQueryRunner & {
  readonly queries: string[];
  readonly params: unknown[][];
  reset(): void;
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
  const query = async (
    sql: string,
    queryParams?: unknown[],
    queryOptions?: { queryName?: string },
  ): Promise<QueryResult> => {
    queries.push(sql);
    params.push(queryParams ?? []);
    return (
      (await options.onQuery?.(sql, queryParams ?? [])) ?? {
        rows:
          options.fixtures?.[queryOptions?.queryName ?? ""] ??
          options.fixtures?.[sql] ??
          options.rows,
      }
    );
  };

  return {
    queries,
    params,
    reset() {
      queries.length = 0;
      params.length = 0;
    },
    query,
    connect: async () => ({
      query,
      release() {},
    }),
  };
}
