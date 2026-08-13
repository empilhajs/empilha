import { FormatRegistry } from "@sinclair/typebox";

const BUILTIN_FORMATS: Readonly<Record<string, (value: string) => boolean>> = {
  email: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
  date: (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return date.toISOString().startsWith(`${value}T`);
  },
  "date-time": (value) =>
    !Number.isNaN(Date.parse(value)) && value.includes("T"),
  uuid: (value) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    ),
  uri: (value) => {
    try {
      return Boolean(new URL(value).protocol);
    } catch {
      return false;
    }
  },
  ipv4: (value) => {
    const parts = value.split(".");
    return (
      parts.length === 4 &&
      parts.every(
        (part) =>
          /^(?:0|[1-9]\d{0,2})$/.test(part) &&
          Number(part) >= 0 &&
          Number(part) <= 255,
      )
    );
  },
  hostname: (value) =>
    value.length <= 253 &&
    /^(?=.{1,253}\.?$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.?$/.test(
      value,
    ),
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
