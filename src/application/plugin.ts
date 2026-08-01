import type { Empilha } from "../empilha";

const PLUGIN = Symbol("empilha.plugin");

export type PluginContext = Pick<
  Empilha,
  | "configure"
  | "configureHttp"
  | "useMiddleware"
  | "registerPluginService"
  | "registerQuery"
> & {
  readonly http: Empilha["http"];
};

export type EmpilhaPlugin = {
  readonly [PLUGIN]: true;
  install(context: PluginContext): void;
};

export function definePlugin(
  install: (context: PluginContext) => void,
): EmpilhaPlugin {
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
