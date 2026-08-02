import { Type } from "@sinclair/typebox";
import { compileValidator } from "../../src/decorators";

export const validator = compileValidator(
  Type.Object({ name: Type.String({ minLength: 1 }) }),
);
