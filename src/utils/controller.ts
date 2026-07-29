import type { ControllerInstance } from "../compiler/types";

function getControllerMethod(
  instance: ControllerInstance,
  propertyKey: string | symbol,
): (...args: unknown[]) => unknown {
  const method = instance[propertyKey];

  if (typeof method !== "function") {
    throw new Error(
      `O membro ${String(propertyKey)} não é um método do controller.`,
    );
  }

  return method as (...args: unknown[]) => unknown;
}

export function invokeController(
  instance: ControllerInstance,
  propertyKey: string | symbol,
  args: unknown[],
): unknown {
  const method = getControllerMethod(instance, propertyKey);

  return args.length === 0
    ? method.call(instance)
    : method.apply(instance, args);
}
