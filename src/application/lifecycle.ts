export type ApplicationPhase =
  | "configuring"
  | "validated"
  | "initialized"
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

  validate(operation: AsyncOperation): void {
    this.assertConfiguring("validate()");
    operation();
    this.currentPhase = "validated";
  }

  initialize(operation: AsyncOperation): void {
    if (this.currentPhase !== "validated") {
      throw new Error("initialize() deve ser chamado durante o bootstrap.");
    }
    try {
      operation();
      this.currentPhase = "initialized";
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
    if (this.currentPhase !== "initialized") {
      throw new Error("Chame app.initialize([...]) antes de app.listen().");
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
