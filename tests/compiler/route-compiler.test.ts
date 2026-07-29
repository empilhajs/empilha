import { describe, expect, test } from "bun:test";
import { compileRoute } from "../../src/compiler/route-compiler";
import type { RouteCompilerInput } from "../../src/compiler/types";
import type { RegisteredRouteMetadata } from "../../src/types";

function route(
  extra: Partial<RegisteredRouteMetadata> = {},
): RegisteredRouteMetadata {
  return {
    propertyKey: "run",
    method: "GET",
    path: "/",
    parameters: [],
    ...extra,
  };
}

function compilerInput(
  value: unknown,
  extra: Partial<RouteCompilerInput> = {},
): RouteCompilerInput {
  return {
    route: route(),
    resolveController: () => ({
      run: () => value,
    }),
    getArgs: () => [],
    createResponse: (result) => ({
      status: 200,
      body: String(result),
    }),
    authorize: async () => null,
    executeSql: null,
    handleError: async (error) => ({
      status: 500,
      body: String(error),
    }),
    middlewares: [],
    executeBackground: () => ({
      status: 202,
      body: "{}",
    }),
    ...extra,
  };
}

describe("route compiler", () => {
  test("monta o handler sem executar o controller", async () => {
    let executions = 0;

    const input = compilerInput("ok", {
      resolveController: () => ({
        run: () => {
          executions++;
          return "ok";
        },
      }),
    });

    const compiled = compileRoute(input);

    expect(executions).toBe(0);
    const response = await compiled.handler({
      method: "GET",
      pathname: "/",
      headers: {},
      params: {},
      query: {},
      body: undefined,
    });

    expect(response).toEqual({ status: 200, body: "ok" });
    expect(executions).toBe(1);
  });

  test("mantém erro assíncrono no handler de erro", async () => {
    const compiled = compileRoute(
      compilerInput(undefined, {
        resolveController: () => ({
          run: async () => {
            throw new Error("failed");
          },
        }),
        handleError: async (error) => ({
          status: 503,
          body: String(error instanceof Error ? error.message : error),
        }),
      }),
    );

    const response = await compiled.handler({
      method: "GET",
      pathname: "/",
      headers: {},
      params: {},
      query: {},
      body: undefined,
    });

    expect(response).toEqual({ status: 503, body: "failed" });
  });
});
