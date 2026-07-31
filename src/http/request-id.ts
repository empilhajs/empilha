const processId = process.pid.toString(36);
let sequence = 0;

/** Gera um ID único dentro do processo sem depender de CSPRNG. */
export function createRequestId(): string {
  sequence = (sequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}-${processId}-${sequence.toString(36)}`;
}

/** Aplica um identificador único à resposta HTTP. */
export function addRequestId(
  response: Response,
  requestId: string = createRequestId(),
): Response {
  response.headers.set("X-Request-Id", requestId);
  return response;
}
