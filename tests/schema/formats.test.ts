import { describe, expect, test } from "bun:test";

describe("builtin schema formats", () => {
  test("registra email somente quando um schema é compilado", () => {
    const source = `
      import { FormatRegistry, Type } from "@sinclair/typebox";
      console.log(FormatRegistry.Has("email"));
      const { compileValidator } = await import("./src/decorators/validation.ts");
      console.log(FormatRegistry.Has("email"));
      compileValidator(Type.String({ format: "email" }));
      console.log(FormatRegistry.Has("email"));
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
    ]);
  });
});
