import {
  HttpError,
  ValidationError,
  type ValidationIssue,
} from "../errors/index";
import type { ServerResponse } from "../http/http-adapter";
import { getCatchHandler } from "../metadata";
import type { MetadataRegistry } from "../metadata";
import type { ControllerInstance } from "../compiler/types";
import { serializeJson } from "../utils/serialize-json";

type CatchHandler = (error: unknown) => unknown | Promise<unknown>;

type ErrorHandler = (
  error: unknown,
  instance?: ControllerInstance,
) => Promise<ServerResponse>;

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isValidationIssue(value: unknown): value is ValidationIssue {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.message === "string"
  );
}

/** Cria uma resposta HTTP JSON com status e mensagem de erro. */
export function createErrorResponse(
  status: number,
  message: string,
): ServerResponse {
  return {
    status,
    body: serializeJson(
      {
        error: message,
      },
      true,
    ),
  };
}

function normalizeServerResponse(value: unknown): ServerResponse | null {
  if (
    !isRecord(value) ||
    typeof value.status !== "number" ||
    !Number.isInteger(value.status) ||
    !("body" in value)
  ) {
    return null;
  }

  const response: ServerResponse = {
    status: value.status,
    body:
      typeof value.body === "string"
        ? value.body
        : serializeJson(value.body, true),
  };

  if ("jsonValue" in value) {
    response.jsonValue = value.jsonValue;
  }

  if ("headers" in value && isStringRecord(value.headers)) {
    response.headers = value.headers;
  }

  return response;
}

function defaultErrorResponse(error: unknown): ServerResponse {
  if (error instanceof ValidationError) {
    return {
      status: 400,
      body: serializeJson(
        {
          errors: error.errors,
        },
        true,
      ),
    };
  }

  if (Array.isArray(error)) {
    const errors = error.filter(isValidationIssue);

    return {
      status: 400,
      body: serializeJson({ errors }, true),
    };
  }

  if (error instanceof HttpError) {
    return createErrorResponse(error.status, error.message);
  }

  if (isRecord(error)) {
    const status = error.status;

    if (
      typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 400 &&
      status <= 599
    ) {
      return createErrorResponse(
        status,
        typeof error.message === "string"
          ? error.message
          : "Internal server error",
      );
    }
  }

  return createErrorResponse(500, "Internal server error");
}

/** Registra catchers e converte falhas do framework em respostas HTTP. */
export class ErrorPipeline {
  private readonly globalCatchers = new Map<Function, CatchHandler>();

  /**
   * Registra um catcher global para uma classe de erro.
   *
   * @param errorType - Classe usada no teste `instanceof`.
   * @param handler - Função que transforma o erro em uma resposta ou valor.
   * @throws {TypeError} Quando `errorType` não é uma classe ou função.
   */
  catch(errorType: Function, handler: CatchHandler): void {
    if (typeof errorType !== "function") {
      throw new TypeError("O tipo do erro deve ser uma classe ou função.");
    }

    if (!this.globalCatchers.has(errorType)) {
      this.globalCatchers.set(errorType, handler);
    }
  }

  /**
   * Cria o handler de erro de um controller.
   *
   * @param controllerPrototype - Protótipo que contém os catchers decorados.
   * @param invoke - Função usada para chamar o catcher do controller.
   * @returns Handler que resolve catchers locais, globais e respostas padrão.
   */
  createHandler(
    controllerPrototype: object,
    invoke: (
      instance: ControllerInstance,
      propertyKey: string | symbol,
      error: unknown,
    ) => unknown,
    lookupCatchHandler: MetadataRegistry["getCatchHandler"] = getCatchHandler,
  ): ErrorHandler {
    return async (error, instance) => {
      const handlerName = lookupCatchHandler(controllerPrototype, error);

      if (!handlerName) {
        return this.handleGlobal(error);
      }

      if (!instance) {
        return this.handleGlobal(error);
      }

      try {
        const result = await invoke(instance, handlerName, error);

        return (
          normalizeServerResponse(result) ?? {
            status: 500,
            body: serializeJson(result, true),
          }
        );
      } catch (handlerError) {
        return defaultErrorResponse(handlerError);
      }
    };
  }

  private async handleGlobal(error: unknown): Promise<ServerResponse> {
    let constructor: Function | null =
      typeof error === "object" && error !== null ? error.constructor : null;
    let handler: CatchHandler | undefined;

    while (constructor) {
      handler = this.globalCatchers.get(constructor);
      if (handler) break;
      const prototype = Object.getPrototypeOf(constructor.prototype);
      constructor = prototype?.constructor ?? null;
    }

    if (!handler) {
      return defaultErrorResponse(error);
    }

    try {
      const result = await handler(error);

      return (
        normalizeServerResponse(result) ?? {
          status: 500,
          body: serializeJson(result, true),
        }
      );
    } catch (handlerError) {
      return defaultErrorResponse(handlerError);
    }
  }
}
