import type { TSchema } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { ValidationError } from "../errors";
import { ensureBuiltinFormats } from "../schema/formats";
import type { ParameterValidator } from "../core/types";

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

const compiledValidators = new WeakMap<TSchema, Validator>();

function getCompiledValidator(schema: TSchema): Validator {
  const cached = compiledValidators.get(schema);
  if (cached) return cached;

  ensureBuiltinFormats();
  const compiled = TypeCompiler.Compile(schema);
  compiledValidators.set(schema, compiled);
  return compiled;
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
      : getCompiledValidator(validatorOrSchema);

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
