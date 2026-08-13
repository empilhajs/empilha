import type { Constructor, DependencyToken, ProviderScope } from "./container";

export type DependencyDescriptor = {
  token: DependencyToken;
  optional?: boolean;
  all?: boolean;
  lazy?: boolean;
};

const dependencies = new WeakMap<Constructor, DependencyToken[]>();
const descriptors = new WeakMap<Constructor, DependencyDescriptor[]>();
const scopes = new WeakMap<Constructor, ProviderScope>();

export function registerDependencies(
  target: Constructor,
  tokens: DependencyToken[],
): void {
  dependencies.set(target, tokens);
  descriptors.set(
    target,
    tokens.map((token) => ({ token })),
  );
}

export function getDependencies(target: Constructor): DependencyToken[] {
  return dependencies.get(target) ?? [];
}

export function registerDependencyDescriptor(
  target: Constructor,
  index: number,
  descriptor: DependencyDescriptor,
): void {
  const tokens = [...getDependencies(target)];
  tokens[index] = descriptor.token;
  dependencies.set(target, tokens);
  const current = [...(descriptors.get(target) ?? [])];
  current[index] = descriptor;
  descriptors.set(target, current);
}

export function getDependencyDescriptors(
  target: Constructor,
): DependencyDescriptor[] {
  return (
    descriptors.get(target) ??
    getDependencies(target).map((token) => ({ token }))
  );
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
