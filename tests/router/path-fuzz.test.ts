import { describe, expect, test } from "bun:test";
import { createFuzzer } from "../helpers/fuzz";
import { normalizePath, splitPath } from "../../src/router/path";

describe("path parser fuzz", () => {
  test("mantém invariantes de normalização em caminhos gerados", () => {
    const fuzzer = createFuzzer(0x50415448);
    for (let index = 0; index < 2_000; index++) {
      const segments = Array.from({ length: 1 + fuzzer.integer(5) }, () =>
        fuzzer.token(1 + fuzzer.integer(12)),
      );
      const raw = `/${segments.join("/" + "/".repeat(fuzzer.integer(3) + 1))}${
        fuzzer.integer(2) === 0 ? "/" : ""
      }`;
      const normalized = normalizePath(raw);

      expect(normalized.startsWith("/")).toBe(true);
      expect(normalized.includes("//")).toBe(false);
      expect(normalized === "/" || normalized.endsWith("/")).toBe(false);
      expect(splitPath(normalized).every((segment) => segment.length > 0)).toBe(
        true,
      );
    }
  });
});
