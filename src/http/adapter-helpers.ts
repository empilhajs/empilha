import type { HttpOptions } from "./adapter-types";

export function validatePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`O limite de ${label} deve ser um inteiro positivo.`);
  }
  return value;
}

/** Valida toda a configuração HTTP antes de qualquer mutação de estado. */
export function validateHttpOptions(options: HttpOptions): void {
  if (options.requestId !== undefined && typeof options.requestId !== "boolean")
    throw new TypeError("requestId deve ser booleano.");
  if (
    options.serverHeader !== undefined &&
    typeof options.serverHeader !== "string"
  )
    throw new TypeError("serverHeader deve ser string.");

  for (const [value, name] of [
    [options.maxBodyBytes, "maxBodyBytes"],
    [options.maxQueryBytes, "maxQueryBytes"],
    [options.maxQueryParameters, "maxQueryParameters"],
  ] as const) {
    if (value !== undefined) validatePositiveInteger(value, name);
  }
  for (const [value, name] of [
    [options.handlerTimeout, "handlerTimeout"],
    [options.bodyTimeout, "bodyTimeout"],
    [options.shutdownTimeout, "shutdownTimeout"],
  ] as const) {
    if (value !== undefined) validateTimeout(value, name);
  }
  for (const [value, name] of [
    [options.maxHeaderCount, "maxHeaderCount"],
    [options.maxConcurrentRequests, "maxConcurrentRequests"],
  ] as const) {
    if (value !== undefined) validateLimit(value, name);
  }
  if (
    options.exposeInternalErrors !== undefined &&
    typeof options.exposeInternalErrors !== "boolean"
  ) {
    throw new TypeError("exposeInternalErrors deve ser booleano.");
  }
  if (options.cors && typeof options.cors !== "string") {
    if (typeof options.cors.origin !== "string")
      throw new TypeError("cors.origin deve ser string.");
    if (
      options.cors.methods !== undefined &&
      typeof options.cors.methods !== "string"
    )
      throw new TypeError("cors.methods deve ser string.");
    if (
      options.cors.headers !== undefined &&
      typeof options.cors.headers !== "string"
    )
      throw new TypeError("cors.headers deve ser string.");
    if (
      options.cors.credentials !== undefined &&
      typeof options.cors.credentials !== "boolean"
    )
      throw new TypeError("cors.credentials deve ser booleano.");
    if (options.cors.credentials && options.cors.origin === "*") {
      throw new Error("CORS com credentials exige uma origem explícita.");
    }
    if (
      options.cors.maxAge !== undefined &&
      (!Number.isInteger(options.cors.maxAge) || options.cors.maxAge < 0)
    ) {
      throw new RangeError(
        "O maxAge de CORS deve ser um inteiro não negativo.",
      );
    }
  }
}

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
