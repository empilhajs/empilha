/**
 * Erro associado a um status HTTP entre 400 e 599.
 *
 * O error pipeline usa `status` para produzir a resposta HTTP e preserva
 * `cause` quando fornecido pelo chamador.
 *
 * @example
 * throw new HttpError(409, "Usuário já existe")
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new RangeError(`Status HTTP de erro inválido: ${status}`);
    }

    super(message, options);
    this.name = new.target.name;
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
    super(400, "Validation failed");
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
    super(404, message, options);
  }
}
