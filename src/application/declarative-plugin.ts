import type { ApplicationProvider } from "../di";
import type { AuthTokenHandler } from "../runtime";
import type { PostgresQueryRunner } from "../sql";

export type DeclarativePostgresOptions = {
  readonly sql?: string;
  readonly timeout?: number | null;
  readonly healthCheck?: string | false;
  readonly close?: boolean;
};

export type PluginPostgresIntegration = Readonly<{
  readonly runner: PostgresQueryRunner;
  readonly options?: DeclarativePostgresOptions;
}>;

const DECLARATIVE_PLUGIN = Symbol("empilha.declarative-plugin");

export type PluginCapability = string;
export type PluginCapabilityContract = Readonly<{
  readonly name: string;
  readonly version?: string;
}>;
export type PluginCapabilityDeclaration =
  | PluginCapability
  | PluginCapabilityContract;
export type PluginCapabilityRequirement = PluginCapabilityDeclaration;

export type PluginHealthCheck = Readonly<{
  readonly name: string;
  readonly check: (signal?: AbortSignal) => boolean | Promise<boolean>;
}>;

export type DeclarativePluginContext = {
  provider(provider: ApplicationProvider): void;
  onClose(hook: () => void | Promise<void>): void;
  healthCheck(
    name: string,
    check: (signal?: AbortSignal) => boolean | Promise<boolean>,
  ): void;
  provideCapability(capability: PluginCapability, value?: unknown): void;
  postgres(
    runner: PostgresQueryRunner,
    options?: DeclarativePostgresOptions,
  ): void;
  auth(handler: AuthTokenHandler): void;
};

export type DeclarativePluginDescriptor<TConfig = unknown> = {
  readonly name: string;
  readonly version: string;
  readonly config?: (value: unknown) => TConfig;
  readonly provides?: readonly PluginCapabilityDeclaration[];
  readonly requires?: readonly PluginCapabilityRequirement[];
  readonly optional?: readonly PluginCapabilityRequirement[];
  readonly register: (
    context: DeclarativePluginContext,
    config: TConfig,
  ) => void | Promise<void>;
  readonly ready?: (context: DeclarativePluginContext) => void | Promise<void>;
};

export type DeclarativePlugin<TConfig = unknown> = Readonly<{
  readonly [DECLARATIVE_PLUGIN]: true;
  readonly descriptor: DeclarativePluginDescriptor<TConfig>;
}>;

export function defineDeclarativePlugin<TConfig = undefined>(
  descriptor: DeclarativePluginDescriptor<TConfig>,
): DeclarativePlugin<TConfig> {
  const name = descriptor.name.trim();
  const version = descriptor.version.trim();
  if (!name) throw new TypeError("O nome do plugin não pode ser vazio.");
  if (!version)
    throw new TypeError(`O plugin "${name}" precisa de uma versão.`);
  if (typeof descriptor.register !== "function")
    throw new TypeError(`O plugin "${name}" precisa de register().`);
  return Object.freeze({
    [DECLARATIVE_PLUGIN]: true as const,
    descriptor: Object.freeze({
      ...descriptor,
      name,
      version,
      provides: Object.freeze([...(descriptor.provides ?? [])]),
      requires: Object.freeze([...(descriptor.requires ?? [])]),
      optional: Object.freeze([...(descriptor.optional ?? [])]),
    }),
  }) as DeclarativePlugin<TConfig>;
}

export function isDeclarativePlugin(
  value: unknown,
): value is DeclarativePlugin<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    DECLARATIVE_PLUGIN in value &&
    (value as DeclarativePlugin<unknown>)[DECLARATIVE_PLUGIN] === true
  );
}

export type PluginDiagnostic = {
  readonly code: string;
  readonly plugin: string;
  readonly message: string;
  readonly hint?: string;
};

export type RegisteredPlugin = Readonly<{
  readonly name: string;
  readonly version: string;
  readonly capabilities: ReadonlyMap<PluginCapability, unknown>;
  readonly providers: readonly ApplicationProvider[];
  readonly healthChecks: readonly PluginHealthCheck[];
  readonly postgres?: PluginPostgresIntegration;
  readonly auth?: AuthTokenHandler;
}>;

type NormalizedCapability = Readonly<{
  readonly name: string;
  readonly version?: string;
}>;

function normalizeCapability(
  capability: PluginCapabilityDeclaration,
): NormalizedCapability {
  if (typeof capability === "string") return { name: capability };
  return {
    name: capability.name.trim(),
    ...(capability.version?.trim()
      ? { version: capability.version.trim() }
      : {}),
  };
}

function versionMatches(
  provided: string | undefined,
  required: string | undefined,
): boolean {
  if (!required) return true;
  if (!provided) return false;
  if (required.startsWith("^")) {
    const major = required.slice(1).split(".")[0];
    return provided.split(".")[0] === major;
  }
  if (required.startsWith("~")) {
    const [major, minor] = required.slice(1).split(".");
    const [providedMajor, providedMinor] = provided.split(".");
    return providedMajor === major && providedMinor === minor;
  }
  return provided === required;
}

function capabilityMatches(
  provided: PluginCapabilityDeclaration,
  required: PluginCapabilityRequirement,
): boolean {
  const providedCapability = normalizeCapability(provided);
  const requiredCapability = normalizeCapability(required);
  return (
    providedCapability.name === requiredCapability.name &&
    versionMatches(providedCapability.version, requiredCapability.version)
  );
}

function capabilityLabel(capability: PluginCapabilityRequirement): string {
  const normalized = normalizeCapability(capability);
  return normalized.version
    ? `${normalized.name}@${normalized.version}`
    : normalized.name;
}

/** Analisa descritores de plugins sem executar register(), ready() ou hooks. */
export function diagnoseDeclarativePlugins(
  plugins: readonly unknown[],
): readonly PluginDiagnostic[] {
  const diagnostics: PluginDiagnostic[] = [];
  const byName = new Map<string, DeclarativePlugin<unknown>>();
  for (const candidate of plugins) {
    if (!isDeclarativePlugin(candidate)) {
      diagnostics.push({
        code: "E_PLUGIN_INVALID",
        plugin: "unknown",
        message: "Foi encontrado um valor que não é um plugin declarativo.",
      });
      continue;
    }
    const existing = byName.get(candidate.descriptor.name);
    if (existing && existing !== candidate) {
      diagnostics.push({
        code: "E_PLUGIN_DUPLICATE",
        plugin: candidate.descriptor.name,
        message: `O plugin "${candidate.descriptor.name}" foi instalado mais de uma vez.`,
        hint: "Reutilize a mesma instância do plugin ou remova a duplicata.",
      });
    } else byName.set(candidate.descriptor.name, candidate);
  }

  const compatibleDependency = (
    requirement: PluginCapabilityRequirement,
  ): DeclarativePlugin<unknown> | undefined =>
    [...byName.values()].find((candidate) =>
      candidate.descriptor.provides?.some((provided) =>
        capabilityMatches(provided, requirement),
      ),
    );
  for (const plugin of byName.values()) {
    for (const required of plugin.descriptor.requires ?? []) {
      const requiredName = normalizeCapability(required).name;
      const candidates = [...byName.values()].filter((candidate) =>
        candidate.descriptor.provides?.some(
          (provided) => normalizeCapability(provided).name === requiredName,
        ),
      );
      if (candidates.length === 0) {
        diagnostics.push({
          code: "E_PLUGIN_CAPABILITY_MISSING",
          plugin: plugin.descriptor.name,
          message: `O plugin "${plugin.descriptor.name}" exige a capability "${capabilityLabel(required)}".`,
          hint: `Nenhum plugin instalado fornece "${capabilityLabel(required)}". Instale um plugin compatível ou remova o requisito.`,
        });
      } else if (!compatibleDependency(required)) {
        diagnostics.push({
          code: "E_PLUGIN_CAPABILITY_INCOMPATIBLE",
          plugin: plugin.descriptor.name,
          message: `O plugin "${plugin.descriptor.name}" exige a capability "${capabilityLabel(required)}", mas o contrato encontrado é incompatível.`,
          hint: "Atualize o plugin fornecedor ou ajuste o requisito de capability.",
        });
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (plugin: DeclarativePlugin<unknown>): void => {
    const name = plugin.descriptor.name;
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      diagnostics.push({
        code: "E_PLUGIN_CYCLE",
        plugin: name,
        message: `Dependência circular de plugins envolvendo "${name}".`,
      });
      return;
    }
    visiting.add(name);
    for (const requirement of plugin.descriptor.requires ?? []) {
      const dependency = compatibleDependency(requirement);
      if (dependency) visit(dependency);
    }
    visiting.delete(name);
    visited.add(name);
  };
  for (const plugin of byName.values()) visit(plugin);
  return Object.freeze(diagnostics);
}

export type PluginRegistryResult = Readonly<{
  readonly plugins: readonly RegisteredPlugin[];
  readonly diagnostics: readonly PluginDiagnostic[];
  readonly close: () => Promise<void>;
}>;

type MutablePlugin = {
  descriptor: DeclarativePluginDescriptor;
  capabilities: Map<PluginCapability, unknown>;
  providers: ApplicationProvider[];
  healthChecks: PluginHealthCheck[];
  postgres?: PluginPostgresIntegration;
  auth?: AuthTokenHandler;
  closeHooks: (() => void | Promise<void>)[];
};

async function closeMutablePlugins(
  active: readonly MutablePlugin[],
): Promise<void> {
  const errors: unknown[] = [];
  for (let index = active.length - 1; index >= 0; index--) {
    const hooks = active[index]?.closeHooks ?? [];
    for (let hookIndex = hooks.length - 1; hookIndex >= 0; hookIndex--) {
      try {
        await hooks[hookIndex]?.();
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length > 0)
    throw new AggregateError(errors, "Falha ao desfazer ativação de plugins.");
}

/** Descobre, valida e ativa plugins declarativos em ordem determinística. */
export class DeclarativePluginRegistry {
  async activate(
    plugins: readonly unknown[],
    configs: ReadonlyMap<string, unknown> = new Map(),
  ): Promise<PluginRegistryResult> {
    const diagnostics: PluginDiagnostic[] = [];
    const byName = new Map<string, DeclarativePlugin<unknown>>();
    for (const candidate of plugins) {
      if (!isDeclarativePlugin(candidate)) {
        diagnostics.push({
          code: "E_PLUGIN_INVALID",
          plugin: "unknown",
          message: "Foi encontrado um valor que não é um plugin declarativo.",
        });
        continue;
      }
      const plugin = candidate;
      const { name } = plugin.descriptor;
      const existing = byName.get(name);
      if (existing && existing !== plugin) {
        diagnostics.push({
          code: "E_PLUGIN_DUPLICATE",
          plugin: name,
          message: `O plugin "${name}" foi instalado mais de uma vez.`,
          hint: "Reutilize a mesma instância do plugin ou remova a duplicata.",
        });
      } else byName.set(name, plugin);
    }

    const ordered: DeclarativePlugin<unknown>[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const capabilityCandidates = (
      requirement: PluginCapabilityRequirement,
    ): DeclarativePlugin<unknown>[] => {
      const required = normalizeCapability(requirement);
      return [...byName.values()].filter((candidate) =>
        candidate.descriptor.provides?.some(
          (provided) => normalizeCapability(provided).name === required.name,
        ),
      );
    };
    const visit = (plugin: DeclarativePlugin<unknown>): void => {
      const { name, requires = [] } = plugin.descriptor;
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        diagnostics.push({
          code: "E_PLUGIN_CYCLE",
          plugin: name,
          message: `Dependência circular de plugins envolvendo "${name}".`,
        });
        return;
      }
      visiting.add(name);
      for (const required of requires) {
        const candidates = capabilityCandidates(required);
        const dependency = candidates.find((candidate) =>
          candidate.descriptor.provides?.some((provided) =>
            capabilityMatches(provided, required),
          ),
        );
        if (!dependency) {
          if (candidates.length === 0) {
            diagnostics.push({
              code: "E_PLUGIN_CAPABILITY_MISSING",
              plugin: name,
              message: `O plugin "${name}" exige a capability "${capabilityLabel(required)}".`,
              hint: `Nenhum plugin instalado fornece "${capabilityLabel(required)}". Instale um plugin compatível ou remova o requisito.`,
            });
          } else {
            diagnostics.push({
              code: "E_PLUGIN_CAPABILITY_INCOMPATIBLE",
              plugin: name,
              message: `O plugin "${name}" exige a capability "${capabilityLabel(required)}", mas o contrato encontrado é incompatível.`,
              hint: `Encontrado em ${candidates
                .map((candidate) => {
                  const provided = candidate.descriptor.provides?.find(
                    (entry) =>
                      normalizeCapability(entry).name ===
                      normalizeCapability(required).name,
                  );
                  return `${candidate.descriptor.name} (${capabilityLabel(provided ?? required)})`;
                })
                .join(
                  ", ",
                )}. Atualize o plugin fornecedor ou ajuste o requisito.`,
            });
          }
        } else visit(dependency);
      }
      visiting.delete(name);
      visited.add(name);
      ordered.push(plugin);
    };
    for (const plugin of byName.values()) visit(plugin);

    const active: MutablePlugin[] = [];
    const available = new Map<
      PluginCapability,
      {
        readonly value: unknown;
        readonly plugin: string;
        readonly version?: string;
      }
    >();
    try {
      for (const plugin of ordered) {
        const { descriptor } = plugin;
        const missing = (descriptor.requires ?? []).filter(
          (capability) => !available.has(normalizeCapability(capability).name),
        );
        const incompatible = (descriptor.requires ?? []).filter(
          (capability) => {
            const found = available.get(normalizeCapability(capability).name);
            return (
              found !== undefined &&
              !versionMatches(
                found.version,
                normalizeCapability(capability).version,
              )
            );
          },
        );
        for (const capability of missing)
          diagnostics.push({
            code: "E_PLUGIN_CAPABILITY_UNAVAILABLE",
            plugin: descriptor.name,
            message: `A capability "${capabilityLabel(capability)}" ainda não está disponível para "${descriptor.name}".`,
          });
        for (const capability of incompatible) {
          const found = available.get(normalizeCapability(capability).name);
          diagnostics.push({
            code: "E_PLUGIN_CAPABILITY_INCOMPATIBLE",
            plugin: descriptor.name,
            message: `O plugin "${descriptor.name}" exige a capability "${capabilityLabel(capability)}", mas encontrou a versão ${found?.version ?? "sem versão"} em "${found?.plugin ?? "desconhecido"}".`,
            hint: "Atualize o plugin fornecedor ou ajuste o requisito de capability.",
          });
        }
        if (missing.length > 0 || incompatible.length > 0) continue;

        const current: MutablePlugin = {
          descriptor,
          capabilities: new Map(),
          providers: [],
          healthChecks: [],
          closeHooks: [],
        };
        active.push(current);
        const context: DeclarativePluginContext = {
          provider: (provider) => current.providers.push(provider),
          onClose: (hook) => current.closeHooks.push(hook),
          healthCheck: (name, check) =>
            current.healthChecks.push(Object.freeze({ name, check })),
          postgres: (runner, options) => {
            current.postgres = Object.freeze({ runner, options });
          },
          auth: (handler) => {
            current.auth = handler;
          },
          provideCapability: (capability, value = true) => {
            current.capabilities.set(capability, value);
            available.set(capability, { value, plugin: descriptor.name });
          },
        };
        for (const capability of descriptor.provides ?? []) {
          const normalized = normalizeCapability(capability);
          current.capabilities.set(normalized.name, true);
          available.set(normalized.name, {
            value: true,
            plugin: descriptor.name,
            version: normalized.version,
          });
        }
        const config = descriptor.config
          ? descriptor.config(configs.get(descriptor.name))
          : undefined;
        await descriptor.register(context, config);
        await descriptor.ready?.(context);
      }
    } catch (error) {
      try {
        await closeMutablePlugins(active);
      } catch (rollbackError) {
        const failure = Object.assign(
          new AggregateError(
            [error, rollbackError],
            "Falha ao ativar plugins e desfazer a ativação parcial.",
          ),
          { cause: rollbackError },
        );
        throw failure;
      }
      throw error;
    }

    const healthChecks = new Map<string, string>();
    for (const plugin of active) {
      for (const healthCheck of plugin.healthChecks) {
        const existingPlugin = healthChecks.get(healthCheck.name);
        if (existingPlugin) {
          diagnostics.push({
            code: "E_PLUGIN_HEALTH_CHECK_DUPLICATE",
            plugin: plugin.descriptor.name,
            message: `O health check "${healthCheck.name}" foi registrado pelos plugins "${existingPlugin}" e "${plugin.descriptor.name}".`,
            hint: "Use nomes exclusivos para os health checks declarativos.",
          });
        } else healthChecks.set(healthCheck.name, plugin.descriptor.name);
      }
    }

    const registered = active.map((plugin) =>
      Object.freeze({
        name: plugin.descriptor.name,
        version: plugin.descriptor.version,
        capabilities: plugin.capabilities,
        providers: Object.freeze([...plugin.providers]),
        healthChecks: Object.freeze([...plugin.healthChecks]),
        postgres: plugin.postgres,
        auth: plugin.auth,
      }),
    );
    let closed = false;
    return Object.freeze({
      plugins: Object.freeze(registered),
      diagnostics: Object.freeze(diagnostics),
      close: async () => {
        if (closed) return;
        closed = true;
        await closeMutablePlugins(active);
      },
    });
  }
}
