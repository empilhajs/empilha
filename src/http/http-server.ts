import { abortRequestScope } from "../context/request-context";
import { validateTimeout } from "./adapter-helpers";
import { RequestTracker } from "./request-tracker";
import { withTimeout } from "../utils/timeout";
import { addRequestId } from "./request-id";

type BunServer = ReturnType<typeof Bun.serve>;
export type NativeRouteHandler = (
  request: Request,
) => Response | Promise<Response>;
export type NativeRouteValue =
  | NativeRouteHandler
  | Partial<Record<string, NativeRouteHandler>>;
export type NativeRoutes = Record<string, NativeRouteValue>;

/** Responsável somente pelo ciclo de vida do servidor Bun e sua drenagem. */
export class HttpServer {
  private server: BunServer | null = null;
  private shutdownTimeoutMs: number | null = 15_000;
  private requestIdEnabled = true;

  constructor(
    private readonly fetch: (request: Request) => Response | Promise<Response>,
    private readonly requests: RequestTracker,
    private readonly getRoutes?: () => NativeRoutes | undefined,
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

  setRequestIdEnabled(enabled: boolean): void {
    this.requestIdEnabled = enabled;
  }

  async listen(port: number): Promise<void> {
    if (this.server) throw new Error("O servidor já está em execução.");
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new RangeError(`Porta inválida: ${port}.`);
    }

    const routes = this.getRoutes?.();
    const trackedRoutes = routes ? this.trackNativeRoutes(routes) : undefined;
    this.server = Bun.serve({
      port,
      fetch: this.fetch,
      ...(trackedRoutes && Object.keys(trackedRoutes).length > 0
        ? { routes: trackedRoutes }
        : {}),
    } as Bun.Serve.Options<unknown, string>);
  }

  private trackNativeRoutes(routes: NativeRoutes): NativeRoutes {
    const tracked: NativeRoutes = Object.create(null);

    for (const [path, value] of Object.entries(routes)) {
      if (typeof value === "function") {
        tracked[path] = this.trackNativeHandler(value);
        continue;
      }

      const methods: Partial<Record<string, NativeRouteHandler>> = {};
      for (const [method, handler] of Object.entries(value)) {
        if (handler) methods[method] = this.trackNativeHandler(handler);
      }
      tracked[path] = methods;
    }

    return tracked;
  }

  private trackNativeHandler(handler: NativeRouteHandler): NativeRouteHandler {
    return (request) => {
      this.requests.tryEnter(null);

      try {
        const response = handler(request);
        if (response instanceof Promise) {
          return response
            .then((value) =>
              this.requestIdEnabled ? addRequestId(value) : value,
            )
            .finally(() => this.requests.leave());
        }
        this.requests.leave();
        return this.requestIdEnabled ? addRequestId(response) : response;
      } catch (error) {
        this.requests.leave();
        throw error;
      }
    };
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
