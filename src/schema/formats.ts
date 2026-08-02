import { FormatRegistry } from "@sinclair/typebox";

const BUILTIN_FORMATS: Readonly<Record<string, (value: string) => boolean>> = {
  email: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
  date: (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return date.toISOString().startsWith(`${value}T`);
  },
};

export type FormatRegistryLike = {
  Has(format: string): boolean;
  Set(format: string, check: (value: string) => boolean): void;
};

/** Registra os formatos internos somente quando um schema é compilado. */
export function ensureBuiltinFormats(
  registry: FormatRegistryLike = FormatRegistry,
): void {
  for (const [name, check] of Object.entries(BUILTIN_FORMATS)) {
    if (!registry.Has(name)) registry.Set(name, check);
  }
}
