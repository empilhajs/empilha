import { Type } from "@sinclair/typebox";
import { compileValidator } from "../../src/decorators";
import { compileResponseSerializer } from "../../src/http/response-serializer";

const DEFAULT_SIZES = [25, 100, 500];
const sizes = (
  Bun.argv.slice(2).length ? Bun.argv.slice(2) : DEFAULT_SIZES
).map(Number);
const gc = (globalThis as { gc?: () => void }).gc;

type ValidatorSample = Readonly<{
  schemas: number;
  validatorMs: number;
  serializerMs: number;
  totalMs: number;
  heapBefore: number;
  heapAfter: number;
  heapAfterGc: number;
  rssBefore: number;
  rssAfter: number;
  rssAfterGc: number;
}>;

function buildSchemas(count: number) {
  return Array.from({ length: count }, (_, index) =>
    Type.Object({
      id: Type.Integer(),
      name: Type.String({ minLength: 1 }),
      active: Type.Boolean(),
      score: Type.Number(),
      tags: Type.Array(Type.String()),
      nested: Type.Object({
        index: Type.Integer({ minimum: index }),
        createdAt: Type.String(),
      }),
    }),
  );
}

function measure(schemas: number): ValidatorSample {
  gc?.();
  const before = process.memoryUsage();
  const values = buildSchemas(schemas);
  const totalStart = performance.now();
  const validatorStart = totalStart;
  const validators = values.map((schema) => compileValidator(schema));
  const validatorMs = performance.now() - validatorStart;
  const serializerStart = performance.now();
  const serializers = values.map((schema) => compileResponseSerializer(schema));
  const serializerMs = performance.now() - serializerStart;
  const after = process.memoryUsage();

  for (let index = 0; index < values.length; index++) {
    validators[index]?.({
      id: index,
      name: "profile",
      active: true,
      score: index,
      tags: [],
      nested: { index, createdAt: "now" },
    });
    serializers[index]?.({
      id: index,
      name: "profile",
      active: true,
      score: index,
      tags: [],
      nested: { index, createdAt: "now" },
    });
  }
  gc?.();
  const afterGc = process.memoryUsage();
  return {
    schemas,
    validatorMs,
    serializerMs,
    totalMs: performance.now() - totalStart,
    heapBefore: before.heapUsed,
    heapAfter: after.heapUsed,
    heapAfterGc: afterGc.heapUsed,
    rssBefore: before.rss,
    rssAfter: after.rss,
    rssAfterGc: afterGc.rss,
  };
}

for (const size of sizes) {
  if (!Number.isInteger(size) || size <= 0)
    throw new RangeError(`Quantidade de schemas inválida: ${size}`);
}

console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      scenario: "validator-serializer-compilation",
      bun: Bun.version,
      samples: sizes.map(measure),
    },
    null,
    2,
  ),
);
