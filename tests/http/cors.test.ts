import { describe, expect, test } from "bun:test";
import { HttpAdapter } from "../../src";
import { request } from "../helpers/test-utils";

describe("CORS", () => {
  test("configura origem, métodos e headers no preflight", async () => {
    const adapter = new HttpAdapter();

    adapter.enableCors("https://example.test", "GET", "X-Token");

    const response = await adapter.handleRequest(
      request("/", {
        method: "OPTIONS",
        headers: {
          Origin: "https://example.test",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "X-Token",
        },
      }),
    );

    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://example.test",
    );

    expect(response.headers.get("access-control-allow-methods")).toBe("GET");

    expect(response.headers.get("access-control-allow-headers")).toBe(
      "X-Token",
    );
    expect(response.headers.get("vary")).toBe("Origin");
  });
});
