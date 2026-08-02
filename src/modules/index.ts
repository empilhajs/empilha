import type { ApplicationProvider, DependencyToken } from "../di";
import type { GeneratedQuery } from "../sql/generated-query";

const moduleBrand = Symbol("empilha.module");

export type ModuleExport = DependencyToken | ModuleDefinition;
export type ModuleProvider = DependencyToken | ApplicationProvider;
export type ModuleController = new (...args: never[]) => object;

export type ModuleDefinition = Readonly<{
  readonly name: string;
  readonly imports: readonly ModuleDefinition[];
  readonly controllers: readonly ModuleController[];
  readonly providers: readonly ModuleProvider[];
  readonly queries: readonly GeneratedQuery[];
  readonly plugins: readonly unknown[];
  readonly exports: readonly ModuleExport[];
}> & { readonly [moduleBrand]: true };

export type ModuleOptions = {
  name: string;
  imports?: readonly ModuleDefinition[];
  controllers?: readonly ModuleController[];
  providers?: readonly ModuleProvider[];
  queries?: readonly GeneratedQuery[];
  plugins?: readonly unknown[];
  exports?: readonly ModuleExport[];
};

/** Declara um módulo sem executar bootstrap ou efeitos de infraestrutura. */
export function defineModule(options: ModuleOptions): ModuleDefinition {
  const name = options.name.trim();
  if (!name) throw new TypeError("O nome do módulo não pode ser vazio.");
  return Object.freeze({
    [moduleBrand]: true as const,
    name,
    imports: Object.freeze([...(options.imports ?? [])]),
    controllers: Object.freeze([...(options.controllers ?? [])]),
    providers: Object.freeze([...(options.providers ?? [])]),
    queries: Object.freeze([...(options.queries ?? [])]),
    plugins: Object.freeze([...(options.plugins ?? [])]),
    exports: Object.freeze([...(options.exports ?? [])]),
  }) as ModuleDefinition;
}

export function isModuleDefinition(value: unknown): value is ModuleDefinition {
  return typeof value === "object" && value !== null && moduleBrand in value;
}
