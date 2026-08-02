import type {
  ControllerOptions,
  RegisteredRouteMetadata,
  RouteMetadata,
} from "./types";
import type { MiddlewareFn } from "../http/http-adapter";

type MethodKey = string | symbol;
type ErrorConstructor = new (...args: any[]) => Error;

type Metadata = {
  path?: string;
  routes?: Map<MethodKey, RouteMetadata>;
  middlewares?: MiddlewareFn[];
  options?: ControllerOptions;
  catchers?: Map<ErrorConstructor, MethodKey>;
};

// Metadata pertence à classe/protótipo decorado, não a um registry global de
// controllers. Cada aplicação cria cópias dos valores quando os compila.
const METADATA = Symbol("empilha.metadata");

function metadataOf(target: object, create = false): Metadata | undefined {
  if (Object.hasOwn(target, METADATA)) {
    return (target as Record<PropertyKey, unknown>)[METADATA] as Metadata;
  }

  if (!create) return undefined;

  const metadata: Metadata = {};
  Object.defineProperty(target, METADATA, {
    configurable: false,
    enumerable: false,
    value: metadata,
    writable: false,
  });
  return metadata;
}

function ensureRoutesMap(target: object): Map<MethodKey, RouteMetadata> {
  const metadata = metadataOf(target, true) as Metadata;
  return (metadata.routes ??= new Map());
}

function cloneRoute(route: RouteMetadata): RegisteredRouteMetadata {
  if (!route.method || route.path === undefined) {
    throw new Error(
      `O método ${String(route.propertyKey)} não possui uma rota HTTP.`,
    );
  }

  return {
    ...route,
    method: route.method,
    path: route.path,
    parameters: [...route.parameters].sort((a, b) => a.index - b.index),
  };
}

export function registerControllerPath(
  controller: Function,
  prefix: string,
): void {
  metadataOf(controller, true)!.path = prefix;
}

export function getControllerPath(controller: Function): string | undefined {
  return metadataOf(controller)?.path;
}

export function registerControllerMiddlewares(
  controller: Function,
  middlewares: readonly MiddlewareFn[],
): void {
  const metadata = metadataOf(controller, true)!;
  metadata.middlewares = [...middlewares, ...(metadata.middlewares ?? [])];
}

export function getControllerMiddlewares(controller: Function): MiddlewareFn[] {
  return [...(metadataOf(controller)?.middlewares ?? [])];
}

export function registerControllerOptions(
  controller: Function,
  options: ControllerOptions,
): void {
  metadataOf(controller, true)!.options = { ...options };
}

export function getControllerOptions(
  controller: Function,
): ControllerOptions | undefined {
  const options = metadataOf(controller)?.options;
  return options ? { ...options } : undefined;
}

export function getOrCreateRoute(
  target: object,
  propertyKey: MethodKey,
): RouteMetadata {
  const routes = ensureRoutesMap(target);
  let route = routes.get(propertyKey);

  if (!route) {
    route = { propertyKey, parameters: [] };
    routes.set(propertyKey, route);
  }

  return route;
}

export function getControllerRoutes(
  controller: Function,
): RegisteredRouteMetadata[] {
  const routes = metadataOf(controller.prototype)?.routes;
  return routes ? [...routes.values()].map(cloneRoute) : [];
}

export function registerCatchHandler(
  target: object,
  errorType: ErrorConstructor,
  methodName: MethodKey,
): void {
  const metadata = metadataOf(target, true)!;
  const handlers = (metadata.catchers ??= new Map());
  const registeredMethod = handlers.get(errorType);

  if (registeredMethod !== undefined) {
    throw new Error(
      `Já existe um handler registrado para "${errorType.name}": ` +
        `${String(registeredMethod)}.`,
    );
  }

  handlers.set(errorType, methodName);
}

export function getCatchHandler(
  controller: object,
  error: unknown,
): MethodKey | undefined {
  if (!(error instanceof Error)) return undefined;

  return findCatchHandler(metadataOf(controller)?.catchers, error);
}

/** Retorna os catchers declarados, para inspeção estática do grafo. */
export function getControllerCatchHandlers(
  controller: Function,
): readonly [ErrorConstructor, MethodKey][] {
  const handlers = metadataOf(controller.prototype)?.catchers;
  return handlers ? [...handlers.entries()] : [];
}

function findCatchHandler(
  handlers: Map<ErrorConstructor, MethodKey> | undefined,
  error: unknown,
): MethodKey | undefined {
  if (!(error instanceof Error)) return undefined;
  if (!handlers) return undefined;

  let errorType: unknown = error.constructor;
  while (typeof errorType === "function" && errorType !== Function.prototype) {
    const methodName = handlers.get(errorType as ErrorConstructor);
    if (methodName !== undefined) return methodName;
    errorType = Object.getPrototypeOf(errorType);
  }

  return undefined;
}

export type MetadataRegistry = {
  snapshot: (controllers: readonly Function[]) => void;
  getControllerPath: typeof getControllerPath;
  getControllerMiddlewares: typeof getControllerMiddlewares;
  getControllerOptions: typeof getControllerOptions;
  getControllerRoutes: typeof getControllerRoutes;
  getCatchHandler: typeof getCatchHandler;
};

/** Cria uma fachada de metadata para um ApplicationContext específico. */
export function createMetadataRegistry(): MetadataRegistry {
  const snapshots = new WeakMap<object, Metadata>();

  const snapshot = (controllers: readonly Function[]): void => {
    for (const controller of controllers) {
      const source = metadataOf(controller);
      const routeSource = metadataOf(controller.prototype);
      const copy: Metadata = {};

      if (source?.path !== undefined) copy.path = source.path;
      if (source?.middlewares) copy.middlewares = [...source.middlewares];
      if (source?.options) copy.options = { ...source.options };
      if (routeSource?.routes) {
        copy.routes = new Map(
          [...routeSource.routes].map(([key, route]) => [
            key,
            {
              ...route,
              parameters: [...route.parameters],
              validators: route.validators
                ? new Map(route.validators)
                : undefined,
              sqlParams: route.sqlParams ? [...route.sqlParams] : undefined,
              queryArtifact: route.queryArtifact,
              responses: route.responses,
              middlewares: route.middlewares
                ? [...route.middlewares]
                : undefined,
            },
          ]),
        );
      }
      if (routeSource?.catchers) {
        copy.catchers = new Map(routeSource.catchers);
      }

      snapshots.set(controller, copy);
      snapshots.set(controller.prototype, {
        catchers: copy.catchers,
      });
    }
  };

  const localMetadata = (controller: object): Metadata | undefined =>
    snapshots.get(controller) ?? metadataOf(controller);

  return {
    snapshot,
    getControllerPath: (controller) => localMetadata(controller)?.path,
    getControllerMiddlewares: (controller) => [
      ...(localMetadata(controller)?.middlewares ?? []),
    ],
    getControllerOptions: (controller) => {
      const options = localMetadata(controller)?.options;
      return options ? { ...options } : undefined;
    },
    getControllerRoutes: (controller) => {
      const routes = localMetadata(controller)?.routes;
      return routes ? [...routes.values()].map(cloneRoute) : [];
    },
    getCatchHandler: (controller, error) =>
      findCatchHandler(localMetadata(controller)?.catchers, error),
  };
}
