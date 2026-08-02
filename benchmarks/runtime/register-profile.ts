import { Controller, createApplication, defineModule, Get } from "../../src";
import { ControllerRegistry } from "../../src/application/bootstrap/controller-registry";
import { RouteHandlerBuilder } from "../../src/application/bootstrap/route-handler-builder";
import { ControllerBootstrap } from "../../src/application/bootstrap/controller-bootstrap";
import { OpenApiDocumentBuilder } from "../../src/openapi/openapi-document";
import { HttpAdapter } from "../../src/http/http-adapter";
import { RouteTree } from "../../src/router/route-tree";

const size = Number(process.argv[2] ?? 10_000);

function build(count: number) {
  const controllers: unknown[] = [];
  for (let i = 0; i < count; i++) {
    class C {
      @Get(`/route-${i}`)
      get() {
        return "ok";
      }
    }
    Controller(`/c${i}`)(C);
    controllers.push(C);
  }
  return defineModule({ name: `register-profile-${count}`, controllers });
}

const samples: Record<string, number[]> = {};

function wrap(label: string, target: object, name: string): void {
  const original = (target as Record<string, (...args: unknown[]) => unknown>)[
    name
  ];
  const times = (samples[label] = []);
  (target as Record<string, (...args: unknown[]) => unknown>)[name] = function (
    this: unknown,
    ...args: unknown[]
  ): unknown {
    const t0 = performance.now();
    try {
      return original.apply(this, args);
    } finally {
      times.push(performance.now() - t0);
    }
  };
}

wrap("registry.register", ControllerRegistry.prototype, "register");
wrap("prepareController", ControllerRegistry.prototype, "prepareController");
wrap("handler.compile", RouteHandlerBuilder.prototype, "compile");
wrap("provideController", ControllerBootstrap.prototype, "provideController");
wrap("createResolver", ControllerBootstrap.prototype, "createResolver");
wrap("requiresScope", ControllerBootstrap.prototype, "requiresRequestContext");
wrap("openapi.addRoute", OpenApiDocumentBuilder.prototype, "addRoute");
wrap("http.addRoute", HttpAdapter.prototype, "addRoute");
wrap("router.insert", RouteTree.prototype, "insert");

const module = build(size);
const start = performance.now();
const app = await createApplication(module, {
  configure(runtime) {
    runtime.configureHttp({ cors: false });
  },
});
const total = performance.now() - start;
const sum = (name: string): number =>
  (samples[name] ?? []).reduce((acc, t) => acc + t, 0);
const avg = (name: string): number => sum(name) / (samples[name]?.length ?? 1);

const registry = sum("registry.register");
const prep = sum("prepareController");
const compile = sum("handler.compile");
const openApi = sum("openapi.addRoute");
const httpReg = sum("http.addRoute");
const treeInsert = sum("router.insert");
const provide = sum("provideController");
const resolver = sum("createResolver");
const requiresScope = sum("requiresScope");
const bootstrap = provide + resolver + requiresScope;
const snapshotOther = registry - prep - openApi - httpReg;

function row(label: string, ms: number, calls: number, indent = ""): void {
  const pct = ((ms / total) * 100).toFixed(1).padStart(6);
  const perCall = calls > 0 ? (ms / calls).toFixed(3) : "0";
  console.log(
    `${indent}${label.padEnd(40)} ${ms.toFixed(3).padStart(10)} ms  ${pct}%  ${String(calls).padStart(6)} ch  ~${perCall} ms/ch`,
  );
}

console.log(`\n=== Perfil de createApplication — ${size} rotas ===\n`);
row("total createApplication", total, 1);
row("registry.register", registry, 1);
row("prepareController", prep, size, "  └─ ");
row("handlerBuilder.compile", compile, size, "      ├─ ");
row("bootstrap (provide+resolver+scope)", bootstrap, size * 3, "      ├─ ");
row("  provideController", provide, size, "      │   ├─ ");
row("  createResolver", resolver, size, "      │   ├─ ");
row("  requiresRequestContext", requiresScope, size, "      │   └─ ");
row(
  "restante do prepareController",
  prep - compile - bootstrap,
  size,
  "      └─ ",
);
row("openapi.addRoute", openApi, size, "  └─ ");
row("http.addRoute", httpReg, size, "  └─ ");
row("  router.insert", treeInsert, size, "      └─ ");
row("snapshot + lifecycle + health", snapshotOther, 1, "  └─ ");

console.log("\n=== Média por rota ===\n");
console.log(`handler compile : ${avg("handler.compile").toFixed(3)} ms/rota`);
console.log(`openapi addRoute: ${avg("openapi.addRoute").toFixed(3)} ms/rota`);
console.log(`http addRoute   : ${avg("http.addRoute").toFixed(3)} ms/rota`);

await app.close();
