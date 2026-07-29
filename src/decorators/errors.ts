import { registerCatchHandler } from "../metadata";

type ErrorConstructor = new (...args: any[]) => Error;

/**
 * Registra um método como handler de um tipo de erro.
 *
 * O método decorado recebe o erro e pode retornar qualquer resposta aceita
 * pelo controller. Handlers específicos têm prioridade sobre handlers de
 * classes base ou de `Error`.
 *
 * @param errorType - Classe do erro que será capturado.
 * @returns Um decorator de método.
 *
 * @example
 * @Catch(NotFoundError)
 * handleNotFound(error: NotFoundError) {
 *   return { status: 404, body: error.message }
 * }
 */
export function Catch(...errorTypes: ErrorConstructor[]): MethodDecorator {
  if (errorTypes.length === 0) {
    throw new TypeError("Informe ao menos um tipo de erro para @Catch.");
  }
  return (target, propertyKey) => {
    for (const errorType of errorTypes) {
      registerCatchHandler(target, errorType, propertyKey);
    }
  };
}
