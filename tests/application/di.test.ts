import { describe, expect, test } from "bun:test";
import {
  Context,
  Controller,
  createApplication,
  Get,
  Inject,
  InjectAll,
  Injectable,
  Lazy,
  Optional,
} from "../../src";
import { Container } from "../../src/di/index";
import { testModule } from "../helpers/test-utils";

describe("dependency injection", () => {
  test("rejeita factory async antes de executá-la e não confunde objetos thenable", async () => {
    const token = Symbol("async-before-call");
    let activations = 0;
    const container = new Container().provide(token, {
      useFactory: async () => {
        activations++;
        return "async";
      },
    });

    expect(() => container.resolve(token)).toThrow("use resolveAsync()");
    expect(activations).toBe(0);

    const thenable = Symbol("thenable-value");
    const thenKey = ["t", "hen"].join("");
    const thenValue = Object.defineProperty({ value: 42 }, thenKey, {
      value: "not a function",
      enumerable: true,
    });
    container.provide(thenable, { useValue: thenValue as never });
    const resolved = container.resolve<{ value: number }>(thenable);
    expect(resolved.value).toBe(42);

    const indirect = Symbol("indirect-promise");
    container.provide(indirect, { useFactory: () => Promise.resolve("async") });
    expect(() => container.resolve(indirect)).toThrow("use resolveAsync()");
    await expect(container.resolveAsync(indirect)).resolves.toBe("async");

    const asyncParameter = Symbol("async-parameter");
    container.provide(asyncParameter, {
      useFactory: async (scope) => String(scope),
    });
    expect(() => container.resolve(asyncParameter)).toThrow(
      "use resolveAsync()",
    );
  });

  test("não executa uma factory Promise duas vezes em resoluções concorrentes", async () => {
    const token = Symbol("concurrent-factory");
    let activations = 0;
    let finish!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const container = new Container().provide(token, {
      useFactory: () => {
        activations++;
        return pending;
      },
    });

    const asyncResolution = container.resolveAsync(token);
    expect(() => container.resolve(token)).toThrow("resolveAsync()");
    expect(activations).toBe(1);
    finish("ready");
    await expect(asyncResolution).resolves.toBe("ready");
  });

  test("respeita o escopo declarado em Injectable", async () => {
    let serviceInstances = 0;

    @Injectable({ scope: "request" })
    class RequestService {
      readonly id = ++serviceInstances;
    }

    class Requests {
      constructor(
        @Inject(RequestService)
        private readonly service: RequestService,
      ) {}

      @Get("/")
      get() {
        return this.service.id;
      }
    }

    Controller("/decorated-scope")(Requests);

    const app = await createApplication(testModule([Requests]), {
      configure: (runtime) => runtime.configureHttp({ cors: false }),
    });

    const first = await app.test().get("/decorated-scope");
    const second = await app.test().get("/decorated-scope");

    expect(await first.json()).not.toBe(await second.json());
  });

  test("resolve dependências transitivas e permite substituir por mock", async () => {
    class EmailService {
      send() {
        return "real";
      }
    }

    class UserService {
      constructor(
        @Inject(EmailService)
        private readonly email: EmailService,
      ) {}

      find() {
        return this.email.send();
      }
    }

    class Users {
      constructor(
        @Inject(UserService)
        private readonly service: UserService,
      ) {}

      @Get("/")
      get() {
        return this.service.find();
      }
    }

    Controller("/users")(Users);

    const app = await createApplication(
      testModule([Users], {
        providers: [
          {
            provide: EmailService,
            useValue: {
              send: () => "mock",
            },
          },
        ],
      }),
      { configure: (runtime) => runtime.configureHttp({ cors: false }) },
    );

    const response = await app.test().get("/users");

    expect(await response.json()).toBe("mock");
  });

  test("mantém singleton e cria transient e request scope corretamente", () => {
    class Service {}

    const container = new Container().provide(Service);

    expect(container.resolve(Service)).toBe(container.resolve(Service));

    container.provide(Service, {
      useClass: Service,
      scope: "transient",
    });

    expect(container.resolve(Service)).not.toBe(container.resolve(Service));

    container.provide(Service, {
      useClass: Service,
      scope: "request",
    });

    expect(() => container.resolve(Service)).toThrow("escopo de requisição");

    const firstScope = container.createScope();
    const secondScope = container.createScope();

    expect(firstScope.resolve(Service)).toBe(firstScope.resolve(Service));
    expect(firstScope.resolve(Service)).not.toBe(secondScope.resolve(Service));
  });

  test("rejeita substituir singleton resolvido que possui disposal", () => {
    class Resource {}
    const container = new Container().provide(Resource, {
      useClass: Resource,
      onDispose: () => {},
    });

    container.resolve(Resource);

    expect(() =>
      container.provide(Resource, {
        useClass: Resource,
      }),
    ).toThrow("possui disposal");
  });

  test("reutiliza singleton do container raiz em todos os request scopes", () => {
    class SingletonService {}

    const root = new Container().provide(SingletonService);

    const firstScope = root.createScope();
    const secondScope = root.createScope();

    const rootInstance = root.resolve(SingletonService);

    expect(firstScope.resolve(SingletonService)).toBe(rootInstance);
    expect(secondScope.resolve(SingletonService)).toBe(rootInstance);
  });

  test("não transforma controller em request-scoped por depender de factory singleton", () => {
    class FactoryService {}
    class SingletonController {}

    const container = new Container()
      .provide(FactoryService, {
        useFactory: () => new FactoryService(),
        scope: "singleton",
      })
      .provide(SingletonController, {
        useClass: SingletonController,
        scope: "singleton",
      });

    expect(container.requiresRequestScope(FactoryService)).toBe(false);
    expect(container.requiresRequestScope(SingletonController)).toBe(false);
  });

  test("resolve dependência opcional ausente como undefined", () => {
    class Missing {}
    class Consumer {
      constructor(@Optional(Missing) readonly value: Missing | undefined) {}
    }
    const container = new Container().provide(Consumer);

    expect(container.resolve(Consumer).value).toBeUndefined();
  });

  test("resolve todas as implementações multi na ordem de registro", () => {
    const plugin = Symbol("plugin");
    class Consumer {
      constructor(@InjectAll(plugin) readonly plugins: string[]) {}
    }
    const container = new Container()
      .provide(plugin, { useValue: "first", multi: true })
      .provide(plugin, { useValue: "second", multi: true })
      .provide(Consumer);

    expect(container.resolve(Consumer).plugins).toEqual(["first", "second"]);
    expect(container.resolveAll(plugin)).toEqual(["first", "second"]);
  });

  test("mantém multi singletons no container raiz e descarta apenas no fechamento", async () => {
    const plugin = Symbol("scoped-plugin");
    let activations = 0;
    let disposals = 0;
    const root = new Container().provide(plugin, {
      useFactory: () => ({ id: ++activations }),
      multi: true,
      onDispose: () => {
        disposals++;
      },
    });
    const firstScope = root.createScope();
    const secondScope = root.createScope();

    expect(firstScope.resolveAll(plugin)[0]).toBe(
      secondScope.resolveAll(plugin)[0],
    );
    expect(activations).toBe(1);

    await firstScope.dispose();
    await secondScope.dispose();
    expect(disposals).toBe(0);

    await root.dispose();
    expect(disposals).toBe(1);
  });

  test("considera todos os multi-providers ao definir o scope do controller", async () => {
    const plugin = Symbol("request-plugin");
    let requestInstances = 0;
    class RequestPlugin {
      readonly id = ++requestInstances;
    }
    class Consumer {
      constructor(
        @InjectAll(plugin)
        readonly plugins: Array<{ id: number }>,
      ) {}

      @Get("/")
      get() {
        return this.plugins.map(({ id }) => id);
      }
    }
    Controller("/multi-scope")(Consumer);
    const app = await createApplication(
      testModule([Consumer], {
        providers: [
          { provide: plugin, useValue: { id: 0 }, multi: true },
          {
            provide: plugin,
            useClass: RequestPlugin,
            scope: "request",
            multi: true,
          },
        ],
      }),
      { configure: (runtime) => runtime.configureHttp({ cors: false }) },
    );

    expect(await (await app.test().get("/multi-scope")).json()).toEqual([0, 1]);
    expect(await (await app.test().get("/multi-scope")).json()).toEqual([0, 2]);
    await app.close();
  });

  test("adicionar multi-provider não invalida singleton comum do mesmo token", () => {
    const token = Symbol("mixed-provider");
    const singleton = { kind: "single" };
    const container = new Container().provide<{ kind: string }>(token, {
      useValue: singleton,
    });

    expect(container.resolve<{ kind: string }>(token)).toBe(singleton);
    container.provide<{ kind: string }>(token, {
      useValue: { kind: "multi" },
      multi: true,
    });

    expect(container.resolve<{ kind: string }>(token)).toBe(singleton);
    expect(container.resolveAll<{ kind: string }>(token)).toEqual([
      { kind: "multi" },
    ]);
  });

  test("adia a resolução de provider com @Lazy", () => {
    const token = Symbol("lazy");
    let activations = 0;
    class Consumer {
      constructor(@Lazy(token) readonly getValue: () => string) {}
    }
    const container = new Container()
      .provide(token, { useFactory: () => (++activations, "ready") })
      .provide(Consumer);
    const consumer = container.resolve(Consumer);

    expect(activations).toBe(0);
    expect(consumer.getValue()).toBe("ready");
    expect(activations).toBe(1);
  });

  test("cria providers request-scoped automaticamente por requisição", async () => {
    let nextId = 0;

    class RequestService {
      readonly id = ++nextId;
    }

    class Requests {
      @Get("/")
      get(context: { container: Container }) {
        const first = context.container.resolve(RequestService);
        const second = context.container.resolve(RequestService);

        return {
          same: first === second,
          id: first.id,
        };
      }
    }

    Context()(Requests.prototype, "get", 0);
    Controller("/request-scope")(Requests);

    const app = await createApplication(
      testModule([Requests], {
        providers: [
          {
            provide: RequestService,
            useClass: RequestService,
            scope: "request",
          },
        ],
      }),
      { configure: (runtime) => runtime.configureHttp({ cors: false }) },
    );

    const [first, second] = await Promise.all([
      app.test().get("/request-scope"),
      app.test().get("/request-scope"),
    ]);

    const firstBody = (await first.json()) as {
      same: boolean;
      id: number;
    };
    const secondBody = (await second.json()) as {
      same: boolean;
      id: number;
    };

    expect(firstBody.same).toBe(true);
    expect(secondBody.same).toBe(true);
    expect(firstBody.id).not.toBe(secondBody.id);
  });

  test("injeta provider request no construtor de um controller por requisição", async () => {
    let nextServiceId = 0;
    let nextControllerId = 0;

    class RequestService {
      readonly id = ++nextServiceId;
    }

    class Requests {
      readonly controllerId = ++nextControllerId;

      constructor(
        @Inject(RequestService)
        private readonly service: RequestService,
      ) {}

      @Get("/")
      get(context: { container: Container }) {
        return {
          controllerId: this.controllerId,
          serviceId: this.service.id,
          sameService:
            this.service === context.container.resolve(RequestService),
        };
      }
    }

    Context()(Requests.prototype, "get", 0);
    Controller("/constructor-scope")(Requests);

    const app = await createApplication(
      testModule([Requests], {
        providers: [
          {
            provide: RequestService,
            useClass: RequestService,
            scope: "request",
          },
        ],
      }),
      { configure: (runtime) => runtime.configureHttp({ cors: false }) },
    );

    const first = await app.test().get("/constructor-scope");
    const second = await app.test().get("/constructor-scope");

    const firstBody = (await first.json()) as {
      controllerId: number;
      serviceId: number;
      sameService: boolean;
    };
    const secondBody = (await second.json()) as typeof firstBody;

    expect(firstBody.sameService).toBe(true);
    expect(secondBody.sameService).toBe(true);
    expect(firstBody.controllerId).not.toBe(secondBody.controllerId);
    expect(firstBody.serviceId).not.toBe(secondBody.serviceId);
  });

  test("reutiliza controller sem dependências request", async () => {
    let instances = 0;

    class Stable {
      readonly instance = ++instances;

      @Get("/")
      get() {
        return this.instance;
      }
    }

    Controller("/stable-controller")(Stable);

    const app = await createApplication(testModule([Stable]), {
      configure: (runtime) => runtime.configureHttp({ cors: false }),
    });

    expect(await (await app.test().get("/stable-controller")).json()).toBe(1);
    expect(await (await app.test().get("/stable-controller")).json()).toBe(1);
    expect(instances).toBe(1);
  });

  test("expõe o container da aplicação e encerra providers na ordem inversa", async () => {
    const disposed: string[] = [];

    class First {}
    class Second {}

    const app = await createApplication(
      testModule([], {
        providers: [
          {
            provide: First,
            useClass: First,
            onDispose: () => {
              disposed.push("first");
            },
          },
          {
            provide: Second,
            useClass: Second,
            onDispose: async () => {
              disposed.push("second");
            },
          },
        ],
      }),
    );

    app.container.resolve(First);
    app.container.resolve(Second);

    await app.close();
    await app.close();

    expect(disposed).toEqual(["second", "first"]);
    expect(() => app.container.resolve(First)).toThrow("encerrado");
  });

  test("compartilha uma única ativação assíncrona de singleton concorrente", async () => {
    const token = Symbol("async-singleton");
    let activations = 0;
    const container = new Container().provide(token, {
      useFactory: async () => {
        activations++;
        await Promise.resolve();
        return { activation: activations };
      },
    });

    const [first, second] = await Promise.all([
      container.resolveAsync(token),
      container.resolveAsync(token),
    ]);

    expect(first).toBe(second);
    expect(activations).toBe(1);
    await container.dispose();
  });

  test("aguarda e descarta uma ativação assíncrona iniciada antes do close", async () => {
    const token = Symbol("closing-singleton");
    const disposed: unknown[] = [];
    let finishActivation: (() => void) | undefined;
    const activation = new Promise<void>((resolve) => {
      finishActivation = resolve;
    });
    const container = new Container().provide(token, {
      useFactory: async () => {
        await activation;
        return {};
      },
      onDispose: (value) => {
        disposed.push(value);
      },
    });

    const resolving = container.resolveAsync(token);
    expect(() => container.provide(token, { useValue: {} })).toThrow(
      "está sendo ativado",
    );
    const closing = container.dispose();
    finishActivation?.();
    const value = await resolving;
    await closing;

    expect(disposed).toEqual([value]);
    expect(() => container.resolve(token)).toThrow("encerrado");
  });

  test("encerra providers request depois que a requisição termina", async () => {
    const disposed: number[] = [];
    let nextId = 0;

    class RequestService {
      readonly id = ++nextId;
    }

    class Requests {
      constructor(
        @Inject(RequestService)
        private readonly service: RequestService,
      ) {}

      @Get("/")
      get() {
        return this.service.id;
      }
    }

    Controller("/request-disposal")(Requests);

    const app = await createApplication(
      testModule([Requests], {
        providers: [
          {
            provide: RequestService,
            useClass: RequestService,
            scope: "request",
            onDispose: (service) => {
              disposed.push((service as RequestService).id);
            },
          },
        ],
      }),
      { configure: (runtime) => runtime.configureHttp({ cors: false }) },
    );

    const response = await app.test().get("/request-disposal");

    expect(await response.json()).toBe(1);

    await app.close();

    expect(disposed).toEqual([1]);
  });
});
