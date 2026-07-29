import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Container } from "../di/index";
import type { QueryClient } from "../sql/postgres-executor";

/**
 * Estado contextual compartilhado durante uma requisição.
 *
 * O scope contém o container request-scoped, o signal de cancelamento e as
 * tarefas registradas para execução em background. Quando a rota é autenticada,
 * `user` contém o payload retornado pelo verificador de `app.auth()`.
 */
export type RequestScope<TUser = unknown> = {
  requestId: string;
  request: Request;
  container: Container;
  signal: AbortSignal;
  user?: TUser;
  /** Client da transação ativa da rota, quando houver. */
  transaction?: QueryClient;
  waitUntil(task: PromiseLike<unknown>): void;
};

const storage = new AsyncLocalStorage<RequestScope>();
const pendingTasks = new WeakMap<RequestScope, Set<Promise<unknown>>>();
const abortControllers = new WeakMap<RequestScope, AbortController>();

/**
 * Cria um escopo com container, cancelamento e tarefas pendentes.
 *
 * O `AbortController` é criado junto com o scope para que timeout e shutdown
 * sempre abortem exatamente o mesmo signal que uma leitura posterior retorna.
 *
 * @param request - Request HTTP original.
 * @param container - Container filho associado à requisição.
 * @returns Um novo escopo de requisição.
 */
export function createRequestScope(
  request: Request,
  container: Container,
): RequestScope {
  let requestId: string | undefined;
  let tasks: Set<Promise<unknown>> | undefined;
  const abortController = new AbortController();

  const scope: RequestScope = {
    get requestId() {
      return (requestId ??= randomUUID());
    },
    request,
    container,
    signal: abortController.signal,
    waitUntil(task) {
      tasks ??= new Set<Promise<unknown>>();
      const currentTasks = tasks;
      pendingTasks.set(scope, currentTasks);
      const tracked = Promise.resolve(task);
      currentTasks.add(tracked);
      void tracked.then(
        () => currentTasks.delete(tracked),
        () => currentTasks.delete(tracked),
      );
    },
  };

  abortControllers.set(scope, abortController);

  return scope;
}

/**
 * Executa uma função dentro do contexto AsyncLocalStorage informado.
 *
 * Todas as chamadas a `requestContext()` feitas durante a execução síncrona ou
 * assíncrona da função enxergam o mesmo scope.
 *
 * @param scope - Scope que será disponibilizado no contexto atual.
 * @param callback - Função executada dentro do scope.
 * @returns O retorno produzido pelo callback.
 */
export function runWithRequestContext<T>(
  scope: RequestScope,
  callback: () => T,
): T {
  return storage.run(scope, callback);
}

/**
 * Aguarda todas as tarefas registradas com `scope.waitUntil()`.
 *
 * A lista é reavaliada após cada lote porque uma tarefa pode registrar outra
 * tarefa antes de terminar.
 *
 * @param scope - Scope cujas tarefas devem terminar.
 * @returns Promise resolvida quando não houver mais tarefas pendentes.
 */
export async function waitForRequestTasks(scope: RequestScope): Promise<void> {
  const tasks = pendingTasks.get(scope);
  if (!tasks) return;

  for (;;) {
    const pending = [...tasks];
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }
}

/**
 * Indica se o escopo ainda possui tarefas de background pendentes.
 *
 * @param scope - Scope consultado.
 * @returns `true` quando há pelo menos uma tarefa aguardando conclusão.
 */
export function hasPendingRequestTasks(scope: RequestScope): boolean {
  return (pendingTasks.get(scope)?.size ?? 0) > 0;
}

/**
 * Aborta o signal associado ao escopo da requisição.
 *
 * @param scope - Scope que será cancelado.
 * @param reason - Motivo opcional disponibilizado pelo `AbortSignal`.
 */
export function abortRequestScope(scope: RequestScope, reason?: unknown): void {
  const controller = abortControllers.get(scope);
  if (controller && !controller.signal.aborted) controller.abort(reason);
}

/**
 * Retorna o escopo atual ou falha fora de uma requisição contextual.
 *
 * @returns O `RequestScope` ativo no AsyncLocalStorage.
 * @throws {Error} Quando chamada em uma rota stateless ou fora de uma request.
 */
export function requestContext<TUser = unknown>(): RequestScope<TUser> {
  const context = storage.getStore();
  if (!context) {
    throw new Error("Nenhum contexto de requisição está ativo.");
  }
  return context as RequestScope<TUser>;
}
