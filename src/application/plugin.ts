import type { Empilha } from "../empilha";

const PLUGIN = Symbol("empilha.plugin");

export type PluginContext = Omit<
  Pick<
    Empilha,
    | "configure"
    | "configureHttp"
    | "useMiddleware"
    | "registerPluginService"
    | "registerQuery"
    | "auth"
    | "postgres"
  >,
  "registerPluginService"
> & {
  registerPluginService: RegisterPluginService;
  readonly http: Empilha["http"];
};

/**
 * Declara um serviço de plugin preservando seu tipo no ponto de registro.
 * O nome continua sendo uma chave de runtime para compatibilidade com os
 * decorators e plugins existentes.
 */
export type RegisterPluginService = <TService>(
  name: string,
  service: TService,
) => void;

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
