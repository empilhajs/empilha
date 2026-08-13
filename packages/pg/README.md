# @empilha/pg

Integra PostgreSQL (`pg`) ao Empilha sem acoplar o framework principal ao
driver.

```ts
import { createApplication, defineModule } from "empilha";
import { postgres } from "@empilha/pg";

const app = await createApplication(
  defineModule({
    name: "app",
    controllers: [UserController],
    plugins: [
      postgres({
        url: process.env.DATABASE_URL!,
        sql: "./src/queries",
        timeout: 5_000,
      }),
    ],
  }),
);
```

`timeout` configura `query_timeout` e `statement_timeout` no `pg`, além do
`timeout` das operações do Empilha. O plugin executa as queries por um client
dedicado para que o `AbortSignal` também possa cancelar uma query em andamento
no PostgreSQL.

Runners e pools sem `queryWithOptions` executam com timeout apenas de parede: a
requisição recebe `504` quando o limite é
atingido, enquanto a operação já entregue ao driver pode terminar depois. Use
`@empilha/pg` quando o cancelamento real da query for necessário.

Se a aplicação fornecer um runner próprio, o método `query()` deve observar o
`options.signal`. Um runner que ignora o sinal ainda pode continuar executando
até o próprio timeout do driver, mesmo depois de a requisição receber `504`.
Pools gerenciados passados diretamente a `app.postgres()` também são aceitos
sem `queryWithOptions`; nesse caso, o timeout do framework é apenas de parede.
Para cancelamento real, exponha `queryWithOptions` ou use `@empilha/pg`. Se o
driver já possui seu próprio limite, você pode desabilitar o timeout do
framework com `{ timeout: null }`.
