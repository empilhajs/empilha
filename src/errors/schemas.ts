import { Type } from "@sinclair/typebox";

const ValidationIssueSchema = Type.Object({
  path: Type.String(),
  message: Type.String(),
});

/** Contrato RFC 9457 das respostas de erro do framework. */
export const ErrorResponseSchema = Type.Object({
  type: Type.String(),
  title: Type.String(),
  status: Type.Integer(),
  errors: Type.Optional(Type.Array(ValidationIssueSchema)),
});
