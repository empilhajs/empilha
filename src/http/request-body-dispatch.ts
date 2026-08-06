import { tryRequestContext } from "../context";
import { JsonBodyReader, RequestBodyError } from "./request-body-reader";
import type { ConfiguredHandler, ServerRequest } from "./adapter-types";

export type RequestBodyDispatchOptions = Readonly<{
  bodyReader: JsonBodyReader;
  dispatch: (
    request: ServerRequest,
    handler: ConfiguredHandler,
    controller?: AbortController,
  ) => Response | Promise<Response>;
  dispatchError: (error: unknown) => Promise<Response>;
  errorResponse: (status: number, message: string) => Response;
}>;

/** Faz a leitura do body e devolve o controle ao pipeline HTTP principal. */
export function dispatchRequestBody(
  request: Request,
  serverRequest: ServerRequest,
  handler: ConfiguredHandler,
  controller: AbortController | undefined,
  options: RequestBodyDispatchOptions,
): Promise<Response> {
  return options.bodyReader
    .read(
      request,
      options.bodyReader.hasTimeout ? tryRequestContext() : undefined,
    )
    .then((body) => {
      serverRequest.body = body;
      return options.dispatch(serverRequest, handler, controller);
    })
    .catch((error) => {
      if (error instanceof RequestBodyError) {
        return options.errorResponse(error.status, error.message);
      }
      return options.dispatchError(error);
    });
}
