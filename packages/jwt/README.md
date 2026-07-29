# @empilha/jwt

Integra JWT ao Empilha usando `jose`, sem acoplar o framework principal ao
provedor de tokens.

```ts
import { Empilha } from "empilha"
import { jwt } from "@empilha/jwt"

const app = new Empilha().use(
  jwt({
    name: "access",
    secret: process.env.JWT_SECRET!,
  }).auth(),
)
```
