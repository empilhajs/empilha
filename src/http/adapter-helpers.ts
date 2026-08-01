export function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

export function validateTimeout(
  milliseconds: number | null,
  name: string,
): number | null {
  if (milliseconds === null) return null;
  if (!Number.isInteger(milliseconds) || milliseconds <= 0) {
    throw new RangeError(
      `O timeout de ${name} deve ser um inteiro positivo ou null.`,
    );
  }
  return milliseconds;
}

export function validateLimit(
  limit: number | null,
  name: string,
): number | null {
  if (limit === null) return null;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(
      `O limite de ${name} deve ser um inteiro positivo ou null.`,
    );
  }
  return limit;
}
