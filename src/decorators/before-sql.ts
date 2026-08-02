import { getOrCreateRoute } from "../core/metadata";

/** Define o método que prepara a requisição antes da query SQL da rota. */
export function BeforeSql(method?: string | symbol): MethodDecorator {
  const normalized = typeof method === "string" ? method.trim() : method;
  if (typeof normalized === "string" && !normalized) {
    throw new Error("O nome do hook BeforeSql não pode ser vazio.");
  }

  return (target, propertyKey) => {
    getOrCreateRoute(target, propertyKey).beforeSql = normalized ?? propertyKey;
  };
}
