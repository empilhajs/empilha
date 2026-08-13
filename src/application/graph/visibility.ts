import type { DependencyToken } from "../../di";
import type { GeneratedQuery } from "../../sql/generated-query";
import {
  exportedTokens,
  hasDeclaredAsyncFactory,
  providerDependencies,
  providerScope,
  providerToken,
} from "./provider-utils";
import type {
  ModuleController,
  ModuleDefinition,
  ModuleProvider,
} from "../../modules";

export type VisibleProvider = {
  owner: ModuleDefinition;
  provider: ModuleProvider;
};

export function collectVisibleQueries(
  module: ModuleDefinition,
): Map<string, GeneratedQuery> {
  const visible = new Map<string, GeneratedQuery>();
  const visit = (
    current: ModuleDefinition,
    visited = new Set<ModuleDefinition>(),
  ): void => {
    if (visited.has(current)) return;
    visited.add(current);
    for (const query of current.queries) visible.set(query.id, query);
    for (const imported of current.imports) visit(imported, visited);
  };
  visit(module);
  return visible;
}

export function findVisibleProvider(
  current: ModuleDefinition,
  token: DependencyToken,
  visited = new Set<ModuleDefinition>(),
): VisibleProvider | undefined {
  if (visited.has(current)) return undefined;
  visited.add(current);
  const local = current.providers.find(
    (candidate) => providerToken(candidate) === token,
  );
  if (local !== undefined) return { owner: current, provider: local };
  if (current.controllers.includes(token as ModuleController)) {
    return { owner: current, provider: token as ModuleController };
  }
  for (const imported of current.imports) {
    if (!exportedTokens(imported).includes(token)) continue;
    const result = findVisibleProvider(imported, token, visited);
    if (result !== undefined) return result;
  }
  return undefined;
}

export function findVisibleProviders(
  current: ModuleDefinition,
  token: DependencyToken,
  visited = new Set<ModuleDefinition>(),
): VisibleProvider[] {
  if (visited.has(current)) return [];
  visited.add(current);
  const local = current.providers
    .filter((candidate) => providerToken(candidate) === token)
    .map((provider) => ({ owner: current, provider }));
  if (local.length > 0) return local;
  if (current.controllers.includes(token as ModuleController))
    return [{ owner: current, provider: token as ModuleController }];
  return current.imports.flatMap((imported) =>
    exportedTokens(imported).includes(token)
      ? findVisibleProviders(imported, token, visited)
      : [],
  );
}

export function requiresRequestScope(
  current: ModuleDefinition,
  token: DependencyToken,
  stack = new Set<DependencyToken>(),
): boolean {
  if (stack.has(token)) return false;
  const resolved = findVisibleProviders(current, token);
  if (resolved.length === 0) return false;
  const nextStack = new Set(stack).add(token);
  return resolved.some(
    (candidate) =>
      providerScope(candidate.provider) === "request" ||
      providerDependencies(candidate.provider).some((dependency) =>
        requiresRequestScope(candidate.owner, dependency, nextStack),
      ),
  );
}

export function findAsyncRequestFactory(
  current: ModuleDefinition,
  token: DependencyToken,
  stack = new Set<DependencyToken>(),
): { token: DependencyToken; provider: ModuleProvider } | undefined {
  if (stack.has(token)) return undefined;
  const resolved = findVisibleProviders(current, token);
  if (resolved.length === 0) return undefined;
  const nextStack = new Set(stack).add(token);
  for (const candidate of resolved) {
    if (
      providerScope(candidate.provider) === "request" &&
      hasDeclaredAsyncFactory(candidate.provider)
    ) {
      return { token, provider: candidate.provider };
    }
    for (const dependency of providerDependencies(candidate.provider)) {
      const found = findAsyncRequestFactory(
        candidate.owner,
        dependency,
        nextStack,
      );
      if (found !== undefined) return found;
    }
  }
  return undefined;
}
