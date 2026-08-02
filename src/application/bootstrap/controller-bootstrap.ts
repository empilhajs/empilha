import { Container, type Constructor } from "../../di";
import { requestContext } from "../../context";
import type {
  ControllerInstance,
  ControllerResolver,
} from "../../compiler/types";

export class ControllerBootstrap {
  constructor(private readonly container: Container) {}

  provideController<T extends Constructor>(controller: T): void {
    if (!this.container.has(controller)) {
      this.container.provide(controller, {
        useClass: controller,
        scope: this.container.requiresRequestScope(controller)
          ? "request"
          : "singleton",
      });
    }
  }

  createResolver<T extends Constructor>(controller: T): ControllerResolver {
    if (this.container.scopeOf(controller) !== "singleton") {
      return () =>
        requestContext().container.resolve(controller) as ControllerInstance;
    }
    const instance = this.container.resolve(controller) as ControllerInstance;
    return () => instance;
  }

  requiresRequestContext(controller: Constructor): boolean {
    return this.container.scopeOf(controller) === "request";
  }

  assertConstructible(controller: Constructor): void {
    this.container.assertConstructible(controller);
  }
}
