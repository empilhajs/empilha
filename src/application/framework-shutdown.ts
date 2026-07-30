import type { Container } from "../di";
import type { HttpAdapter } from "../http";
import { logFrameworkError } from "../utils/logger";

export type CloseHook = () => void | Promise<void>;

const cleanupPromises = new WeakMap<Container, Promise<void>>();

async function disposeResources(
  container: Container,
  hooks: readonly CloseHook[],
): Promise<void> {
  const errors: unknown[] = [];

  try {
    await container.dispose();
  } catch (error) {
    errors.push(error);
  }

  for (let index = hooks.length - 1; index >= 0; index--) {
    try {
      await hooks[index]();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Falha ao encerrar a aplicação.");
  }
}

function getCleanupPromise(
  http: HttpAdapter,
  container: Container,
  hooks: readonly CloseHook[],
  waitForIdle: boolean,
): Promise<void> {
  const existing = cleanupPromises.get(container);
  if (existing) return existing;

  const cleanup = (async () => {
    if (waitForIdle) await http.waitForIdle();
    await disposeResources(container, hooks);
  })();
  cleanupPromises.set(container, cleanup);
  return cleanup;
}

export async function closeEmpilhaResources(
  http: HttpAdapter,
  container: Container,
  hooks: readonly CloseHook[],
): Promise<void> {
  try {
    await http.close();
  } catch (error) {
    // O container não pode ser encerrado enquanto handlers ainda usam seus
    // singletons. O cleanup fica agendado para quando o adapter ficar idle,
    // evitando vazamento caso o chamador não consiga fazer retry imediatamente.
    const cleanup = getCleanupPromise(http, container, hooks, true);
    void cleanup.catch((cleanupError) =>
      logFrameworkError(
        "Falha no cleanup deferido da aplicação.",
        cleanupError,
      ),
    );
    throw error;
  }

  await getCleanupPromise(http, container, hooks, false);
}
