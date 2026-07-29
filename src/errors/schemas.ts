import { Type } from "@sinclair/typebox";

const ValidationIssueSchema = Type.Object({
  path: Type.String(),
  message: Type.String(),
});

/** Contrato das respostas de erro HTTP e de validação do framework. */
export const ErrorResponseSchema = Type.Union([
  Type.Object({
    error: Type.String(),
  }),
  Type.Object({
    errors: Type.Array(ValidationIssueSchema),
  }),
]);
