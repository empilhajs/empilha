import { describe, expect, test } from "bun:test";
import { ensureBuiltinFormats } from "../../src/schema/formats";

describe("builtin schema formats", () => {
  test("registra os formatos internos somente quando um schema é compilado", () => {
    const source = `
      import { FormatRegistry, Type } from "@sinclair/typebox";
      console.log(FormatRegistry.Has("email"));
      const { compileValidator } = await import("./src/decorators/validation.ts");
      console.log(FormatRegistry.Has("email"));
      compileValidator(Type.String({ format: "email" }));
      console.log(FormatRegistry.Has("email"));
      compileValidator(Type.String({ format: "date" }));
      console.log(FormatRegistry.Has("date"));
    `;
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", source],
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout).trim().split("\n")).toEqual([
      "false",
      "false",
      "true",
      "true",
    ]);
  });

  test("registra formatos comuns de produção", () => {
    const registered: Record<string, (value: string) => boolean> = {};
    const registry = {
      Has: (name: string) => name in registered,
      Set: (name: string, check: (value: string) => boolean) => {
        registered[name] = check;
      },
    };

    ensureBuiltinFormats(registry);

    expect(registered.uuid?.("550e8400-e29b-41d4-a716-446655440000")).toBe(
      true,
    );
    expect(registered["date-time"]?.("2026-08-06T12:00:00Z")).toBe(true);
    expect(registered.uri?.("https://empilha.dev/docs")).toBe(true);
    expect(registered.ipv4?.("192.168.1.1")).toBe(true);
    expect(registered.hostname?.("api.empilha.dev")).toBe(true);
    expect(registered.ipv4?.("999.1.1.1")).toBe(false);
  });
});
