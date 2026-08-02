import { Controller, createApplication, defineModule, Get } from "../../src";

const size = Number(process.argv[2] ?? 1_000);

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
  return defineModule({ name: `register-${count}`, controllers });
}

const module = build(size);
const gc = (globalThis as { gc?: () => void }).gc;
gc?.();
const beforeHeap = process.memoryUsage().heapUsed;
const beforeRss = process.memoryUsage().rss;

const t0 = performance.now();
const app = await createApplication(module, {
  configure(runtime) {
    runtime.configureHttp({ cors: false });
  },
});
const elapsed = performance.now() - t0;

const afterHeap = process.memoryUsage().heapUsed;
const afterRss = process.memoryUsage().rss;
gc?.();
const retainedHeap = process.memoryUsage().heapUsed;
const retainedRss = process.memoryUsage().rss;

console.log(
  `${String(size).padStart(5)} rotas | compile ${elapsed.toFixed(3)} ms | heap ${(beforeHeap / 1024).toFixed(0)}→${(afterHeap / 1024).toFixed(0)} KB (retido ${(retainedHeap / 1024).toFixed(0)}) | rss ${(beforeRss / 1024).toFixed(0)}→${(afterRss / 1024).toFixed(0)} KB (retido ${(retainedRss / 1024).toFixed(0)}) | Δheap retido/rota ${((retainedHeap - beforeHeap) / size).toFixed(1)} B | Δrss retido/rota ${((retainedRss - beforeRss) / size).toFixed(1)} B`,
);

await app.close();
