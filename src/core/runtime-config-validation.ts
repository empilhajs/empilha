import type { EmpilhaRuntimeConfig } from "./empilha";
import { validateHttpOptions } from "../http/adapter-helpers";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertConfigObject(
  value: unknown,
  name: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`A configuração ${name} deve ser um objeto.`);
  }
}

function validateServerConfig(config: EmpilhaRuntimeConfig): void {
  if (config.server === undefined) return;
  assertConfigObject(config.server, "server");
  if (config.server.port !== undefined) {
    const port = config.server.port;
    if (!Number.isInteger(port) || port < 0 || port > 65_535)
      throw new RangeError("A porta do servidor deve estar entre 0 e 65535.");
  }
  if (
    config.server.signals !== undefined &&
    typeof config.server.signals !== "boolean"
  ) {
    throw new TypeError("server.signals deve ser booleano.");
  }
}

function validateHttpConfig(config: EmpilhaRuntimeConfig): void {
  if (config.http === undefined) return;
  assertConfigObject(config.http, "http");
  validateHttpOptions(config.http);
}

function validateLifecycleConfig(config: EmpilhaRuntimeConfig): void {
  if (config.health !== undefined) assertConfigObject(config.health, "health");
  if (config.openapi !== undefined && config.openapi !== false)
    assertConfigObject(config.openapi, "openapi");
  if (config.auth !== undefined) assertConfigObject(config.auth, "auth");
  if (config.backgroundJobs !== undefined)
    assertConfigObject(config.backgroundJobs, "backgroundJobs");
  if (
    config.onBackgroundError !== undefined &&
    typeof config.onBackgroundError !== "function"
  ) {
    throw new TypeError("onBackgroundError deve ser uma função.");
  }
}

function validateMiddlewareConfig(config: EmpilhaRuntimeConfig): void {
  if (config.middleware === undefined) return;
  if (
    !Array.isArray(config.middleware) ||
    config.middleware.some((middleware) => typeof middleware !== "function")
  ) {
    throw new TypeError("middleware deve ser uma lista de funções.");
  }
}

function validateResponseConfig(config: EmpilhaRuntimeConfig): void {
  if (config.validation === undefined) return;
  assertConfigObject(config.validation, "validation");
  if (
    config.validation.responses !== undefined &&
    typeof config.validation.responses !== "boolean"
  ) {
    throw new TypeError("validation.responses deve ser booleano.");
  }
}

function validateLoggingConfig(config: EmpilhaRuntimeConfig): void {
  if (config.logging === undefined) return;
  assertConfigObject(config.logging, "logging");
  if (
    config.logging.requests !== undefined &&
    typeof config.logging.requests !== "boolean"
  ) {
    throw new TypeError("logging.requests deve ser booleano.");
  }
}

/** Valida a configuração centralizada antes de aplicar efeitos no runtime. */
export function assertRuntimeConfig(config: EmpilhaRuntimeConfig): void {
  assertConfigObject(config, "runtime");
  validateServerConfig(config);
  validateHttpConfig(config);
  validateLifecycleConfig(config);
  validateMiddlewareConfig(config);
  validateResponseConfig(config);
  validateLoggingConfig(config);
}
