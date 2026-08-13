import { Controller, createApplication, defineModule, Get } from "../../src";

const DEFAULT_SIZES = [25, 1_000, 10_000];
const sizes = (
  Bun.argv.slice(2).length ? Bun.argv.slice(2) : DEFAULT_SIZES
).map((value) => Number(value));
const gc = (globalThis as { gc?: () => void }).gc;

type Sample = {
  readonly routes: number;
  readonly warmupRequests: number;
  readonly compileMs: number;
  readonly firstResponseMs: number;
  readonly heapBefore: number;
  readonly heapAfterCompile: number;
  readonly heapAfterGc: number;
  readonly rssBefore: number;
  readonly rssAfterCompile: number;
  readonly rssAfterGc: number;
};

function buildModule(count: number) {
  const controllers: (new (...args: never[]) => object)[] = [];
  for (let index = 0; index < count; index++) {
    class RouteController {
      @Get(`/route-${index}`)
      get() {
        return { route: index };
      }
    }
    Object.defineProperty(RouteController, "name", {
      configurable: true,
      value: `BaselineController${index}`,
    });
    Controller(`/baseline-${index}`)(RouteController);
    controllers.push(RouteController);
  }
  return defineModule({ name: `baseline-${count}`, controllers });
}

async function measure(routes: number): Promise<Sample> {
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

  const warmupRequests = 2;
  for (let index = 0; index < warmupRequests; index++) {
    await app.fetch(new Request("http://test/baseline-0/route-0"));
  }

  const responseStart = performance.now();
  const response = await app.fetch(
    new Request("http://test/baseline-0/route-0"),
  );
  const firstResponseMs = performance.now() - responseStart;
  if (response.status !== 200)
    throw new Error(
      `Resposta inesperada no baseline ${routes}: ${response.status}`,
    );

  await app.close();
  gc?.();
  const afterGc = process.memoryUsage();
  return {
    routes,
    warmupRequests,
    compileMs,
    firstResponseMs,
    heapBefore: before.heapUsed,
    heapAfterCompile: afterCompile.heapUsed,
    heapAfterGc: afterGc.heapUsed,
    rssBefore: before.rss,
    rssAfterCompile: afterCompile.rss,
    rssAfterGc: afterGc.rss,
  };
}

for (const size of sizes) {
  if (!Number.isInteger(size) || size <= 0)
    throw new RangeError(`Quantidade de rotas inválida: ${size}`);
}

const samples: Sample[] = [];
for (const size of sizes) samples.push(await measure(size));

console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      samples,
    },
    null,
    2,
  ),
);
