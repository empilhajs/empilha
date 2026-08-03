import { ValidationError } from "../errors";

/**
 * Converte entradas HTTP usando decimal estrito: sinal opcional, dígitos e
 * fração com pelo menos um dígito. Expoentes, bases alternativas, whitespace
 * e `NaN`/`Infinity` não fazem parte do contrato HTTP.
 */
export function convertInputValue(
  value: unknown,
  type: "number" | "bigint" | "boolean",
  path: string,
): unknown {
  if (value == null) return undefined;
  if (type === "number") {
    const validNumber =
      (typeof value === "number" && Number.isFinite(value)) ||
      (typeof value === "string" &&
        /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) &&
        Number.isFinite(Number(value)));
    if (!validNumber) {
      throw new ValidationError([
        { path, message: "Expected a valid number." },
      ]);
    }
    return Number(value);
  }
  if (type === "bigint") {
    const validBigInt =
      typeof value === "bigint" ||
      (typeof value === "number" && Number.isSafeInteger(value)) ||
      (typeof value === "string" && /^[+-]?\d+$/.test(value));
    if (!validBigInt) {
      throw new ValidationError([
        { path, message: "Expected a valid bigint." },
      ]);
    }
    return BigInt(value as bigint | number | string);
  }
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === 1) return true;
  if (value === "false" || value === "0" || value === 0) return false;
  throw new ValidationError([{ path, message: "Expected a valid boolean." }]);
}
