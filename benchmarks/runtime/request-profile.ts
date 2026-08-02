import {
  Body,
  Controller,
  createApplication,
  defineModule,
  Get,
  Param,
  Post,
  QueryParams,
} from "../../src";
import * as t from "@sinclair/typebox";

/**
 * Perfil de request em memória: p50/p95/p99, CPU e retenção de heap.
 *
 * Passa pelo mesmo `HttpAdapter` do servidor via `app.test()` (sem rede),
 * o que isola o custo do pipeline do framework do custo de rede/soquete.
 *
 * Como executar:
 *   bun --expose-gc benchmarks/runtime/request-profile.ts [concurrency] [req/task] [batch]
 *   bun run benchmark:request
 *
 * p50/p95/p99 são calculados sobre a latência de cada request (µs).
 * CPU é o delta de `process.cpuUsage()` sobre a duração da rodada.
 * Heap é o delta retido após GC dividido pelo batch (aproximação ruidosa de
 * retenção, não alocações/churn total; requer `--expose-gc`).
 */

const gc = (globalThis as { gc?: () => void }).gc;

const concurrency = Number(process.argv[2] ?? 16);
const requestsPerTask = Number(process.argv[3] ?? 2_500);
const retentionBatch = Number(process.argv[4] ?? 50_000);
const warmup = 2_000;

type Scenario = {
  name: string;
  call: () => Promise<Response>;
};

@Controller("/bench")
class BenchController {
  @Get("/")
  index() {
    return "ok";
  }

  @Get("/users/:id")
  user(@Param("id") id: string) {
    return { id };
  }

  @Get("/query")
  list(
    @QueryParams(t.Object({ limit: t.Integer(), term: t.Optional(t.String()) }))
    query: unknown,
  ) {
    return query;
  }

  @Post("/json")
  create(
    @Body(t.Object({ name: t.String(), email: t.String() })) body: unknown,
  ) {
    return body;
  }
}

const app = await createApplication(
  defineModule({
    name: "request-profile",
    controllers: [BenchController],
  }),
  {
    configure(runtime) {
      runtime.configureHttp({ cors: false });
    },
  },
);
const client = app.test();

const scenarios: Scenario[] = [
  { name: "ping", call: () => client.get("/bench") },
  { name: "param", call: () => client.get("/bench/users/42") },
  {
    name: "query",
    call: () => client.get("/bench/query?limit=5&term=books"),
  },
  {
    name: "body-known-length",
    call: () => {
      const body = JSON.stringify({ name: "Ada", email: "ada@example.com" });
      return client.post(
        "/bench/json",
        { name: "Ada", email: "ada@example.com" },
        {
          headers: {
            "content-length": String(new TextEncoder().encode(body).byteLength),
          },
        },
      );
    },
  },
  {
    name: "body-stream-no-length",
    call: () => {
      const bytes = new TextEncoder().encode(
        JSON.stringify({ name: "Ada", email: "ada@example.com" }),
      );
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
      return client.request("POST", "/bench/json", {
        headers: { "content-type": "application/json" },
        body,
      });
    },
  },
];

async function consume(response: Response): Promise<void> {
  await response.text();
}

async function warmupFor(scenario: Scenario): Promise<void> {
  for (let i = 0; i < warmup; i++) {
    const response = await scenario.call();
    await consume(response);
  }
}

function stats(sorted: number[]) {
  const n = sorted.length;
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const mean = sum / n;
  const variance =
    sorted.reduce((acc, value) => acc + (value - mean) ** 2, 0) / n;
  const p = (percentile: number) =>
    sorted[Math.min(n - 1, Math.max(0, Math.ceil(percentile * n) - 1))];
  return {
    n,
    mean,
    stddev: Math.sqrt(variance),
    min: sorted[0],
    max: sorted[n - 1],
    p50: p(0.5),
    p95: p(0.95),
    p99: p(0.99),
  };
}

function formatMicro(value: number): string {
  return `${value.toFixed(0).padStart(7)} µs`;
}

async function profile(scenario: Scenario) {
  await warmupFor(scenario);

  const latencies: number[] = [];
  const taskRun = async () => {
    for (let i = 0; i < requestsPerTask; i++) {
      const started = performance.now();
      const response = await scenario.call();
      await consume(response);
      latencies.push((performance.now() - started) * 1_000);
    }
  };

  gc?.();
  const cpu0 = process.cpuUsage();
  const wall0 = performance.now();
  await Promise.all(Array.from({ length: concurrency }, () => taskRun()));
  const wallMs = performance.now() - wall0;
  const cpu = process.cpuUsage(cpu0);
  const cpuUs = cpu.user + cpu.system;

  const total = latencies.length;
  const s = stats([...latencies].sort((a, b) => a - b));
  const reqPerSec = total / (wallMs / 1_000);
  const cpuPercent = (cpuUs / 1_000 / wallMs) * 100;
  const cpuNsPerReq = (cpuUs * 1_000) / total;

  let alloc: { batches: number[] } | null = null;
  if (gc) {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
    const runBatch = async (): Promise<number> => {
      await settle();
      gc();
      gc();
      const base = process.memoryUsage().heapUsed;
      for (let i = 0; i < retentionBatch; i++) {
        const response = await scenario.call();
        await consume(response);
      }
      await settle();
      gc();
      gc();
      const after = process.memoryUsage().heapUsed;
      return (after - base) / retentionBatch;
    };
    // estabiliza retenção one-time antes da 1ª medição
    for (let i = 0; i < retentionBatch; i++) {
      const response = await scenario.call();
      await consume(response);
    }
    const batches = [await runBatch(), await runBatch(), await runBatch()];
    alloc = { batches };
  }

  const sign = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
  const rows = [
    ["req/s", reqPerSec.toFixed(0)],
    ["p50", formatMicro(s.p50)],
    ["p95", formatMicro(s.p95)],
    ["p99", formatMicro(s.p99)],
    ["média", formatMicro(s.mean)],
    ["min", formatMicro(s.min)],
    ["max", formatMicro(s.max)],
    ["stddev", formatMicro(s.stddev)],
    ["CPU", `${cpuPercent.toFixed(1)}% (${cpuNsPerReq.toFixed(0)} ns/req)`],
  ];
  if (alloc) {
    const { batches } = alloc;
    const lowerBound = Math.min(...batches);
    const upperBound = Math.max(...batches);
    const verdict =
      lowerBound >= 100
        ? "possível retenção"
        : upperBound < 100
          ? "sem retenção mensurável"
          : "inconclusivo (GC)";
    rows.push(["heap retido B/req (3 batches)", batches.map(sign).join("  ")]);
    rows.push(["tendência", verdict]);
  }

  const width = Math.max(...rows.map(([label]) => label.length));
  console.log(
    `\n=== ${scenario.name} — ${total.toLocaleString("pt-BR")} requests ===`,
  );
  for (const [label, value] of rows) {
    console.log(`  ${label.padEnd(width)}  ${value}`);
  }
}

for (const scenario of scenarios) {
  await profile(scenario);
}

if (!gc) {
  console.error(
    "\n[aviso] gc() indisponível — rode com `bun --expose-gc` para medir retenção.",
  );
}
