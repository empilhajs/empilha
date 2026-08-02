import { describe, expect, test } from "bun:test";
import {
  checkBunVersion,
  readBunVersionCheck,
} from "../../scripts/checks/check-bun-version";

describe("Bun version gate", () => {
  test("aceita o runtime atual contra mínimo e baseline", () => {
    const result = readBunVersionCheck();
    expect(result.ok).toBe(true);
    expect(result.current).toBe(Bun.version);
  });

  test("rejeita runtime abaixo do mínimo e da baseline", () => {
    const result = checkBunVersion("1.2.9", "1.3.0", "1.3.14");
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      "Bun 1.2.9 está abaixo do mínimo 1.3.0.",
      "Bun 1.2.9 está abaixo da baseline estável testada 1.3.14.",
    ]);
  });
});
