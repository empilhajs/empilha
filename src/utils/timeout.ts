/** Aguarda uma operação até o prazo informado, executando o fallback no vencimento. */
export function withTimeout<T>(
  operation: PromiseLike<T>,
  milliseconds: number,
  onTimeout: () => T | PromiseLike<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      Promise.resolve().then(onTimeout).then(resolve, reject);
    }, milliseconds);

    void Promise.resolve(operation).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
