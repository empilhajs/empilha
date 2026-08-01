/** Construtor abstrato aceito como token ou implementação de provider. */
export type Constructor<T = unknown> = abstract new (...args: never[]) => T;

/** Token nominal usado para localizar uma dependência no container. */
export type DependencyToken<T = unknown> = Constructor<T> | string | symbol;

/** Estratégia de cache e ciclo de vida de um provider. */
export type ProviderScope = "singleton" | "transient" | "request";

/** Opções de ciclo de vida declaradas no decorator @Injectable. */
export type InjectableOptions = {
  scope: ProviderScope;
};

/**
 * Configuração de uma dependência registrada no container.
 *
 * Exatamente uma das propriedades `useClass`, `useFactory` ou `useValue` deve
 * ser informada.
 */
export type Provider<T = unknown> = {
  useClass?: Constructor<T>;
  useFactory?: (container: Container) => T;
  useValue?: T;
  scope?: ProviderScope;
  onDispose?: (value: T) => void | Promise<void>;
};

import {
  getDependencies,
  getInjectableScope,
  registerDependencies,
  registerInjectableScope,
} from "./dependency-metadata";
import { getOrCreateRoute } from "../metadata";

function extendDependencyStack<T>(
  token: T,
  stack: T[],
  format: (value: T) => string,
): T[] {
  const cycleIndex = stack.indexOf(token);

  if (cycleIndex !== -1) {
    const cycle = [...stack.slice(cycleIndex), token].map(format).join(" → ");
    throw new Error(`Dependência circular detectada: ${cycle}`);
  }

  return [...stack, token];
}

/**
 * Injeta um token em um construtor ou um serviço nomeado em uma rota.
 *
 * @param token - Classe, string ou symbol usado na resolução.
 * @returns Um decorator de parâmetro.
 *
 * @example Constructor
 * class Service {
 *   constructor(@Inject("DATABASE") database: Database) {}
 * }
 *
 * @example Route
 * login(@Inject("access") access: JwtService) {}
 */
export function Inject(token: DependencyToken): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    if (propertyKey !== undefined) {
      const route = getOrCreateRoute(target, propertyKey);
      if (
        route.parameters.some((parameter) => parameter.index === parameterIndex)
      ) {
        throw new Error(
          `O parâmetro de índice ${parameterIndex} já possui um decorador.`,
        );
      }
      route.parameters.push({
        index: parameterIndex,
        source: "plugin",
        name: String(token),
      });
      return;
    }

    const targetType = target as Constructor;
    const current = getDependencies(targetType);
    current[parameterIndex] = token;
    registerDependencies(targetType, current);
  };
}

/**
 * Registra a lista de tokens que o construtor de uma classe precisa.
 *
 * Quando nenhum token é informado, uma classe sem dependências pode ser
 * registrada normalmente. Para construtores com parâmetros, use `@Inject` ou
 * informe os tokens nesta forma explícita.
 *
 * @param options - Opções de ciclo de vida do provider.
 * @returns Um decorator de classe.
 */
export function Injectable(options: InjectableOptions): ClassDecorator {
  return (target) => {
    const constructor = target as unknown as Constructor;
    registerDependencies(constructor, getDependencies(constructor));
    if (options.scope) registerInjectableScope(constructor, options.scope);
  };
}

/**
 * Lê os tokens registrados para uma classe.
 *
 * @param target - Classe cuja metadata será consultada.
 * @returns Tokens na ordem dos parâmetros do construtor.
 */
type RegisteredProvider = Provider<any> & {
  token: DependencyToken;
};

type LocatedProvider = {
  provider: RegisteredProvider;
  owner: Container;
};

type OwnedInstance = {
  token: DependencyToken;
  value: unknown;
  onDispose?: (value: unknown) => void | Promise<void>;
};

/**
 * Container hierárquico de dependências com suporte a scopes e disposal.
 *
 * O container raiz mantém singletons. `createScope()` cria um filho que pode
 * resolver providers `request` e herda os providers do pai sem duplicar seus
 * singletons.
 *
 * @example
 * const container = new Container()
 *   .provide(Database, { useClass: Database, scope: "singleton" })
 *
 * const database = container.resolve(Database)
 */
export class Container {
  private readonly providers = new Map<DependencyToken, RegisteredProvider>();
  private readonly instances = new Map<DependencyToken, unknown>();
  private readonly ownedInstances: OwnedInstance[] = [];
  private readonly ownedByToken = new Map<DependencyToken, OwnedInstance>();
  private disposed = false;

  constructor(
    private readonly parent?: Container,
    private readonly requestScope = false,
  ) {}

  /**
   * Registra ou substitui um provider.
   *
   * @param token - Token usado nas resoluções futuras.
   * @param provider - Classe, factory, valor ou configuração completa.
   * @returns O próprio container para permitir encadeamento.
   * @throws {TypeError} Quando o provider não define exatamente uma
   * implementação.
   */
  provide<T>(
    token: DependencyToken<T>,
    provider?: Provider<T> | Constructor<T>,
  ): this {
    this.assertActive();

    if (provider === undefined) {
      if (typeof token !== "function") {
        throw new TypeError(
          `O token "${String(token)}" precisa de um provider.`,
        );
      }
      provider = token;
    }

    const normalized: Provider<T> =
      typeof provider === "function" ? { useClass: provider } : provider;
    const implementations = ["useClass", "useFactory", "useValue"].filter(
      (key) => key in normalized,
    );

    if (implementations.length !== 1) {
      throw new TypeError(
        "Um provider deve definir exatamente uma implementação.",
      );
    }

    const existingProvider = this.providers.get(token);
    const existingInstance = this.instances.get(token);
    const existingOwned = this.ownedByToken.get(token);
    if (existingOwned?.onDispose) {
      throw new Error(
        `O provider "${String(token)}" já foi resolvido e possui disposal; ` +
          "não pode ser substituído com segurança.",
      );
    }

    if (existingProvider && existingInstance !== undefined) {
      this.instances.delete(token);
    }

    this.providers.set(token, {
      token,
      ...normalized,
      scope: normalized.scope ?? "singleton",
    });
    this.instances.delete(token);
    return this;
  }

  /** Cria um container filho destinado a uma requisição. */
  createScope(): Container {
    this.assertActive();
    return new Container(this, true);
  }

  /** Indica se existe provider local ou herdado para um token. */
  has(token: DependencyToken): boolean {
    return this.findProvider(token) !== undefined;
  }

  /** Retorna o scope configurado para um token ou `null` se ele não existe. */
  scopeOf(token: DependencyToken): ProviderScope | null {
    return this.findProvider(token)?.provider.scope ?? null;
  }

  /**
   * Verifica se um token ou suas dependências exigem request scope.
   *
   * @param token - Provider ou classe que será analisado.
   * @returns `true` quando a resolução precisa de um escopo de requisição.
   */
  requiresRequestScope(
    token: DependencyToken,
    visited = new Set<DependencyToken>(),
  ): boolean {
    if (visited.has(token)) return false;
    visited.add(token);

    const located = this.findProvider(token);
    if (located) {
      const { provider } = located;
      if (provider.scope === "request") return true;
      if (provider.scope === "singleton") return false;
      if (provider.useFactory) return true;
      if (provider.useClass) {
        return getDependencies(provider.useClass).some((dependency) =>
          this.requiresRequestScope(dependency, visited),
        );
      }
      return false;
    }

    if (typeof token !== "function") return false;
    return getDependencies(token).some((dependency) =>
      this.requiresRequestScope(dependency, visited),
    );
  }

  /**
   * Valida dependências e detecta ciclos antes do bootstrap.
   *
   * @param target - Classe que será validada.
   * @throws {Error} Quando falta um token ou existe dependência circular.
   */
  assertConstructible(target: Constructor, stack: Constructor[] = []): void {
    const nextStack = extendDependencyStack(
      target,
      stack,
      (entry) => entry.name,
    );
    for (const [index, dependency] of getDependencies(target).entries()) {
      if (dependency === undefined) {
        throw new Error(
          `"${target.name}" não pode ser registrada: parâmetro ${index} ` +
            "não possui @Inject.",
        );
      }

      const provider = this.findProvider(dependency);
      const implementation = provider?.provider.useClass;
      if (implementation) {
        this.assertConstructible(implementation, nextStack);
      } else if (!provider && typeof dependency === "function") {
        this.assertConstructible(dependency, nextStack);
      }
    }
  }

  /**
   * Resolve um token usando o scope atual.
   *
   * Singletons são reutilizados, transient providers são recriados e providers
   * request só podem ser resolvidos por um container criado com `createScope()`.
   *
   * @param token - Token da dependência.
   * @returns Instância resolvida do token.
   * @throws {Error} Quando o token não existe, o container foi encerrado ou o
   * token exige request scope fora de um scope.
   */
  resolve<T>(token: DependencyToken<T>): T {
    return this.resolveWithStack(token, []);
  }

  private resolveWithStack<T>(
    token: DependencyToken<T>,
    stack: DependencyToken[],
  ): T {
    this.assertActive();
    const nextStack = extendDependencyStack(token, stack, String);
    const located = this.findProvider(token);
    if (!located) {
      if (typeof token !== "function") {
        throw new Error(`Nenhum provider registrado para "${String(token)}".`);
      }
      return this.instantiate(token, nextStack);
    }

    const { provider, owner } = located;
    if (provider.scope === "request" && !this.requestScope) {
      throw new Error(
        `O provider "${String(token)}" requer um escopo de requisição ativo.`,
      );
    }

    const instanceOwner = provider.scope === "singleton" ? owner : this;
    if (provider.scope !== "transient") {
      const cached = instanceOwner.instances.get(token);
      if (instanceOwner.instances.has(token)) return cached as T;
    }

    const resolver = provider.scope === "singleton" ? owner : this;
    resolver.assertActive();
    const value = provider.useClass
      ? resolver.instantiate(provider.useClass, nextStack)
      : provider.useFactory
        ? provider.useFactory(resolver)
        : provider.useValue;

    if (provider.scope !== "transient")
      instanceOwner.instances.set(token, value);
    const owned: OwnedInstance = {
      token,
      value,
      onDispose: provider.onDispose as
        | ((value: unknown) => void | Promise<void>)
        | undefined,
    };
    instanceOwner.ownedInstances.push(owned);
    instanceOwner.ownedByToken.set(token, owned);
    return value as T;
  }

  /**
   * Encerra providers pertencentes a este container na ordem inversa de criação.
   *
   * O método é idempotente e agrega falhas dos callbacks `onDispose` em um
   * `AggregateError` depois de tentar encerrar todos os recursos.
   *
   * @throws {AggregateError} Quando um ou mais providers falham ao encerrar.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const errors: unknown[] = [];

    for (let index = this.ownedInstances.length - 1; index >= 0; index--) {
      const instance = this.ownedInstances[index];
      if (!instance.onDispose) continue;
      try {
        await instance.onDispose(instance.value);
      } catch (error) {
        errors.push(error);
      }
    }

    this.instances.clear();
    this.ownedInstances.length = 0;
    this.ownedByToken.clear();
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "Falha ao encerrar providers do container.",
      );
    }
  }

  /**
   * Encerra sincronamente um container sem callbacks assíncronos.
   *
   * @returns `true` quando o container foi encerrado; `false` quando é preciso
   * aguardar `dispose()` por possuir callbacks de disposal.
   */
  tryDisposeSynchronously(): boolean {
    if (this.disposed) return true;
    if (
      this.ownedInstances.some((instance) => instance.onDispose !== undefined)
    ) {
      return false;
    }
    this.disposed = true;
    this.instances.clear();
    this.ownedInstances.length = 0;
    this.ownedByToken.clear();
    return true;
  }

  private findProvider(token: DependencyToken): LocatedProvider | undefined {
    const provider = this.providers.get(token);
    if (provider) return { provider, owner: this };
    const inherited = this.parent?.findProvider(token);
    if (inherited) return inherited;

    if (typeof token === "function") {
      const scope = getInjectableScope(token);
      if (scope) {
        return {
          owner: this,
          provider: { token, useClass: token, scope },
        };
      }
    }

    return undefined;
  }

  private instantiate<T>(target: Constructor<T>, stack: DependencyToken[]): T {
    const tokens = getDependencies(target);
    const args = tokens.map((dependency) => {
      if (dependency === undefined) {
        throw new Error(
          `"${target.name}" não pode ser instanciada. ` +
            "Certifique-se de que foi decorada com @Injectable " +
            "e todos os parâmetros do construtor estão registrados no container.",
        );
      }
      return this.resolveWithStack(dependency, stack);
    });

    const Concrete = target as unknown as new (...args: any[]) => T;
    return new Concrete(...args);
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("O container já foi encerrado.");
  }
}
