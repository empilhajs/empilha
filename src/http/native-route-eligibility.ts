import type { NativeRouteEligibility } from "./adapter-types";

export type NativeRouteGlobalConstraints = Readonly<{
  middleware: boolean;
  cors: boolean;
  handlerTimeout: boolean;
  requestConcurrency: boolean;
  bodyTimeout: boolean;
  bodySizeLimit: boolean;
}>;

/**
 * Calcula a elegibilidade efetiva das rotas nativas do Bun.
 *
 * A decisão local pertence ao registro da rota; estas restrições são globais
 * ao adapter e podem invalidar a promoção de todas as rotas de uma aplicação.
 */
export function resolveNativeRouteEligibility(
  entries: readonly NativeRouteEligibility[],
  constraints: NativeRouteGlobalConstraints,
): readonly NativeRouteEligibility[] {
  const reasons: string[] = [];
  if (constraints.middleware) reasons.push("middleware-global");
  if (constraints.cors) reasons.push("cors");
  if (constraints.handlerTimeout) reasons.push("handler-timeout");
  if (constraints.requestConcurrency) reasons.push("request-concurrency");
  if (constraints.bodyTimeout) reasons.push("body-timeout");
  if (constraints.bodySizeLimit) reasons.push("body-size-limit");

  return Object.freeze(
    entries.map((entry) =>
      Object.freeze({
        ...entry,
        eligible: entry.eligible && reasons.length === 0,
        reasons: Object.freeze([
          ...entry.reasons,
          ...(entry.eligible ? reasons : []),
        ]),
      }),
    ),
  );
}
