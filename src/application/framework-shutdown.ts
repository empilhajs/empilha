import type { Container } from "../di";
import type { HttpAdapter } from "../http";

export type CloseHook = () => void | Promise<void>;

export async function closeEmpilhaResources(
  http: HttpAdapter,
  container: Container,
  hooks: readonly CloseHook[],
): Promise<void> {
  const errors: unknown[] = [];
  let httpClosed = false;

  try {
    await http.close();
    httpClosed = true;
  } catch (error) {
    errors.push(error);
  }

  if (httpClosed) {
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
  }

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Falha ao encerrar a aplicação.");
  }
}
