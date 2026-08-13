import { describe, expect, test } from "bun:test";
import {
  Controller,
  Get,
  Result,
  Sql,
  createApplication,
  defineGeneratedQuery,
  defineModule,
} from "empilha";
import { postgres } from "../src";

describe("@empilha/pg", () => {
  test("cria o pool e declara integração no novo bootstrap", async () => {
    let pool: { options: Record<string, unknown> } | undefined;
    let receivedOptions: Record<string, unknown> | undefined;

    const plugin = postgres({
      url: "postgres://localhost/empilha",
      max: 4,
      sql: "./queries",
      timeout: 2500,
      healthCheck: "postgres",
    });

    const providers: unknown[] = [];
    let close: (() => Promise<void>) | undefined;
    await plugin.descriptor.register(
      {
        provider(provider) {
          providers.push(provider);
          const value = "useValue" in provider ? provider.useValue : undefined;
          if (typeof value === "object" && value !== null && "options" in value)
            pool = value as { options: Record<string, unknown> };
        },
        postgres(_runner, options) {
          receivedOptions = options as Record<string, unknown>;
        },
        onClose(hook) {
          close = hook;
        },
        healthCheck() {},
        provideCapability() {},
        auth() {},
      },
      undefined,
    );

    expect(pool).toBeDefined();
    expect(pool?.options.statement_timeout).toBe(2500);
    expect(pool?.options.query_timeout).toBeUndefined();
    expect(receivedOptions).toEqual({
      sql: "./queries",
      timeout: 2500,
      healthCheck: "postgres",
      close: false,
    });
    expect(providers).toHaveLength(2);

    await close?.();
  });

  test("preserva healthCheck false e os defaults do pool", async () => {
    let received: { options: { healthCheck?: string | false } } | undefined;
    const plugin = postgres({
      url: "postgres://localhost/empilha",
      healthCheck: false,
    });

    await plugin.descriptor.register(
      {
        provider() {},
        postgres(_pool, options) {
          received = { options };
        },
        onClose() {},
        healthCheck() {},
        provideCapability() {},
        auth() {},
      },
      undefined,
    );

    expect(received?.options).toEqual({
      sql: undefined,
      timeout: undefined,
      healthCheck: false,
      close: false,
    });
  });

  test.skipIf(!process.env.DATABASE_URL)(
    "executa query e cancela pg_sleep com o plugin real",
    async () => {
      const valueQuery = defineGeneratedQuery({
        id: "value",
        source: "integration.sql",
        cardinality: "one",
        sql: "SELECT 1 AS value",
      });
      const sleepQuery = defineGeneratedQuery({
        id: "sleep",
        source: "integration.sql",
        cardinality: "one",
        sql: "SELECT pg_sleep(2) AS value",
      });

      @Controller("/integration")
      class IntegrationController {
        @Get("/value")
        @Sql(valueQuery)
        @Result("one")
        value() {}

        @Get("/sleep")
        @Sql(sleepQuery)
        @Result("one")
        sleep() {}
      }

      const app = await createApplication(
        defineModule({
          name: "pg-integration",
          controllers: [IntegrationController],
          queries: [valueQuery, sleepQuery],
          plugins: [
            postgres({
              url: process.env.DATABASE_URL!,
              timeout: 500,
              statement_timeout: 1_500,
              healthCheck: false,
            }),
          ],
        }),
        {
          configure: (runtime) => runtime.configureHttp({ cors: false }),
        },
      );

      try {
        const result = await app.test().get("/integration/value");
        expect(result.status).toBe(200);
        expect(await result.json()).toEqual({ value: 1 });

        const timeout = await app.test().get("/integration/sleep");
        expect(timeout.status).toBe(504);
      } finally {
        await app.close();
      }
    },
  );
});
