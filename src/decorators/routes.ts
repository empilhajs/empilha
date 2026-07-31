import type { HttpMethod } from "../types";
import type { ControllerOptions } from "../types";
import type { MiddlewareFn } from "../http/http-adapter";
import {
  getOrCreateRoute,
  registerControllerOptions,
  registerControllerMiddlewares,
  registerControllerPath,
} from "../metadata";
import { normalizePath } from "../router/path";

/**
 * Cria o decorator interno usado pelos métodos HTTP.
 *
 * O caminho é normalizado durante o registro do decorator, e não durante a
 * requisição. Isso mantém a metadata consistente e evita repetir validações no
 * hot path.
 *
 * @param method - Método HTTP que será associado à rota.
 * @param path - Caminho relativo ou absoluto da rota.
 *
 * @returns Um decorator de método.
 *
 * @throws {Error} Quando o mesmo método recebe duas rotas HTTP.
 */
function Route(method: HttpMethod, path: string): MethodDecorator {
  const normalizedPath = normalizePath(path, {
    allowEmpty: true,
    label: "caminho da rota",
  });

  return (target, propertyKey) => {
    const route = getOrCreateRoute(target, propertyKey);

    if (route.method !== undefined || route.path !== undefined) {
      throw new Error(
        `O método ${String(propertyKey)} já possui uma rota HTTP.`,
      );
    }

    route.method = method;
    route.path = normalizedPath;
  };
}

/**
 * Registra uma rota HTTP GET.
 *
 * @param path - Caminho da rota, como `/users/:id`.
 * @returns Um decorator de método.
 *
 * @example
 * @Get("/:id")
 * findById() {}
 */
export const Get = (path: string): MethodDecorator => Route("GET", path);
/** Registra uma rota HTTP HEAD. */
export const Head = (path: string): MethodDecorator => Route("HEAD", path);
/** Registra uma rota HTTP OPTIONS. */
export const Options = (path: string): MethodDecorator =>
  Route("OPTIONS", path);
/** Registra uma rota HTTP POST. */
export const Post = (path: string): MethodDecorator => Route("POST", path);
/** Registra uma rota HTTP PUT. */
export const Put = (path: string): MethodDecorator => Route("PUT", path);
/** Registra uma rota HTTP PATCH. */
export const Patch = (path: string): MethodDecorator => Route("PATCH", path);
/** Registra uma rota HTTP DELETE. */
export const Delete = (path: string): MethodDecorator => Route("DELETE", path);

/**
 * Registra uma classe como controller e aplica um prefixo às suas rotas.
 *
 * @param prefix - Prefixo compartilhado pelos métodos do controller.
 * @returns Um decorator de classe.
 *
 * @example
 * @Controller("/users")
 * class UsersController {}
 */
export function Controller(
  prefix: string,
  options: ControllerOptions = {},
): ClassDecorator {
  const normalizedPrefix = normalizePath(prefix, {
    allowEmpty: true,
    label: "caminho do controller",
  });

  return (target) => {
    registerControllerPath(target, normalizedPrefix);
    registerControllerOptions(target, options);
    if (options.middlewares?.length) {
      registerControllerMiddlewares(target, options.middlewares);
    }
  };
}

/**
 * Aplica middleware a todos os métodos de um controller ou a uma rota.
 *
 * Quando usado na classe, o middleware participa de todas as rotas dela. Quando
 * usado em um método, afeta somente aquela rota. A ordem informada é preservada
 * em relação aos demais middlewares registrados no mesmo nível.
 *
 * @param middlewares - Funções de middleware que serão executadas.
 * @returns Um decorator de classe e método.
 *
 * @throws {TypeError} Quando nenhum middleware válido é informado.
 */
export function Use(
  ...middlewares: MiddlewareFn[]
): ClassDecorator & MethodDecorator {
  if (
    middlewares.length === 0 ||
    middlewares.some((middleware) => typeof middleware !== "function")
  ) {
    throw new TypeError("Informe ao menos um middleware válido.");
  }

  return ((target: object | Function, propertyKey?: string | symbol) => {
    if (propertyKey === undefined) {
      registerControllerMiddlewares(target as Function, middlewares);
      return;
    }

    const route = getOrCreateRoute(target, propertyKey);
    route.middlewares = [...middlewares, ...(route.middlewares ?? [])];
  }) as ClassDecorator & MethodDecorator;
}
