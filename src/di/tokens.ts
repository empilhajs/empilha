const tokenBrand = Symbol("empilha.token");

/** Token nominal para contratos de dependência publicados por módulos e plugins. */
export type Token<T> = {
  readonly description: string;
  readonly [tokenBrand]: T;
};

export type Clock = Readonly<{ now(): number }>;
export type RequestIdGenerator = () => string;

/** Cria um token tipado sem registrar estado global nem provider. */
export function createToken<T>(description: string): Token<T> {
  const normalized = description.trim();
  if (!normalized)
    throw new TypeError("A descrição do token não pode ser vazia.");
  return Object.freeze({ description: normalized }) as Token<T>;
}

/** Contratos substituíveis para relógio e IDs em testes e telemetria. */
export const CLOCK = createToken<Clock>("empilha/clock");
export const REQUEST_ID_GENERATOR = createToken<RequestIdGenerator>(
  "empilha/request-id-generator",
);
