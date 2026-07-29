import {
  definePlugin,
  type EmpilhaPlugin,
  type PostgresOptions,
} from "empilha"
import { Pool, type PoolConfig } from "pg"

export type PostgresPluginOptions = Omit<PoolConfig, "connectionString"> &
  Omit<PostgresOptions, "close"> & {
    url: string
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

  return definePlugin((app) => {
    app.postgres(pool, {
      sql,
      timeout,
      healthCheck,
    })
  })
}
