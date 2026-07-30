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
      timeout: 5_000,
    }),
  )
  .initialize([UserController])
```

`timeout` configura `query_timeout` e `statement_timeout` no `pg`, além do
`timeout` das operações do Empilha. O adapter não envia um objeto de opções
como terceiro argumento para `pool.query()`: no `pg`, essa posição pode ser
interpretada como callback e causar `cb is not a function`.

O `AbortSignal` do Empilha limita a operação no framework. O encerramento da
query no PostgreSQL é garantido pelos timeouts do `pg`; para manter esse limite
em produção, configure um `timeout` finito ou defina explicitamente
`query_timeout` e `statement_timeout` nas opções do pool.
