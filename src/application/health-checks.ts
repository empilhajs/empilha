import type { HttpAdapter, ServerResponse } from "../http";
import { createStringRecord } from "../utils";
import type { PostgresQueryRunner } from "../sql";
import { requestContext } from "../context";
import { withTimeout } from "../utils/timeout";
import { validateTimeout } from "../http/adapter-helpers";

export type HealthCheckOptions = {
  /** Prazo individual de cada check, ou `null` para desabilitá-lo. */
  timeout?: number | null;
  /** Máximo de requisições de readiness em execução, ou `null` sem limite. */
  maxConcurrentRequests?: number | null;
};

type HealthCheck = {
  name: string;
  check: (signal: AbortSignal) => boolean | Promise<boolean>;
};

export class HealthCheckRegistry {
  private readonly checks: HealthCheck[] = [];
  private routeRegistered = false;
  private timeoutMs: number | null = 2_000;
  private maxConcurrentRequests: number | null = 8;

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

  configure(options: HealthCheckOptions): void {
    if (options.timeout !== undefined) {
      this.timeoutMs = validateTimeout(options.timeout, "health check");
    }
    if (options.maxConcurrentRequests !== undefined) {
      const { maxConcurrentRequests } = options;
      if (
        maxConcurrentRequests !== null &&
        (!Number.isInteger(maxConcurrentRequests) || maxConcurrentRequests <= 0)
      ) {
        throw new RangeError(
          "O limite de requisições de health check deve ser um inteiro positivo ou null.",
        );
      }
      this.maxConcurrentRequests = maxConcurrentRequests;
    }
  }

  registerRoute(http: HttpAdapter): void {
    if (!this.hasChecks || this.routeRegistered) return;

    http.assertRoutesAvailable([
      { method: "GET", path: "/health/ready" },
      { method: "GET", path: "/health/live" },
    ]);

    let activeReadinessRequests = 0;

    const readinessHandler = async (): Promise<ServerResponse> => {
      if (
        this.maxConcurrentRequests !== null &&
        activeReadinessRequests >= this.maxConcurrentRequests
      ) {
        return { status: 503, body: "", jsonValue: { status: "degraded" } };
      }
      activeReadinessRequests++;
      try {
        const requestSignal = requestContext().signal;
        const checks = await Promise.all(
          this.checks.map(async (healthCheck) => {
            const healthy = await this.runCheck(healthCheck, requestSignal);
            return [healthCheck.name, healthy ? "up" : "down"] as const;
          }),
        );
        const results = createStringRecord();
        let allUp = true;
        for (const [name, status] of checks) {
          results[name] = status;
          if (status === "down") allUp = false;
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
        activeReadinessRequests--;
      }
    };
    readinessHandler.requiresRequestContext = true;
    const livenessHandler = (): ServerResponse => ({
      status: 200,
      body: "",
      jsonValue: { status: "ok" },
    });

    http.get("/health/ready", readinessHandler);
    http.get("/health/live", livenessHandler);

    this.routeRegistered = true;
  }

  private async runCheck(
    healthCheck: HealthCheck,
    requestSignal: AbortSignal,
  ): Promise<boolean> {
    try {
      const controller = new AbortController();
      const abort = () => controller.abort(requestSignal.reason);
      if (requestSignal.aborted) abort();
      else requestSignal.addEventListener("abort", abort, { once: true });

      const operation = Promise.resolve(healthCheck.check(controller.signal));
      const result =
        this.timeoutMs === null
          ? operation
          : withTimeout(operation, this.timeoutMs, () => {
              controller.abort(new Error("Health check timeout"));
              return false;
            });
      return await result.finally(() =>
        requestSignal.removeEventListener("abort", abort),
      );
    } catch {
      return false;
    }
  }
}
