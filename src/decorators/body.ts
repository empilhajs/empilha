import type { TSchema } from "@sinclair/typebox";
import { getOrCreateRoute } from "../metadata";
import { compileValidator } from "./validation";

/**
 * Valida o body da rota com um schema TypeBox e, quando aplicado a um
 * parâmetro, injeta o body validado nesse parâmetro.
 *
 * Também pode ser usado no método quando o body só será consumido por
 * bindings SQL ou por RequestContext.
 *
 * @param schema - Schema TypeBox esperado no body JSON.
 * @returns Um decorator de método ou de parâmetro.
 *
 * @example
 * create(@Body(CreateUserSchema) body: CreateUser) {
 *   return body
 * }
 */
export function Body(schema: TSchema): MethodDecorator & ParameterDecorator {
  const validator = compileValidator(schema);

  return ((
    target: object,
    propertyKey: string | symbol,
    descriptorOrIndex: PropertyDescriptor | number | undefined,
  ) => {
    if (propertyKey === undefined) {
      throw new Error("O decorador de body não pode ser usado no construtor.");
    }

    const route = getOrCreateRoute(target, propertyKey);
    route.bodySchema = schema;
    route.bodyValidator = validator;

    if (typeof descriptorOrIndex === "number") {
      if (
        route.parameters.some(
          (parameter) => parameter.index === descriptorOrIndex,
        )
      ) {
        throw new Error(
          "O parâmetro de índice " +
            descriptorOrIndex +
            " já possui um decorador.",
        );
      }
      route.parameters.push({ index: descriptorOrIndex, source: "body" });
    }
  }) as MethodDecorator & ParameterDecorator;
}
