import { getOrCreateRoute } from "../core/metadata";

/** Define um método executado depois que a transação da rota foi commitada. */
export function AfterCommit(method: string | symbol): MethodDecorator {
  const normalized = typeof method === "string" ? method.trim() : method;
  if (typeof normalized === "string" && !normalized) {
    throw new Error("O nome do hook AfterCommit não pode ser vazio.");
  }

  return (target, propertyKey) => {
    getOrCreateRoute(target, propertyKey).afterCommit = normalized;
  };
}
