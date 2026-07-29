import type { RequestContext } from "../types";
import type { ServerResponse } from "./http-response-writer";

export type ServerRequest = RequestContext;

export type ServerHandlerResult = string | Response | ServerResponse;

export type HandlerOptions = {
  needsRequest?: boolean;
  needsQuery?: boolean;
  needsHeaders?: boolean;
  needsBody?: boolean;
  requiresRequestContext?: boolean;
  responseType?: "text" | "json";
  queryStart?: number;
};

export type ServerHandler = (
  req: ServerRequest,
) => ServerHandlerResult | Promise<ServerHandlerResult>;

export type ErrorHandler = (
  error: unknown,
  instance?: Record<PropertyKey, unknown>,
) => Promise<ServerResponse>;

export type MiddlewareFn = (
  req: ServerRequest,
  next: () => Promise<ServerResponse>,
) => Promise<ServerResponse>;

export type ConfiguredHandler = ServerHandler & HandlerOptions;
