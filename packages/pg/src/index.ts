import {
  createToken,
  defineDeclarativePlugin,
  type DeclarativePlugin,
  type QueryExecutionOptions,
  type PostgresOptions,
  postgresRunner,
  type PostgresQueryRunner,
} from "empilha";
import { Client, Pool, type PoolClient, type PoolConfig } from "pg";

export type PostgresPluginOptions = Omit<PoolConfig, "connectionString"> &
  Omit<PostgresOptions, "close"> & {
    url: string;
  };

type BackendClient = PoolClient & {
  processID: number;
};

type QueryResult = {
  rows: unknown[];
};

export const PostgresClient = createToken<Pool>("@empilha/pg/client");
export const PostgresRunner = createToken<PostgresQueryRunner>(
  "@empilha/pg/query-runner",
);

async function queryWithCancellation(
  client: PoolClient,
  sql: string,
  params: unknown[] | undefined,
  options: QueryExecutionOptions | undefined,
  cancelQuery: () => Promise<void>,
): Promise<QueryResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      options?.signal?.removeEventListener("abort", abort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = () => {
      // Se o canal auxiliar falhar, a query original continua sendo a fonte
      // de verdade e será limitada pelo statement_timeout do pool. Rejeitar
      // aqui liberaria um client ainda ocupado de volta ao pool.
      void cancelQuery().catch(() => undefined);
    };

    if (options?.signal?.aborted) {
      fail(options.signal.reason ?? new Error("Database request aborted"));
      return;
    }

    options?.signal?.addEventListener("abort", abort, { once: true });
    void client.query(sql, params).then((result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ rows: result.rows });
    }, fail);
  });
}

function createCancellablePool(pool: Pool, poolConfig: PoolConfig) {
  const connect = pool.connect.bind(pool);
  const cancelQuery = async (client: PoolClient): Promise<void> => {
    // O cancelamento precisa de uma conexão separada. Reutilizar o socket que
    // executa a query mistura mensagens e corrompe o estado do protocolo.
    const cancellationClient = new Client(poolConfig);
    await cancellationClient.connect();
    try {
      await cancellationClient.query("SELECT pg_cancel_backend($1)", [
        (client as BackendClient).processID,
      ]);
    } finally {
      await cancellationClient.end();
    }
  };
  const queryWithOptions = async (
    sql: string,
    params?: unknown[],
    options?: QueryExecutionOptions,
  ) => {
    const client = await connect();
    try {
      return await queryWithCancellation(client, sql, params, options, () =>
        cancelQuery(client),
      );
    } finally {
      client.release();
    }
  };
  const cancellablePool = pool as Pool & {
    queryWithOptions: typeof queryWithOptions;
  };

  Object.assign(cancellablePool, {
    queryWithOptions,
    connect: async () => {
      const client = await connect();
      return {
        query: (sql: string, params?: unknown[]) => client.query(sql, params),
        queryWithOptions: (
          sql: string,
          params?: unknown[],
          options?: QueryExecutionOptions,
        ) =>
          queryWithCancellation(client, sql, params, options, () =>
            cancelQuery(client),
          ),
        release: (destroy = false) => client.release(destroy),
      };
    },
  });

  return cancellablePool;
}

/**
 * Integra `pg.Pool` ao Empilha sem adicionar `pg` ao framework principal.
 * O pool é criado, monitorado e encerrado pelo plugin.
 */
export type PostgresPlugin = DeclarativePlugin;

export function postgres(options: PostgresPluginOptions): PostgresPlugin {
  const { url, sql, timeout, healthCheck, ...poolOptions } = options;
  const poolConfig: PoolConfig = {
    ...poolOptions,
    connectionString: url,
  };

  if (timeout !== undefined && timeout !== null) {
    poolConfig.statement_timeout ??= timeout;
  }

  const pool = new Pool(poolConfig);
  const cancellablePool = createCancellablePool(pool, poolConfig);

  return defineDeclarativePlugin({
    name: "@empilha/pg",
    version: "0.2.4",
    provides: ["postgres/client", "postgres/query-runner"],
    register(context) {
      const runner = postgresRunner(cancellablePool);
      context.provider({ provide: PostgresClient, useValue: cancellablePool });
      context.provider({ provide: PostgresRunner, useValue: runner });
      context.postgres(runner, {
        sql,
        timeout,
        healthCheck,
        close: false,
      });
      context.onClose(() => pool.end());
    },
  });
}
