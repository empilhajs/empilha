import { FormatRegistry, type TSchema } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { ValidationError } from "../errors/index";
import type { ParameterValidator } from "../types";

if (!FormatRegistry.Has("email")) {
  FormatRegistry.Set("email", (value) =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
  );
}

/**
 * Contrato mínimo de validação usado pelos decorators.
 *
 * O formato é compatível com validators compilados pelo TypeBox e permite que
 * a camada de argumentos converta as falhas para `ValidationError`.
 */
export interface Validator {
  Check(value: unknown): boolean;
  Errors(value: unknown): Iterable<{
    path: string;
    message: string;
  }>;
}

/**
 * Compila um validator TypeBox ou compatível em uma função de runtime.
 *
 * A compilação acontece durante o registro. O resultado lançado em caso de
 * falha mantém path e mensagem de cada problema encontrado.
 *
 * @param validatorOrSchema - Validator compatível ou schema TypeBox.
 * @returns Função que valida um valor ou lança `ValidationError`.
 * @throws {ValidationError} Quando o valor não atende ao contrato.
 */
export function compileValidator(
  validatorOrSchema: Validator | TSchema,
): ParameterValidator {
  const validator =
    "Check" in validatorOrSchema
      ? validatorOrSchema
      : TypeCompiler.Compile(validatorOrSchema);

  return (value) => {
    if (!validator.Check(value)) {
      throw new ValidationError(
        [...validator.Errors(value)].map((error) => ({
          path: error.path,
          message: error.message,
        })),
      );
    }
  };
}
