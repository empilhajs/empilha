import { runWithRequestContext, type RequestScope } from "../context/index";

/** Opções de concorrência e limite da fila de tarefas em background. */
export type BackgroundSchedulerOptions = {
  concurrency: number;
  queueLimit?: number;
};

type BackgroundJob = {
  scope: RequestScope;
  metadata: unknown;
  task: () => unknown;
  resolve: () => void;
};

/** Agenda tarefas assíncronas preservando o contexto da requisição. */
export class BackgroundScheduler {
  private concurrency = 16;

  private queueLimit = 64;

  private running = 0;

  private readonly queue: BackgroundJob[] = [];

  private errorHandler:
    | ((error: unknown, metadata: unknown) => void)
    | undefined;

  /**
   * Configura a concorrência máxima e o tamanho da fila.
   *
   * @param options - Limites usados pelo scheduler.
   * @throws {RangeError} Quando algum limite é inválido.
   */
  configure(options: BackgroundSchedulerOptions): void {
    if (!Number.isInteger(options.concurrency) || options.concurrency <= 0) {
      throw new RangeError(
        "A concorrência de background deve ser um inteiro positivo.",
      );
    }

    const queueLimit = options.queueLimit ?? 64;

    if (!Number.isInteger(queueLimit) || queueLimit < 0) {
      throw new RangeError(
        "O limite da fila de background deve ser um inteiro não negativo.",
      );
    }

    this.concurrency = options.concurrency;
    this.queueLimit = queueLimit;
    this.drain();
  }

  /** Define o callback de observabilidade para falhas de tarefas. */
  onError(
    handler: (error: unknown, metadata: unknown) => void | Promise<void>,
  ): void {
    this.errorHandler = handler;
  }

  /**
   * Agenda uma tarefa para execução imediata ou posterior.
   *
   * @param scope - Contexto da requisição que originou a tarefa.
   * @param metadata - Dados encaminhados ao callback de erro.
   * @param task - Trabalho que será executado.
   * @returns Promise de conclusão ou `null` quando a fila está cheia.
   */
  schedule(
    scope: RequestScope,
    metadata: unknown,
    task: () => unknown,
  ): Promise<void> | null {
    if (
      this.running >= this.concurrency &&
      this.queue.length >= this.queueLimit
    ) {
      return null;
    }

    let resolve!: () => void;
    const completion = new Promise<void>((done) => {
      resolve = done;
    });

    const job: BackgroundJob = {
      scope,
      metadata,
      task,
      resolve,
    };

    if (this.running < this.concurrency) {
      this.start(job);
    } else {
      this.queue.push(job);
    }

    return completion;
  }

  private start(job: BackgroundJob): void {
    this.running++;

    const execution = runWithRequestContext(job.scope, () =>
      Promise.resolve().then(job.task),
    );

    void execution
      .catch(async (error) => {
        try {
          await Promise.resolve(this.errorHandler?.(error, job.metadata));
        } catch {
          // Observabilidade não pode quebrar o scheduler.
        }
      })
      .finally(() => {
        this.running--;
        job.resolve();
        this.drain();
      });
  }

  private drain(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();

      if (job) {
        this.start(job);
      }
    }
  }
}
