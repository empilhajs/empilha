import { describe, expect, test } from "bun:test";
import * as publicApi from "../../src";
import { t, type Constructor, type Infer } from "../../src";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;

type Expect<Value extends true> = Value;

const User = t.Object({
  name: t.String(),
});

type UserBody = Infer<typeof User>;
type UserWithParams = Infer<typeof User, [id: string]>;

type _InfersSchema = Expect<Equal<UserBody, { name: string }>>;
type _InfersParams = Expect<
  Equal<UserWithParams, { name: string } & { params: [id: string] }>
>;

class UsersController {
  readonly marker = "users";
}

const typedController: Constructor<UsersController> = UsersController;

describe("type inference", () => {
  test("mantém as formas inferidas disponíveis em runtime", () => {
    expect(typedController).toBe(UsersController);
    expect(new UsersController().marker).toBe("users");
    expect("Empilha" in publicApi).toBe(false);
    expect("linkApplicationGraph" in publicApi).toBe(false);
  });
});
