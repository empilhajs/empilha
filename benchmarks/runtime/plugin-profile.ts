import {
  Controller,
  createApplication,
  createToken,
  defineDeclarativePlugin,
  defineModule,
  Get,
} from "../../src";

const DEFAULT_SIZES = [25, 1_000, 10_000];
const sizes = (
  Bun.argv.slice(2).length ? Bun.argv.slice(2) : DEFAULT_SIZES
).map(Number);
const gc = (globalThis as { gc?: () => void }).gc;
const PluginState = createToken<Readonly<{ routes: number }>>(
  "benchmark/plugin-state",
);

type PluginSample = Readonly<{
  routes: number;
  compileMs: number;
  loadMs: number;
  requests: number;
  heapBefore: number;
  heapAfterCompile: number;
  heapAfterLoad: number;
  heapAfterGc: number;
  rssBefore: number;
  rssAfterCompile: number;
  rssAfterLoad: number;
  rssAfterGc: number;
}>;

function buildModule(routes: number) {
  const controllers: (new (...args: never[]) => object)[] = [];
  for (let index = 0; index < routes; index++) {
    class RouteController {
      @Get(`/route-${index}`)
      get() {
        return { route: index };
      }
    }
    Object.defineProperty(RouteController, "name", {
      configurable: true,
      value: `PluginController${index}`,
    });
    Controller(`/plugin-${index}`)(RouteController);
    controllers.push(RouteController);
  }

  const plugin = defineDeclarativePlugin({
    name: `benchmark-plugin-${routes}`,
    version: "1.0.0",
    register(context) {
      context.provider({
        provide: PluginState,
        useValue: Object.freeze({ routes }),
      });
    },
  });
  return defineModule({
    name: `plugin-profile-${routes}`,
    controllers,
    plugins: [plugin],
  });
}

async function measure(routes: number): Promise<PluginSample> {
  const module = buildModule(routes);
  gc?.();
  const before = process.memoryUsage();
  const compileStart = performance.now();
  const app = await createApplication(module, {
    configure(runtime) {
      runtime.configureHttp({ cors: false });
    },
  });
  const compileMs = performance.now() - compileStart;
  const afterCompile = process.memoryUsage();

  const requests = Math.min(1_000, Math.max(25, routes));
  const loadStart = performance.now();
  const responses = await Promise.all(
    Array.from({ length: requests }, () =>
      app.fetch(new Request("http://test/plugin-0/route-0")),
    ),
  );
  const loadMs = performance.now() - loadStart;
  if (responses.some((response) => response.status !== 200))
    throw new Error(`Carga inválida no cenário de ${routes} rotas.`);
  const afterLoad = process.memoryUsage();

  await app.close();
  gc?.();
  const afterGc = process.memoryUsage();
  return {
    routes,
    compileMs,
    loadMs,
    requests,
    heapBefore: before.heapUsed,
    heapAfterCompile: afterCompile.heapUsed,
    heapAfterLoad: afterLoad.heapUsed,
    heapAfterGc: afterGc.heapUsed,
    rssBefore: before.rss,
    rssAfterCompile: afterCompile.rss,
    rssAfterLoad: afterLoad.rss,
    rssAfterGc: afterGc.rss,
  };
}

for (const size of sizes) {
  if (!Number.isInteger(size) || size <= 0)
    throw new RangeError(`Quantidade de rotas inválida: ${size}`);
}

const samples: PluginSample[] = [];
for (const size of sizes) samples.push(await measure(size));

console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      scenario: "plugin-activation-load-gc",
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      samples,
    },
    null,
    2,
  ),
);
