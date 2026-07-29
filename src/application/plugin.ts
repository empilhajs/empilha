import type { Empilha } from "../empilha";

const PLUGIN = Symbol("empilha.plugin");

export type EmpilhaPlugin = {
  readonly [PLUGIN]: true;
  install(app: Empilha): void;
};

export function definePlugin(install: (app: Empilha) => void): EmpilhaPlugin {
  return { [PLUGIN]: true, install };
}

export function isEmpilhaPlugin(value: unknown): value is EmpilhaPlugin {
  return (
    typeof value === "object" &&
    value !== null &&
    PLUGIN in value &&
    (value as EmpilhaPlugin)[PLUGIN] === true
  );
}
