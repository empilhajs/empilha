import type { Static, TSchema } from "@sinclair/typebox";
import type { MiddlewareFn } from "./http/http-adapter";

export type HttpMethod =
  | "GET"
  | "HEAD"
  | "OPTIONS"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE";

export type ParameterSource =
  | "body"
  | "plugin"
  | "param"
  | "query"
  | "header"
  | "request"
  | "context"
  | "auth";

export type TransactionMode = "read" | "write";
export type SqlResultMode = "many" | "one" | "none";
export type SqlOnEmpty = "notFound";
export type SqlBinding = string;

export type ParameterValidator = (value: unknown) => void;

export type ParameterMetadata = {
  index: number;
  source: ParameterSource;
  name?: string;
  type?: Function;
  schema?: TSchema;
};

export type RouteMetadata = {
  propertyKey: string | symbol;
  method?: HttpMethod;
  path?: string;
  queryName?: string;
  parameters: ParameterMetadata[];
  validators?: Map<number, ParameterValidator>;
  bodySchema?: TSchema;
  bodyValidator?: ParameterValidator;
  status?: number;
  transaction?: TransactionMode;
  background?: boolean;
  auth?:
    | string
    | readonly string[]
    | ((token: string) => boolean | Promise<boolean>);
  sqlParams?: SqlBinding[];
  sqlResult?: SqlResultMode;
  sqlOnEmpty?: SqlOnEmpty;
  beforeSql?: string | symbol;
  afterCommit?: string | symbol;
  querySchema?: TSchema;
  queryValidator?: ParameterValidator;
  queryDefaults?: Record<string, unknown>;
  responseSchema?: TSchema;
  contentType?: string;
  middlewares?: MiddlewareFn[];
  requiresAuth?: boolean;
};

export type RegisteredRouteMetadata = Omit<RouteMetadata, "method" | "path"> & {
  method: HttpMethod;
  path: string;
};

export type RouteRequest = {
  headers: Record<string, string>;
  params: Record<string, unknown>;
  query: Record<string, unknown>;
  body: unknown;
  result?: unknown;
};

export type SqlOptions = {
  params?: SqlBinding[];
};

export type ControllerOptions = {
  tags?: readonly string[];
  middlewares?: readonly MiddlewareFn[];
  auth?: true | string | readonly string[];
};

export type RequestContext<TBody = unknown> = {
  method: string;
  pathname: string;
  /** Sinal de cancelamento do request, incluindo timeout e desconexão. */
  signal?: AbortSignal;
  headers: Record<string, string>;
  /** Valores originais do path, sempre como texto. */
  rawParams: Readonly<Record<string, string>>;
  /** Valores originais da query, antes de defaults, conversão e validação. */
  rawQuery: Readonly<Record<string, string | readonly string[]>>;
  /** Valores de path disponíveis ao pipeline da rota. */
  params: Readonly<Record<string, string>>;
  /** Valores de query disponíveis ao pipeline, possivelmente normalizados. */
  query: Readonly<Record<string, unknown>>;
  body: TBody;
  result?: unknown;
};

/**
 * Infere o valor de um schema TypeBox.
 *
 * O parâmetro de rota é opcional para que `Infer<typeof Schema>` represente
 * apenas o payload do schema. A forma com `P` continua disponível para APIs
 * que precisam carregar parâmetros junto do valor inferido.
 */
export type Infer<
  T extends TSchema,
  P extends unknown[] | undefined = undefined,
> = Static<T> & ([P] extends [undefined] ? unknown : { params: P });
