import type {
  MiddlewareFn,
  ServerRequest,
  ServerResponse,
} from "./http-adapter";

type MiddlewareHandler = (
  request: ServerRequest,
) => ServerResponse | Promise<ServerResponse>;

/**
 * Executa middlewares em ordem e entrega o request ao handler final.
 *
 * Cada middleware recebe `next()`. O mesmo middleware não pode chamar `next()`
 * duas vezes, pois isso tornaria a ordem de execução ambígua.
 *
 * @param request - Request normalizada do framework.
 * @param middlewares - Middlewares que serão percorridos.
 * @param handler - Handler chamado após o último middleware.
 * @returns Resposta produzida pelo pipeline.
 * @throws {Error} Quando `next()` é chamado duas vezes no mesmo nível.
 */
export async function runMiddlewareChain(
  request: ServerRequest,
  middlewares: readonly MiddlewareFn[],
  handler: MiddlewareHandler,
): Promise<ServerResponse> {
  let currentIndex = -1;

  const dispatch = async (index: number): Promise<ServerResponse> => {
    if (index <= currentIndex) {
      throw new Error("next() foi chamado mais de uma vez.");
    }

    currentIndex = index;

    const middleware = middlewares[index];

    if (!middleware) {
      return handler(request);
    }

    return middleware(request, () => dispatch(index + 1));
  };

  return dispatch(0);
}
