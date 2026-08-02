# 🧱 Empilha

> APIs previsíveis para Bun e TypeScript — com módulos explícitos, contratos verificáveis e SQL nomeado.

O Empilha é um framework HTTP que transforma a composição da aplicação em um contrato claro. Módulos, providers, plugins, controllers e queries formam um grafo que pode ser compilado, diagnosticado, testado e executado pelo mesmo caminho.

```text
defineModule() → compile → diagnose → app.fetch() / app.run()
```

## Por que Empilha?

- **Bun-first**, usando `Request`, `Response` e `AbortSignal` como contratos públicos.
- **Módulos de verdade**, com imports, exports, providers privados e tokens tipados.
- **Falha cedo**, agregando problemas de DI, rotas, plugins e SQL antes do primeiro request.
- **Produção e testes no mesmo grafo**, sem reconstruir controllers ou abrir uma porta HTTP.
- **SQL como contrato**, com bindings, cardinalidade, tipos gerados e verificação de artefatos.
- **Operação incluída**, com health checks, lifecycle, shutdown, observabilidade e `doctor`.

## Instalação

Requer [Bun](https://bun.sh) 1.3 ou superior.

```sh
bun add empilha
```

Para começar com um projeto completo:

```sh
bun create empilha minha-api
cd minha-api
bun install
bun run dev
```

## Uma rota em poucos linhas

```ts
import {
  Controller,
  Get,
  Param,
  createApplication,
  defineModule,
} from "empilha";

@Controller("/hello")
class HelloController {
  @Get("/:name")
  greet(@Param("name") name: string) {
    return { message: `Olá, ${name}!` };
  }
}

const AppModule = defineModule({
  name: "app",
  controllers: [HelloController],
});

const app = await createApplication(AppModule);
await app.run({ port: 4000 });
```

O mesmo objeto pode ser usado sem servidor:

```ts
const response = await app.fetch(new Request("http://localhost/hello/Ada"));

console.log(response.status); // 200
console.log(await response.json()); // { message: "Olá, Ada!" }
```

## Contratos no centro

```ts
import { Body, Controller, Post, t, type Infer } from "empilha";

const CreateUser = t.Object({
  name: t.String({ minLength: 1 }),
  email: t.String({ format: "email" }),
});
type CreateUser = Infer<typeof CreateUser>;

@Controller("/users")
class UsersController {
  @Post("/")
  create(@Body(CreateUser) body: CreateUser) {
    return { id: crypto.randomUUID(), ...body };
  }
}
```

Schemas validam a entrada e alimentam a documentação OpenAPI.

## SQL nomeado

Queries ficam em arquivos `.sql`, com nome, cardinalidade e origem preservados no artefato gerado:

```sql
-- src/queries/tasks.sql
-- @query listTasks many
SELECT id, title
FROM tasks
WHERE owner_id = :auth.userId
ORDER BY created_at DESC;
```

O controller usa o artefato tipado, e o Empilha verifica bindings, visibilidade, hash do SQL e compatibilidade com a resposta antes de servir:

```ts
import { Controller, Get, Result, Sql } from "empilha";
import { queryArtifacts } from "./queries/query-artifacts";

@Controller("/tasks")
class TasksController {
  @Get("/")
  @Sql(queryArtifacts.listTasks)
  @Result("many")
  list() {}
}
```

Gere os artefatos e valide o projeto com:

```sh
bun scripts/application/generate-query-types.ts src/queries src/queries/query-artifacts.ts --artifacts
bun scripts/application/doctor.ts --strict
```

## Integrações oficiais

As integrações são opcionais e seguem o mesmo modelo declarativo:

```sh
bun add @empilha/pg pg
bun add @empilha/jwt jose
```

- [`@empilha/pg`](./packages/pg) — PostgreSQL, queries nomeadas, transações e health check.
- [`@empilha/jwt`](./packages/jwt) — autenticação JWT, identidade tipada e roles.

## Testes sem porta HTTP

```ts
import { createTestApplication } from "empilha";

const app = await createTestApplication(AppModule).compile();
const response = await app.fetch(new Request("http://test/hello/Ada"));

await app.close();
```

A testing application compila o módulo de produção e permite substituir providers, plugins e integrações antes da execução.

## Desenvolvimento do framework

```sh
bun install
bun run check
```

Comandos úteis:

```sh
bun run typecheck       # tipos
bun test                # testes
bun run lint            # lint
bun run format:check    # formatação
bun run build           # build e declarações
bun run release:check   # validação da release
```

## Licença

[MIT](./LICENSE)
