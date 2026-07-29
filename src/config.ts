import type { EmpilhaRuntimeConfig, PostgresOptions } from "./empilha";

export type DatabaseConfig = PostgresOptions & {
  url: string;
};

export type EmpilhaConfig = EmpilhaRuntimeConfig & {
  database?: DatabaseConfig;
};

/** Mantém a configuração tipada e pronta para autocomplete no projeto. */
export function defineConfig<T extends EmpilhaConfig>(config: T): T {
  return config;
}
