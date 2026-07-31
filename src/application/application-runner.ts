import type { ApplicationLifecycle } from "./lifecycle";
import type { Logger } from "../utils/logger";

export type ApplicationRunOptions = {
  port?: number;
  signals?: boolean;
};

type RunnerOptions = {
  lifecycle: ApplicationLifecycle;
  isInitialized: () => boolean;
  listen: (port: number) => Promise<void>;
  close: () => Promise<void>;
  startHooks: readonly (() => void | Promise<void>)[];
  hasOpenApi: () => boolean;
  hasHealthChecks: () => boolean;
  getUrl: () => URL | null;
  openApiUiPath: string;
  openApiDocumentPath: string;
  logger: Logger;
};

/** Orquestra somente a inicialização, execução e parada do processo HTTP. */
export class ApplicationRunner {
  constructor(private readonly options: RunnerOptions) {}

  async listen(port: number): Promise<void> {
    if (!this.options.isInitialized()) {
      throw new Error("Chame app.initialize([...]) antes de app.listen().");
    }

    await this.options.lifecycle.listen(
      () => this.options.listen(port),
      this.options.startHooks,
      this.options.close,
    );
  }

  async run(options: ApplicationRunOptions): Promise<void> {
    if (options.port === undefined) {
      throw new Error(
        "Configure server.port ou passe { port } para app.run().",
      );
    }

    await this.listen(options.port);

    if (options.signals !== false) {
      let shutdownPromise: Promise<void> | undefined;
      const shutdown = () => {
        shutdownPromise ??= this.options.close().catch((error: unknown) => {
          this.options.logger.error(error, "Falha ao encerrar a aplicação:");
          process.exitCode = 1;
        });
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    }

    const baseUrl =
      this.options.getUrl()?.origin ?? `http://localhost:${options.port}`;
    this.options.logger.info({ url: baseUrl }, "🚀 API disponível");
    if (this.options.hasOpenApi()) {
      this.options.logger.info(
        { url: `${baseUrl}${this.options.openApiUiPath}` },
        "📚 Docs",
      );
      this.options.logger.info(
        { url: `${baseUrl}${this.options.openApiDocumentPath}` },
        "📄 OpenAPI",
      );
    }
    if (this.options.hasHealthChecks())
      this.options.logger.info({ url: `${baseUrl}/health/ready` }, "❤️ Health");
  }
}
