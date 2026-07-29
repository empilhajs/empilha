import type { HttpAdapter, ServerResponse } from "../http";
import { createStringRecord } from "../utils";
import type { PostgresQueryRunner } from "../sql";

type HealthCheck = {
  name: string;
  check: () => boolean | Promise<boolean>;
};

export class HealthCheckRegistry {
  private readonly checks: HealthCheck[] = [];
  private routeRegistered = false;

  add(
    name: string,
    check: (() => boolean | Promise<boolean>) | PostgresQueryRunner,
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
          ? check
          : async () => {
              await check.query("SELECT 1");
              return true;
            },
    });
  }

  get hasChecks(): boolean {
    return this.checks.length > 0;
  }

  registerRoute(http: HttpAdapter): void {
    if (!this.hasChecks || this.routeRegistered) return;

    http.get("/health", async (): Promise<ServerResponse> => {
      const results = createStringRecord();
      let allUp = true;

      for (const healthCheck of this.checks) {
        try {
          const healthy = await healthCheck.check();
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
    });

    this.routeRegistered = true;
  }
}
