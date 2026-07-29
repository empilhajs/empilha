import type { Constructor, DependencyToken, ProviderScope } from "./container";

const dependencies = new WeakMap<Constructor, DependencyToken[]>();
const scopes = new WeakMap<Constructor, ProviderScope>();

export function registerDependencies(
  target: Constructor,
  tokens: DependencyToken[],
): void {
  dependencies.set(target, tokens);
}

export function getDependencies(target: Constructor): DependencyToken[] {
  return dependencies.get(target) ?? [];
}

export function registerInjectableScope(
  target: Constructor,
  scope: ProviderScope,
): void {
  scopes.set(target, scope);
}

export function getInjectableScope(
  target: Constructor,
): ProviderScope | undefined {
  return scopes.get(target);
}
