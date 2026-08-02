import type { SqlOptions } from "../core/types";
import { getOrCreateRoute } from "../core/metadata";
import type { GeneratedQuery } from "../sql/generated-query";

/**
 * Associa uma query registrada e seus bindings à rota.
 *
 * A query deve ter sido carregada no `QueryRegistry` com `loadSQL()` ou
 * `registerQuery()`. Quando `params` não é informado, bindings nomeados no
 * próprio SQL são resolvidos automaticamente.
 *
 * @param name - Nome da query registrada.
 * @param paramsOrOptions - Paths dos valores ou opções de execução da query.
 * @returns Um decorator de método.
 *
 * @throws {Error} Quando o nome está vazio ou outra query já foi associada ao
 * método.
 *
 * @example
 * @Sql("findUserById", ["param.id"])
 * @Result("one")
 * findById() {}
 *
 * @example
 * @Sql("findUserById")
 * @Result("one")
 * findById() {}
 */
export function Sql(
  name: string | GeneratedQuery,
  paramsOrOptions?: string[] | SqlOptions,
): MethodDecorator {
  const artifact = typeof name === "string" ? undefined : name;
  const normalizedName = typeof name === "string" ? name.trim() : name.id;

  if (!normalizedName) {
    throw new Error("O nome da query SQL não pode ser vazio.");
  }

  return (target, propertyKey) => {
    const route = getOrCreateRoute(target, propertyKey);

    if (route.queryName !== undefined) {
      throw new Error(
        `O método ${String(propertyKey)} já possui uma query SQL.`,
      );
    }

    route.queryName = normalizedName;
    route.queryArtifact = artifact;

    if (Array.isArray(paramsOrOptions)) {
      route.sqlParams = [...paramsOrOptions];
    } else if (paramsOrOptions?.params) {
      route.sqlParams = [...paramsOrOptions.params];
    }
  };
}

/**
 * Retorna somente a primeira linha do resultado SQL.
 *
 * Se a query não encontrar registros, o resultado será `undefined`, a menos
 * que `NotFoundWhenEmpty` também esteja presente.
 *
 * @returns Um decorator de método.
 */
export function Result(mode: "one" | "many" | "none"): MethodDecorator {
  return (target, propertyKey) => {
    getOrCreateRoute(target, propertyKey).sqlResult = mode;
  };
}

/**
 * Retorna todas as linhas do resultado SQL como um array.
 *
 * @returns Um decorator de método.
 */
/**
 * Converte um resultado vazio em `NotFoundError` e resposta HTTP 404.
 *
 * É usado principalmente junto com `Result("one")` em rotas de busca por ID.
 *
 * @returns Um decorator de método.
 */
export function NotFoundWhenEmpty(): MethodDecorator {
  return (target, propertyKey) => {
    getOrCreateRoute(target, propertyKey).sqlOnEmpty = "notFound";
  };
}

function setTransaction(
  target: object,
  propertyKey: string | symbol,
  transaction: "read" | "write",
): void {
  const route = getOrCreateRoute(target, propertyKey);

  if (route.transaction !== undefined && route.transaction !== transaction) {
    throw new Error(
      `O método ${String(propertyKey)} possui transações conflitantes.`,
    );
  }

  route.transaction = transaction;
}

/**
 * Executa a query dentro de uma transação somente leitura.
 *
 * @returns Um decorator de método.
 * @throws {Error} Quando a mesma rota recebe transações conflitantes.
 */
export function Transaction(mode: "read" | "write"): MethodDecorator {
  return (target, propertyKey) => {
    setTransaction(target, propertyKey, mode);
  };
}
