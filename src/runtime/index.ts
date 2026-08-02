export {
  AuthorizationService,
  type AuthResult,
  type AuthTokenHandler,
  type AuthorizationGuard,
  type RoleHierarchy,
} from "./authorization";
export {
  BackgroundScheduler,
  type BackgroundSchedulerOptions,
} from "./background-scheduler";
export { createErrorResponse, ErrorPipeline } from "./error-pipeline";
export { serializeJson } from "../utils/serialize-json";

import type { Logger } from "../utils/logger";

export type ObservableError = Readonly<{
  readonly name: string;
  readonly status?: number;
}>;

export type RequestCompletedEvent = Readonly<{
  readonly requestId: string;
  readonly method: string;
  readonly pathname: string;
  readonly route: string;
  readonly status: number;
  readonly durationMs: number;
  readonly error?: ObservableError;
}>;

export type QueryCompletedEvent = Readonly<{
  readonly requestId: string;
  readonly query: string;
  readonly route: string;
  readonly durationMs: number;
  readonly rowCount: number;
  readonly transaction: boolean;
  readonly error?: ObservableError;
}>;

export type BackgroundCompletedEvent = Readonly<{
  readonly requestId: string;
  readonly route: string;
  readonly durationMs: number;
  readonly status: "completed" | "failed";
  readonly error?: ObservableError;
}>;

export type ApplicationEventMap = {
  "request.completed": RequestCompletedEvent;
  "query.completed": QueryCompletedEvent;
  "background.completed": BackgroundCompletedEvent;
};

export type ApplicationEventName = keyof ApplicationEventMap;
export type ApplicationEventListener<K extends ApplicationEventName> = (
  event: ApplicationEventMap[K],
) => void | Promise<void>;

export function observableError(error: unknown): ObservableError {
  if (error instanceof Error) {
    const status = (error as { status?: unknown }).status;
    return Object.freeze({
      name: error.name,
      ...(typeof status === "number" ? { status } : {}),
    });
  }
  return Object.freeze({ name: "Error" });
}

/** Event bus readonly; falhas de listeners são isoladas do request original. */
export class ApplicationEvents {
  private readonly listeners = new Map<
    ApplicationEventName,
    Set<ApplicationEventListener<ApplicationEventName>>
  >();

  private logger: Logger | undefined;

  setLogger(logger: Logger): void {
    this.logger = logger;
  }

  on<K extends ApplicationEventName>(
    name: K,
    listener: ApplicationEventListener<K>,
  ): () => void {
    const listeners = this.listeners.get(name) ?? new Set();
    const stored = listener as ApplicationEventListener<ApplicationEventName>;
    listeners.add(stored);
    this.listeners.set(name, listeners);
    return () => listeners.delete(stored);
  }

  emit<K extends ApplicationEventName>(
    name: K,
    event: ApplicationEventMap[K],
  ): void {
    const listeners = this.listeners.get(name);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        const result = listener(event as never);
        if (
          result &&
          typeof (result as PromiseLike<void>).then === "function"
        ) {
          void Promise.resolve(result).catch((error) =>
            this.listenerFailed(name, error),
          );
        }
      } catch (error) {
        this.listenerFailed(name, error);
      }
    }
  }

  private listenerFailed(name: ApplicationEventName, error: unknown): void {
    this.logger?.error(
      { event: name, error: observableError(error) },
      "Listener de observabilidade falhou.",
    );
  }
}
