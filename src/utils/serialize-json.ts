/**
 * Serializa um valor para JSON, usando `null` quando o valor é indefinido.
 *
 * Quando `fallbackOnError` está ativo, erros de serialização são convertidos
 * em uma resposta JSON genérica; o caminho normal preserva a exceção original.
 */
export function serializeJson(value: unknown, fallbackOnError = false): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch (error) {
    if (!fallbackOnError) throw error;
    return JSON.stringify({
      error: String(value),
    });
  }
}
