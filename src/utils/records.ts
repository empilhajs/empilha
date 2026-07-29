/**
 * Cria um registro sem protótipo para dados indexados por string.
 *
 * O uso de um objeto sem protótipo evita que chaves recebidas da aplicação ou
 * da rede colidam com propriedades herdadas como `constructor` e `__proto__`.
 *
 * @returns Um registro vazio e seguro para dados dinâmicos.
 */
export function createStringRecord(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

/**
 * Registro vazio compartilhado para caminhos que não precisam materializar
 * dados vindos da requisição.
 *
 * Ele é congelado porque pode ser observado por várias requisições ao mesmo
 * tempo. Use `createStringRecord()` quando o registro precisar ser mutável.
 */
export const EMPTY_STRING_RECORD = Object.freeze(
  Object.create(null) as Record<string, string>,
);
