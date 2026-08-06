/** Códigos estáveis para classificação de erros do framework. */
export type FrameworkErrorCode =
  | "HTTP_ERROR"
  | "NOT_FOUND"
  | "VALIDATION_ERROR";

/** Erro base com código estável para logs e observabilidade. */
export class FrameworkError extends Error {
  constructor(
    public readonly code: FrameworkErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Erro associado a um status HTTP entre 400 e 599.
 *
 * O error pipeline usa `status` para produzir a resposta HTTP e preserva
 * `cause` quando fornecido pelo chamador.
 *
 * @example
 * throw new HttpError(409, "Usuário já existe")
 */
export class HttpError extends FrameworkError {
  constructor(
    public readonly status: number,
    message: string,
    options?: ErrorOptions,
    code: FrameworkErrorCode = "HTTP_ERROR",
  ) {
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new RangeError(`Status HTTP de erro inválido: ${status}`);
    }

    super(code, message, options);
  }
}

/** Problema individual encontrado durante uma validação. */
export type ValidationIssue = {
  path: string;
  message: string;
};

/**
 * Erro 400 que carrega falhas de validação estruturadas.
 *
 * @param errors - Lista de paths e mensagens que falharam.
 */
export class ValidationError extends HttpError {
  constructor(public readonly errors: ValidationIssue[]) {
    super(400, "Validation failed", undefined, "VALIDATION_ERROR");
  }
}

/** Erro HTTP usado quando um recurso não foi encontrado. */
/**
 * Erro HTTP 404 para recursos inexistentes.
 *
 * @param message - Mensagem enviada ao error pipeline.
 * @param options - Opções nativas do Error, como `cause`.
 */
export class NotFoundError extends HttpError {
  constructor(message = "Recurso não encontrado", options?: ErrorOptions) {
    super(404, message, options, "NOT_FOUND");
  }
}
