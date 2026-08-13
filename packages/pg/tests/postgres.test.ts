import { describe, expect, test } from "bun:test";
import { type PostgresQueryRunner } from "empilha";
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
    "executa, cancela e reutiliza o plugin real",
    async () => {
      const plugin = postgres({
        url: process.env.DATABASE_URL!,
        statement_timeout: 1_500,
        healthCheck: false,
      });
      let runner: PostgresQueryRunner | undefined;
      let close: (() => Promise<void>) | undefined;
      await plugin.descriptor.register(
        {
          provider() {},
          postgres(value) {
            runner = value;
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

      try {
        expect(runner).toBeDefined();
        expect((await runner!.query("SELECT 1 AS value")).rows).toEqual([
          { value: 1 },
        ]);

        const controller = new AbortController();
        const sleeping = runner!.query("SELECT pg_sleep(2)", undefined, {
          signal: controller.signal,
        });
        setTimeout(() => controller.abort(), 100);
        await expect(sleeping).rejects.toMatchObject({ code: "57014" });

        expect((await runner!.query("SELECT 2 AS value")).rows).toEqual([
          { value: 2 },
        ]);
      } finally {
        await close?.();
      }
    },
  );
});
