import { Container } from "../../src/di";

const iterations = Number(Bun.argv[2] ?? 10_000);
if (!Number.isInteger(iterations) || iterations <= 0)
  throw new RangeError("iterations deve ser um inteiro positivo");

const singletonToken = Symbol("singleton-factory");
const requestToken = Symbol("request-factory");
const root = new Container()
  .provide(singletonToken, { useFactory: () => ({}), scope: "singleton" })
  .provide(requestToken, { useFactory: () => ({}), scope: "request" });

const singletonStart = performance.now();
for (let index = 0; index < iterations; index++) root.resolve(singletonToken);
const singletonMs = performance.now() - singletonStart;

const requestStart = performance.now();
for (let index = 0; index < iterations; index++) {
  const scope = root.createScope();
  scope.resolve(requestToken);
  scope.tryDisposeSynchronously();
}
const requestMs = performance.now() - requestStart;

console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      iterations,
      singletonFactoryMs: singletonMs,
      requestFactoryMs: requestMs,
      requestOverheadPercent: (requestMs / singletonMs - 1) * 100,
    },
    null,
    2,
  ),
);
