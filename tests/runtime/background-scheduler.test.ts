import { describe, expect, test } from "bun:test";
import { createRequestScope } from "../../src/context/index";
import { Container } from "../../src/di/index";
import { BackgroundScheduler } from "../../src/runtime/background-scheduler";

function scope() {
  return createRequestScope(
    new Request("http://test/background"),
    new Container(),
  );
}

describe("BackgroundScheduler", () => {
  test("executa jobs dentro do request context", async () => {
    const scheduler = new BackgroundScheduler();
    const requestScope = scope();
    let observed = false;

    const completion = scheduler.schedule(requestScope, "route", () => {
      observed = true;
      expect(() => requestScope.container).not.toThrow();
    });

    expect(completion).not.toBeNull();
    await completion;
    expect(observed).toBe(true);
  });

  test("aguarda e captura observer de erro assíncrono", async () => {
    const scheduler = new BackgroundScheduler();
    let observedError: unknown;
    const logs: unknown[] = [];
    scheduler.setLogger({
      info: () => {},
      warn: () => {},
      error: (details) => logs.push(details),
    });
    scheduler.onError(async (error) => {
      observedError = error;
      throw new Error("observer failure");
    });

    const completion = scheduler.schedule(scope(), "route", () => {
      throw new Error("job failure");
    });

    await completion;
    expect((observedError as Error).message).toBe("job failure");
    expect(logs).toHaveLength(1);
  });
});
