import type { OwnedInstance } from "./container";

export type ContainerDisposalState = Readonly<{
  pendingInstances: Map<unknown, Promise<unknown>>;
  multiPending: Map<unknown, Promise<unknown>>;
  ownedInstances: OwnedInstance[];
  ownedByToken: Map<unknown, OwnedInstance>;
  instances: Map<unknown, unknown>;
  multiInstances: Map<unknown, unknown>;
  disposeHooks: Set<() => void | Promise<void>>;
}>;

/** Encerra recursos na ordem contratual e agrega todas as falhas. */
export async function disposeContainerResources(
  state: ContainerDisposalState,
): Promise<void> {
  const errors: unknown[] = [];
  await Promise.allSettled([
    ...state.pendingInstances.values(),
    ...state.multiPending.values(),
  ]);

  for (let index = state.ownedInstances.length - 1; index >= 0; index--) {
    const instance = state.ownedInstances[index];
    if (!instance.onDispose) continue;
    try {
      await instance.onDispose(instance.value);
    } catch (error) {
      errors.push(error);
    }
  }

  for (const hook of state.disposeHooks) {
    try {
      await hook();
    } catch (error) {
      errors.push(error);
    }
  }

  clearContainerResources(state);
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "Falha ao encerrar providers do container.",
    );
  }
}

/** Limpa os índices depois do encerramento síncrono ou assíncrono. */
export function clearContainerResources(state: ContainerDisposalState): void {
  state.instances.clear();
  state.pendingInstances.clear();
  state.multiInstances.clear();
  state.multiPending.clear();
  state.ownedInstances.length = 0;
  state.ownedByToken.clear();
  state.disposeHooks.clear();
}
