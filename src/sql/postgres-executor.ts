import { HttpError } from "../errors/index";
import type { TransactionMode } from "../types";
import { withTimeout } from "../utils/timeout";

/** Resultado mínimo esperado de uma query PostgreSQL. */
export type QueryResult = {
  rows: unknown[];
};

/** Sinal de cancelamento repassado ao cliente PostgreSQL. */
export type QueryExecutionOptions = {
  signal?: AbortSignal;
};

/** Cliente conectado usado para executar transações. */
export type QueryClient = {
  query(
    sql: string,
    params?: unknown[],
    options?: QueryExecutionOptions,
  ): Promise<QueryResult>;

  release(): void;
};

/**
 * Adapter mínimo que a aplicação deve fornecer para executar SQL.
 *
 * `connect()` é opcional para runners sem suporte a transações. Quando
 * informado, deve retornar um cliente que implemente `query()` e `release()`.
 */
export type PostgresQueryRunner = {
  query(
    sql: string,
    params?: unknown[],
    options?: QueryExecutionOptions,
  ): Promise<QueryResult>;

  connect?(): Promise<QueryClient>;
};

/** Contrato estrutural de pools como o `pg.Pool`. */
export type PostgresPool = {
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  connect(): Promise<QueryClient>;
};

/** Pool PostgreSQL que pode ser encerrado pelo ciclo de vida da aplicação. */
export type ManagedPostgresPool = PostgresPool & {
  end?(): void | Promise<void>;
};

/**
 * Adapta um pool PostgreSQL comum ao runner do Empilha.
 *
 * Para `pg`, normalmente basta usar `app.postgres(pool)`; use esta
 * função quando for necessário adaptar explicitamente o pool. Não é
 * necessário repetir wrappers para `query`, `connect` e `release`.
 */
export function postgresRunner(pool: PostgresPool): PostgresQueryRunner {
  const wrapClient = async (): Promise<QueryClient> => {
    const client = await pool.connect();

    return {
      query: (sql, params) => client.query(sql, params),
      release: () => client.release(),
    };
  };

  return {
    query: (sql, params) => pool.query(sql, params),
    connect: wrapClient,
  };
}

/**
 * Executa queries PostgreSQL com timeout, cancelamento e transações.
 *
 * O executor não cria pool nem conhece uma biblioteca específica. A aplicação
 * fornece um `PostgresQueryRunner`, permitindo usar mocks nos testes e qualquer driver
 * PostgreSQL compatível em produção.
 */
export class PostgresExecutor {
  private runner: PostgresQueryRunner | null = null;

  private timeoutMs: number | null = 5_000;

  /** Define o runner que receberá as queries. */
  setRunner(runner: PostgresQueryRunner): void {
    this.runner = runner;
  }

  assertTransactionSupport(): void {
    if (!this.runner) {
      throw new Error(
        "Nenhum query runner configurado para a rota transacional.",
      );
    }

    if (!this.runner.connect) {
      throw new Error("PostgresQueryRunner não suporta transações.");
    }
  }

  /** Define o timeout das operações ou `null` para desabilitá-lo. */
  setTimeout(milliseconds: number | null): void {
    if (
      milliseconds !== null &&
      (!Number.isInteger(milliseconds) || milliseconds <= 0)
    ) {
      throw new RangeError(
        "O timeout de banco deve ser um inteiro positivo ou null.",
      );
    }

    this.timeoutMs = milliseconds;
  }

  /** Executa uma query fora de uma transação gerenciada. */
  async execute(
    sql: string,
    params: unknown[],
    signal?: AbortSignal,
  ): Promise<QueryResult> {
    if (!this.runner) {
      throw new Error("Nenhum query runner configurado.");
    }

    return this.runOperation(
      (options) =>
        (this.runner as PostgresQueryRunner).query(sql, params, options),
      signal,
    );
  }

  /**
   * Executa uma query usando um client que já está dentro de uma transação.
   * O client não é adquirido, finalizado ou liberado por este método.
   */
  async executeOnClient(
    client: QueryClient,
    sql: string,
    params: unknown[],
    signal?: AbortSignal,
  ): Promise<QueryResult> {
    return this.runOperation(
      (options) => client.query(sql, params, options),
      signal,
    );
  }

  /**
   * Mantém a transação aberta durante todo o callback.
   * O callback pode executar várias queries no mesmo client.
   */
  async transaction<T>(
    transaction: TransactionMode,
    work: (client: QueryClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.runner?.connect) {
      throw new Error("PostgresQueryRunner não suporta transações.");
    }

    const client = await this.acquireClient(signal);
    let transactionStarted = false;

    try {
      await this.runOperation(
        (options) => client.query("BEGIN", undefined, options),
        signal,
      );
      transactionStarted = true;

      if (transaction === "read") {
        await this.runOperation(
          (options) =>
            client.query("SET TRANSACTION READ ONLY", undefined, options),
          signal,
        );
      }

      const result = await work(client);

      await this.runOperation(
        (options) => client.query("COMMIT", undefined, options),
        signal,
      );

      return result;
    } catch (error) {
      if (transactionStarted) {
        try {
          await this.runOperation(
            (options) => client.query("ROLLBACK", undefined, options),
            signal,
          );
        } catch {
          // Preserva o erro original.
        }
      }

      throw error;
    } finally {
      client.release();
    }
  }

  private runOperation<T>(
    operation: (options: QueryExecutionOptions) => Promise<T>,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    const normalizeError = (error: unknown): never => {
      if (isUniqueViolation(error)) {
        throw new HttpError(409, "Resource already exists", { cause: error });
      }
      throw error;
    };

    if (this.timeoutMs === null) {
      return operation({ signal: externalSignal }).catch(normalizeError);
    }

    const abortController = new AbortController();
    const abortFromExternal = () =>
      abortController.abort(externalSignal?.reason);
    if (externalSignal) {
      if (externalSignal.aborted) abortFromExternal();
      else
        externalSignal.addEventListener("abort", abortFromExternal, {
          once: true,
        });
    }
    const operationPromise = operation({
      signal: abortController.signal,
    }).catch(normalizeError);

    return withTimeout(operationPromise, this.timeoutMs, () => {
      const error = new HttpError(504, "Database timeout");
      abortController.abort(error);
      throw error;
    }).finally(() => {
      externalSignal?.removeEventListener("abort", abortFromExternal);
    });
  }

  /**
   * Adquire um client respeitando o timeout do executor.
   *
   * O contrato de `connect()` não aceita AbortSignal, então uma aquisição que
   * termine depois do timeout precisa liberar o client tardio para não vazar
   * conexões no pool.
   */
  private acquireClient(externalSignal?: AbortSignal): Promise<QueryClient> {
    const runner = this.runner;
    if (!runner?.connect) {
      return Promise.reject(
        new Error("PostgresQueryRunner não suporta transações."),
      );
    }

    const connectPromise = Promise.resolve().then(() => runner.connect!());

    if (this.timeoutMs === null && !externalSignal) return connectPromise;

    return new Promise<QueryClient>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        externalSignal?.removeEventListener("abort", abort);
      };

      const releaseLateClient = (client: QueryClient) => {
        try {
          client.release();
        } catch {
          // O erro da aquisição/timeout é mais relevante que o release tardio.
        }
      };

      const abort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        connectPromise.then(releaseLateClient, () => undefined);
        reject(externalSignal?.reason ?? new Error("Database request aborted"));
      };

      if (externalSignal?.aborted) {
        abort();
        return;
      }

      externalSignal?.addEventListener("abort", abort, { once: true });

      if (this.timeoutMs !== null) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          connectPromise.then(releaseLateClient, () => undefined);
          reject(new HttpError(504, "Database timeout"));
        }, this.timeoutMs);
      }

      connectPromise.then(
        (client) => {
          if (settled) {
            releaseLateClient(client);
            return;
          }
          settled = true;
          cleanup();
          resolve(client);
        },
        (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      );
    });
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}
