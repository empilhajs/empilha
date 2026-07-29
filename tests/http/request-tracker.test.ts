import { describe, expect, test } from "bun:test";
import { createRequestScope } from "../../src/context";
import { Container } from "../../src/di";
import { RequestTracker } from "../../src/http/request-tracker";

describe("RequestTracker", () => {
  test("limita entradas e libera o limite ao finalizar", () => {
    const tracker = new RequestTracker();

    expect(tracker.tryEnter(1)).toBe(true);
    expect(tracker.tryEnter(1)).toBe(false);
    tracker.leave();
    expect(tracker.tryEnter(1)).toBe(true);
    tracker.leave();
  });

  test("aguarda e limpa scopes ativos", async () => {
    const tracker = new RequestTracker();
    const scope = createRequestScope(
      new Request("http://test"),
      new Container(),
    );

    tracker.tryEnter(null);
    tracker.trackScope(scope);
    tracker.leave();
    tracker.cleanupScope(scope);

    await tracker.waitForIdle();
    expect(tracker.activeScopes.size).toBe(0);
  });
});
