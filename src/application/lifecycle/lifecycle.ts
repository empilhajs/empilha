export type ApplicationPhase =
  | "configuring"
  | "ready"
  | "listening"
  | "failed"
  | "closed";

type AsyncOperation = () => void | Promise<void>;

/** Coordena as fases explícitas do ciclo de vida de uma aplicação. */
export class ApplicationLifecycle {
  private currentPhase: ApplicationPhase = "configuring";
  private closePromise: Promise<void> | null = null;

  get phase(): ApplicationPhase {
    return this.currentPhase;
  }

  assertConfiguring(action: string): void {
    if (this.currentPhase !== "configuring") {
      throw new Error(`${action} deve ser chamado durante a fase configure.`);
    }
  }

  /** Hooks de início ainda fazem sentido até o servidor começar a escutar. */
  assertBeforeListening(action: string): void {
    if (this.currentPhase !== "configuring" && this.currentPhase !== "ready") {
      throw new Error(`${action} deve ser chamado antes de app.listen().`);
    }
  }

  /** Hooks de fechamento só podem ser registrados antes do fechamento final. */
  assertBeforeClosed(action: string): void {
    if (this.currentPhase === "closed") {
      throw new Error(`${action} não pode ser chamado após app.close().`);
    }
  }

  activate(operation: AsyncOperation): void {
    this.assertConfiguring("createApplication()");
    try {
      operation();
      this.currentPhase = "ready";
    } catch (error) {
      this.currentPhase = "failed";
      throw error;
    }
  }

  async listen(
    listen: AsyncOperation,
    startHooks: readonly AsyncOperation[],
    close: AsyncOperation,
  ): Promise<void> {
    if (this.currentPhase !== "ready") {
      throw new Error(
        "A aplicação precisa estar pronta antes de app.listen().",
      );
    }

    try {
      await listen();
      this.currentPhase = "listening";
      for (const hook of startHooks) await hook();
    } catch (error) {
      await Promise.resolve(close()).catch(() => undefined);
      throw error;
    }
  }

  async close(operation: AsyncOperation): Promise<void> {
    if (this.closePromise) return this.closePromise;

    const closing = (async () => {
      await operation();
      this.currentPhase = "closed";
    })();

    const wrapped = closing.catch((error) => {
      if (this.closePromise === wrapped) this.closePromise = null;
      throw error;
    });

    this.closePromise = wrapped;
    return wrapped;
  }
}
