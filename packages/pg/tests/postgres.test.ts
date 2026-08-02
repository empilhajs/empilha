import { describe, expect, test } from "bun:test";
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
          if ("useValue" in provider && provider.useValue) {
            pool = provider.useValue as { options: Record<string, unknown> };
          }
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
});
