import {
  type ApplicationProvider,
  type Constructor,
  type DependencyToken,
  type ProviderScope,
} from "../../di";
import {
  getDependencies,
  getInjectableScope,
} from "../../di/dependency-metadata";
import {
  isModuleDefinition,
  type ModuleDefinition,
  type ModuleProvider,
} from "../../modules";

export function providerToken(
  provider: ModuleProvider,
): DependencyToken | undefined {
  if (
    typeof provider === "function" ||
    (typeof provider === "object" &&
      provider !== null &&
      "description" in provider)
  )
    return provider as DependencyToken;
  return (provider as ApplicationProvider).provide;
}

export function providerDefinition(
  provider: ModuleProvider,
): ApplicationProvider | undefined {
  if (
    typeof provider === "function" ||
    (typeof provider === "object" &&
      provider !== null &&
      "description" in provider)
  ) {
    return {
      provide: provider as DependencyToken,
      useClass: provider as Constructor,
    };
  }
  return provider as ApplicationProvider;
}

export function isProviderDeclaration(
  provider: ModuleProvider,
): provider is ApplicationProvider {
  return (
    typeof provider === "object" && provider !== null && "provide" in provider
  );
}

export function providerScope(provider: ModuleProvider): ProviderScope {
  if (!isProviderDeclaration(provider)) {
    return typeof provider === "function"
      ? (getInjectableScope(provider) ?? "singleton")
      : "singleton";
  }
  if ("scope" in provider && provider.scope) return provider.scope;
  if ("useClass" in provider)
    return getInjectableScope(provider.useClass) ?? "singleton";
  return "singleton";
}

export function providerDependencies(
  provider: ModuleProvider,
): readonly DependencyToken[] {
  if (!isProviderDeclaration(provider)) {
    return typeof provider === "function" ? getDependencies(provider) : [];
  }
  if ("useClass" in provider) return getDependencies(provider.useClass);
  if ("useFactory" in provider) return provider.inject;
  if ("useExisting" in provider) return [provider.useExisting];
  return [];
}

export function hasDeclaredAsyncFactory(provider: ModuleProvider): boolean {
  if (!isProviderDeclaration(provider) || !("useFactory" in provider))
    return false;
  if (provider.async !== undefined) return provider.async;
  if (provider.useFactory.constructor?.name === "AsyncFunction") return true;
  return /^async(?:\s+function\b|\s*\(|\s+[A-Za-z_$][\w$]*\s*=>)/.test(
    Function.prototype.toString.call(provider.useFactory).trim(),
  );
}

type ModuleExportLike = DependencyToken | ModuleDefinition;

export function exportedTokens(module: ModuleDefinition): DependencyToken[] {
  const tokens: DependencyToken[] = [];
  const visit = (entry: ModuleExportLike): void => {
    if (isModuleDefinition(entry)) {
      for (const nested of entry.exports) visit(nested);
    } else tokens.push(entry);
  };
  for (const entry of module.exports) visit(entry);
  return [...new Set(tokens)];
}

export function moduleExports(
  module: ModuleDefinition,
  byName: ReadonlyMap<string, { readonly exports: readonly DependencyToken[] }>,
): DependencyToken[] {
  const tokens: DependencyToken[] = [];
  for (const exported of module.exports) {
    if (isModuleDefinition(exported)) {
      const imported = byName.get(exported.name);
      if (imported) tokens.push(...imported.exports);
    } else tokens.push(exported);
  }
  return [...new Set(tokens)];
}
