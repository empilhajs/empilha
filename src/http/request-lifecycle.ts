import {
  abortRequestScope,
  createRequestScope,
  runWithRequestContext,
  type RequestScope,
} from "../context";
import { Container, type RequestIdGenerator } from "../di";
import { RequestTracker } from "./request-tracker";
import { addRequestId } from "./request-id";
import { isPromise } from "./adapter-helpers";

export type RequestLifecycleOptions = Readonly<{
  requests: RequestTracker;
  getConcurrency: () => number | null;
  getRequestScopeFactory: () => (() => Container) | undefined;
  getRequestIdEnabled: () => boolean;
  getRequestIdGenerator: () => RequestIdGenerator;
  errorResponse: (status: number, message: string) => Response;
}>;

/** Encapsula entrada, escopo, abort e drenagem de uma requisição HTTP. */
export class RequestLifecycle {
  constructor(private readonly options: RequestLifecycleOptions) {}

  runWithoutScope(
    request: Request,
    callback: (controller: AbortController) => Response | Promise<Response>,
  ): Response | Promise<Response> {
    const { options } = this;
    if (!options.requests.tryEnter(options.getConcurrency())) {
      return options.errorResponse(503, "Request concurrency limit reached");
    }

    const controller = new AbortController();
    const abortFromRequest = () => controller.abort(request.signal.reason);
    if (request.signal.aborted) abortFromRequest();
    else
      request.signal.addEventListener("abort", abortFromRequest, {
        once: true,
      });

    try {
      const response = callback(controller);
      if (isPromise(response)) {
        return response
          .then((value) => this.withRequestId(value))
          .finally(() => {
            request.signal.removeEventListener("abort", abortFromRequest);
            options.requests.leave();
          });
      }

      options.requests.leave();
      request.signal.removeEventListener("abort", abortFromRequest);
      return this.withRequestId(response);
    } catch (error) {
      request.signal.removeEventListener("abort", abortFromRequest);
      options.requests.leave();
      throw error;
    }
  }

  runScope(
    request: Request,
    callback: () => Response | Promise<Response>,
  ): Response | Promise<Response> {
    const { options } = this;
    if (!options.requests.tryEnter(options.getConcurrency())) {
      return options.errorResponse(503, "Request concurrency limit reached");
    }

    let scope: RequestScope;
    try {
      scope = createRequestScope(
        request,
        options.getRequestScopeFactory()?.() ?? new Container(),
        options.getRequestIdGenerator(),
      );
    } catch (error) {
      options.requests.leave();
      throw error;
    }

    options.requests.trackScope(scope);
    try {
      const response = runWithRequestContext(scope, callback);
      const withScopeRequestId = (value: Response): Response =>
        this.withRequestId(value, scope.requestId);

      if (isPromise(response)) {
        return response
          .then(withScopeRequestId)
          .finally(() => options.requests.cleanupScope(scope));
      }

      options.requests.cleanupScope(scope);
      return withScopeRequestId(response);
    } catch (error) {
      options.requests.cleanupScope(scope);
      throw error;
    }
  }

  withRequestId(response: Response, requestId?: string): Response {
    return this.options.getRequestIdEnabled()
      ? addRequestId(
          response,
          requestId ?? this.options.getRequestIdGenerator()(),
        )
      : response;
  }

  /** Aborta um scope quando uma operação protegida por timeout expira. */
  abort(scope: RequestScope, reason: unknown): void {
    abortRequestScope(scope, reason);
  }
}
