# @empilha/pg

Integra PostgreSQL (`pg`) ao Empilha sem acoplar o framework principal ao
driver.

```ts
import { Empilha } from "empilha"
import { postgres } from "@empilha/pg"

const app = new Empilha()
  .use(
    postgres({
      url: process.env.DATABASE_URL!,
      sql: "./src/queries",
    }),
  )
  .register([UserController])
```
