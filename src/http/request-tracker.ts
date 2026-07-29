import {
  hasPendingRequestTasks,
  waitForRequestTasks,
  type RequestScope,
} from "../context";

/** Controla concorrência, scopes ativos e drenagem durante o shutdown. */
export class RequestTracker {
  private inFlight = 0;
  private readonly active = new Set<RequestScope>();
  private readonly cleanups = new Set<Promise<void>>();
  private readonly idleWaiters = new Set<() => void>();

  get inFlightCount(): number {
    return this.inFlight;
  }

  get activeScopes(): ReadonlySet<RequestScope> {
    return this.active;
  }

  tryEnter(limit: number | null): boolean {
    if (limit !== null && this.inFlight >= limit) return false;
    this.inFlight++;
    return true;
  }

  leave(): void {
    this.inFlight--;
    this.resolveIdleWaitersIfIdle();
  }

  trackScope(scope: RequestScope): void {
    this.active.add(scope);
  }

  cleanupScope(scope: RequestScope): void {
    if (
      !hasPendingRequestTasks(scope) &&
      scope.container.tryDisposeSynchronously()
    ) {
      this.finishScope(scope);
      return;
    }

    const cleanup = waitForRequestTasks(scope)
      .then(() => scope.container.dispose())
      .catch((error) => {
        console.error("Falha ao encerrar o escopo da requisição.", error);
      })
      .finally(() => {
        this.cleanups.delete(cleanup);
        this.finishScope(scope);
      });

    this.cleanups.add(cleanup);
  }

  waitForIdle(): Promise<void> {
    if (this.active.size === 0 && this.inFlight === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  private finishScope(scope: RequestScope): void {
    this.active.delete(scope);
    this.resolveIdleWaitersIfIdle();
  }

  private resolveIdleWaitersIfIdle(): void {
    if (this.inFlight !== 0 || this.active.size !== 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
