/** Logger mínimo do framework, centralizado para preservar contexto e causa. */
export function logFrameworkError(message: string, error: unknown): void {
  console.error(message, error);
}
