import type { HttpAdapter, ServerResponse } from "../http";
import { createStringRecord } from "../utils";
import type { PostgresQueryRunner } from "../sql";
import { requestContext } from "../context";
import { withTimeout } from "../utils/timeout";

type HealthCheck = {
  name: string;
  check: (signal: AbortSignal) => boolean | Promise<boolean>;
};

export class HealthCheckRegistry {
  private readonly checks: HealthCheck[] = [];
  private routeRegistered = false;

  add(
    name: string,
    check:
      | ((signal?: AbortSignal) => boolean | Promise<boolean>)
      | PostgresQueryRunner,
  ): void {
    const normalizedName = name.trim();
    if (!normalizedName) {
      throw new Error("O nome do health check não pode ser vazio.");
    }
    if (
      this.checks.some((healthCheck) => healthCheck.name === normalizedName)
    ) {
      throw new Error(`O health check "${normalizedName}" já foi registrado.`);
    }

    this.checks.push({
      name: normalizedName,
      check:
        typeof check === "function"
          ? (signal) => check(signal)
          : async (signal) => {
              await check.query("SELECT 1", undefined, { signal });
              return true;
            },
    });
  }

  get hasChecks(): boolean {
    return this.checks.length > 0;
  }

  registerRoute(http: HttpAdapter): void {
    if (!this.hasChecks || this.routeRegistered) return;

    let activeChecks = 0;
    const maxActiveChecks = 8;
    const checkTimeoutMs = 2_000;

    http.get("/health", async (): Promise<ServerResponse> => {
      if (activeChecks >= maxActiveChecks) {
        return { status: 503, body: "", jsonValue: { status: "degraded" } };
      }
      activeChecks++;
      try {
        const results = createStringRecord();
        let allUp = true;
        const requestSignal = requestContext().signal;

        for (const healthCheck of this.checks) {
          try {
            const controller = new AbortController();
            const abort = () => controller.abort(requestSignal.reason);
            if (requestSignal.aborted) abort();
            else requestSignal.addEventListener("abort", abort, { once: true });
            const healthy = await withTimeout(
              Promise.resolve(healthCheck.check(controller.signal)),
              checkTimeoutMs,
              () => {
                controller.abort(new Error("Health check timeout"));
                return false;
              },
            ).finally(() => requestSignal.removeEventListener("abort", abort));
            results[healthCheck.name] = healthy ? "up" : "down";
            if (!healthy) allUp = false;
          } catch {
            results[healthCheck.name] = "down";
            allUp = false;
          }
        }

        return {
          status: allUp ? 200 : 503,
          body: "",
          jsonValue: {
            status: allUp ? "ok" : "degraded",
            checks: results,
          },
        };
      } finally {
        activeChecks--;
      }
    });

    this.routeRegistered = true;
  }
}
