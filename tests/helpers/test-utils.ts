import { expect } from "bun:test";
import type { ControllerConstructor } from "../../src/empilha";
import { Empilha } from "../../src";

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

export function createTestApp(
  ...controllers: ControllerConstructor[]
): Empilha {
  const app = new Empilha().configureHttp({ cors: false });
  app.validate(controllers).initialize(controllers);
  return app;
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
