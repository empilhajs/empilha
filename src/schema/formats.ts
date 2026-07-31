import { FormatRegistry } from "@sinclair/typebox";

/** Registra os formatos internos somente quando um schema é compilado. */
export function ensureBuiltinFormats(): void {
  if (!FormatRegistry.Has("email")) {
    FormatRegistry.Set("email", (value) =>
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
    );
  }
}
