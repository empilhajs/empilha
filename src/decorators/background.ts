import { getOrCreateRoute } from "../metadata";

/**
 * Executa o método em background depois de responder à requisição.
 *
 * A tarefa usa o mesmo request scope, signal e contexto da requisição original
 * e é aguardada pelo ciclo de vida antes do disposal do escopo.
 *
 * @returns Um decorator de método.
 *
 * @example
 * @AfterResponse()
 * async sendWelcomeEmail() {}
 */
export function AfterResponse(): MethodDecorator {
  return (target, propertyKey) => {
    getOrCreateRoute(target, propertyKey).background = true;
  };
}
