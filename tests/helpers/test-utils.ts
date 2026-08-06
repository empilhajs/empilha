import { expect } from "bun:test";
import {
  defineDeclarativePlugin,
  defineModule,
  type AuthTokenHandler,
  type DeclarativePostgresOptions,
  type ModuleController,
  type ModuleDefinition,
  type PostgresQueryRunner,
} from "../../src";

export function request(url: string, init?: RequestInit): Request {
  return new Request(`http://test${url}`, init);
}

export async function json(response: Response): Promise<unknown> {
  return response.json();
}

export function expectHeader(
  response: Response,
  name: string,
  value: string,
): void {
  expect(response.headers.get(name)).toBe(value);
}

let testModuleSequence = 0;
let testPluginSequence = 0;
let testPortSequence = 0;

/** Fornece portas distintas quando Bun não consegue reutilizar `listen(0)` em testes concorrentes. */
export function testPort(): number {
  testPortSequence++;
  return 30_000 + (((process.pid % 500) * 20 + testPortSequence) % 20_000);
}

export function testModule(
  controllers: readonly ModuleController[],
  options: Omit<
    Parameters<typeof defineModule>[0],
    "name" | "controllers"
  > = {},
): ModuleDefinition {
  testModuleSequence++;
  return defineModule({
    name: `test-module-${testModuleSequence}`,
    ...options,
    controllers,
  });
}

export function testAuthPlugin(handler: AuthTokenHandler) {
  testPluginSequence++;
  return defineDeclarativePlugin({
    name: `test-auth-${testPluginSequence}`,
    version: "1.0.0",
    provides: ["auth/handler"],
    register(context) {
      context.auth(handler);
    },
  });
}

export function testPostgresPlugin(
  runner: PostgresQueryRunner,
  options: DeclarativePostgresOptions = { healthCheck: false },
) {
  testPluginSequence++;
  return defineDeclarativePlugin({
    name: `test-postgres-${testPluginSequence}`,
    version: "1.0.0",
    provides: ["postgres/query-runner"],
    register(context) {
      context.postgres(runner, options);
    },
  });
}

export function decorateMethod(
  decorator: MethodDecorator,
  target: object,
  propertyKey: string,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, propertyKey);

  if (!descriptor) {
    throw new Error(`Método "${propertyKey}" não encontrado`);
  }

  decorator(target, propertyKey, descriptor);
}

export function createQueryRunnerMock(rows: unknown[] = []): {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  calls: Array<{ sql: string; params?: unknown[] }>;
} {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows };
    },
  };
}
