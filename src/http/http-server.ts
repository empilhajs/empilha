import { abortRequestScope } from "../context/request-context";
import { validateTimeout } from "./adapter-helpers";
import { RequestTracker } from "./request-tracker";
import { withTimeout } from "../utils/timeout";

type BunServer = ReturnType<typeof Bun.serve>;

/** Responsável somente pelo ciclo de vida do servidor Bun e sua drenagem. */
export class HttpServer {
  private server: BunServer | null = null;
  private shutdownTimeoutMs: number | null = 15_000;

  constructor(
    private readonly fetch: (request: Request) => Response | Promise<Response>,
    private readonly requests: RequestTracker,
  ) {}

  get url(): URL | null {
    return this.server?.url ?? null;
  }

  get port(): number | null {
    return this.server?.port ?? null;
  }

  setShutdownTimeout(milliseconds: number | null): void {
    this.shutdownTimeoutMs = validateTimeout(milliseconds, "shutdown");
  }

  async listen(port: number): Promise<void> {
    if (this.server) throw new Error("O servidor já está em execução.");
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new RangeError(`Porta inválida: ${port}.`);
    }

    this.server = Bun.serve({ port, fetch: this.fetch });
  }

  async close(): Promise<void> {
    let server: BunServer | null = null;
    if (this.server) {
      server = this.server;
      this.server = null;
    }

    const drain = Promise.all([
      server ? Promise.resolve(server.stop(false)) : Promise.resolve(),
      this.requests.waitForIdle(),
    ]).then(() => undefined);

    if (this.shutdownTimeoutMs === null) {
      await drain;
      return;
    }

    try {
      await withTimeout(drain, this.shutdownTimeoutMs, () => {
        const error = new Error(
          "Timeout ao drenar requisições durante o shutdown.",
        );
        for (const scope of this.requests.activeScopes) {
          abortRequestScope(scope, error);
        }
        throw error;
      });
    } catch (error) {
      // A chamada é rejeitada, mas o RequestTracker continua acompanhando os
      // scopes. Isso permite que o cleanup do DI seja deferido com segurança.
      if (server) await server.stop(true);
      throw error;
    }
  }

  waitForIdle(): Promise<void> {
    return this.requests.waitForIdle();
  }
}
