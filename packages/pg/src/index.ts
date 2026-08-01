import {
  definePlugin,
  type EmpilhaPlugin,
  type QueryExecutionOptions,
  type PostgresOptions,
} from "empilha"
import { Pool, Query, type PoolClient, type PoolConfig } from "pg"

export type PostgresPluginOptions = Omit<PoolConfig, "connectionString"> &
  Omit<PostgresOptions, "close"> & {
    url: string
  }

type CancellableClient = PoolClient & {
  cancel(client: PoolClient, query: Query): void
}

type QueryResult = {
  rows: unknown[]
}

async function queryWithCancellation(
  client: PoolClient,
  sql: string,
  params: unknown[] | undefined,
  options: QueryExecutionOptions | undefined,
): Promise<QueryResult> {
  const query = new Query({
    text: sql,
    values: params,
  })
  const cancellableClient = client as CancellableClient

  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      options?.signal?.removeEventListener("abort", abort)
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const abort = () => {
      try {
        cancellableClient.cancel(cancellableClient, query)
      } catch (error) {
        fail(error)
      }
    }

    if (options?.signal?.aborted) {
      fail(options.signal.reason ?? new Error("Database request aborted"))
      return
    }

    options?.signal?.addEventListener("abort", abort, { once: true })
    query.once("error", fail)
    query.once("end", (result) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ rows: result?.rows ?? [] })
    })

    try {
      client.query(query)
    } catch (error) {
      fail(error)
    }
  })
}

function createCancellablePool(pool: Pool) {
  const connect = pool.connect.bind(pool)
  const queryWithOptions = async (
    sql: string,
    params?: unknown[],
    options?: QueryExecutionOptions,
  ) => {
    const client = await connect()
    try {
      return await queryWithCancellation(client, sql, params, options)
    } finally {
      client.release()
    }
  }
  const cancellablePool = pool as Pool & {
    queryWithOptions: typeof queryWithOptions
  }

  Object.assign(cancellablePool, {
    queryWithOptions,
    connect: async () => {
      const client = await connect()
      return {
        query: (sql: string, params?: unknown[]) => client.query(sql, params),
        queryWithOptions: (
          sql: string,
          params?: unknown[],
          options?: QueryExecutionOptions,
        ) => queryWithCancellation(client, sql, params, options),
        release: () => client.release(),
      };
    },
  })

  return cancellablePool
}

/**
 * Integra `pg.Pool` ao Empilha sem adicionar `pg` ao framework principal.
 * O pool é criado, monitorado e encerrado pelo plugin.
 */
export function postgres(options: PostgresPluginOptions): EmpilhaPlugin {
  const { url, sql, timeout, healthCheck, ...poolOptions } = options
  const poolConfig: PoolConfig = {
    ...poolOptions,
    connectionString: url,
  }

  if (timeout !== undefined && timeout !== null) {
    poolConfig.statement_timeout ??= timeout
    poolConfig.query_timeout ??= timeout
  }

  const pool = new Pool(poolConfig)
  const cancellablePool = createCancellablePool(pool)

  return definePlugin((app) => {
    app.postgres(cancellablePool, {
      sql,
      timeout,
      healthCheck,
    })
  })
}
