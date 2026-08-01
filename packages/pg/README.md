# @empilha/pg

Integra PostgreSQL (`pg`) ao Empilha sem acoplar o framework principal ao
driver.

```ts
import { Empilha } from "empilha"
import { postgres } from "@empilha/pg"

const app = new Empilha()
  .usePlugin(
    postgres({
      url: process.env.DATABASE_URL!,
      sql: "./src/queries",
      timeout: 5_000,
    }),
  )
  .initialize([UserController])
```

`timeout` configura `query_timeout` e `statement_timeout` no `pg`, além do
`timeout` das operações do Empilha. O plugin executa as queries por um client
dedicado para que o `AbortSignal` também possa cancelar uma query em andamento
no PostgreSQL.

Se a aplicação fornecer um runner próprio, o método `query()` deve observar o
`options.signal`. Um runner que ignora o sinal ainda pode continuar executando
até o próprio timeout do driver, mesmo depois de a requisição receber `504`.
