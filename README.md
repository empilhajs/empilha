# 🧱 Empilha

Empilha HTTP para **Bun** e TypeScript, baseado em decorators, contratos
explícitos e SQL nomeado para criar APIs previsíveis.

O Empilha usa Web Standards (`Request`, `Response` e `AbortSignal`) e mantém
controllers, validação, SQL e respostas em uma API explícita com decorators.

## Instalação

```sh
bun add empilha
```

Empilha requer [Bun](https://bun.sh) e TypeScript com
`experimentalDecorators` habilitado.

## Comece em poucos minutos

```ts
import { Controller, Empilha, Get, Param } from "empilha";

@Controller("/hello")
class HelloController {
  @Get("/:name")
  greet(@Param("name") name: string) {
    return { message: `Olá, ${name}!` };
  }
}

const app = new Empilha().initialize([HelloController]);

await app.run({ port: 4000 });
```

```sh
curl http://localhost:4000/hello/Ada
# {"message":"Olá, Ada!"}
```

Para iniciar um projeto com PostgreSQL, OpenAPI, health check e scripts de
desenvolvimento:

```sh
bun create empilha app
cd app
bun install
bun run dev
```

## O que você encontra

- Controllers e rotas tipadas com decorators explícitos.
- Parâmetros de path, query, headers, body, request e contexto de requisição.
- Validação e serialização de respostas com TypeBox.
- Container de dependências com escopos `singleton`, `transient` e `request`.
- SQL nomeado para PostgreSQL, bindings, transações e tipos gerados.
- Middleware global, de controller ou de rota; autenticação e autorização.
- OpenAPI 3.1 e Swagger UI gerados das declarações de rota.
- Timeouts cooperativos, shutdown ordenado, health checks e tarefas em segundo plano.
- Logging estruturado com request ID, status e duração.
- Cliente de teste que exercita a aplicação sem abrir uma porta HTTP.

## Exemplo: endpoint validado e documentado

```ts
import { Body, Controller, Post, Returns, Status } from "empilha/decorators";
import { t, type Infer } from "empilha/schema";

const CreateUser = t.Object({
  name: t.String({ minLength: 1 }),
  email: t.String({ format: "email" }),
});
type CreateUser = Infer<typeof CreateUser>;

const User = t.Object({
  id: t.String(),
  name: t.String(),
  email: t.String(),
});

@Controller("/users")
class UsersController {
  @Post("/")
  @Status(201)
  @Returns(User)
  create(@Body(CreateUser) body: CreateUser) {
    return { id: crypto.randomUUID(), ...body };
  }
}
```

`@Body(schema)` valida e injeta o JSON recebido. Veja o exemplo completo na
[documentação de validação](https://empilhajs.github.io/empilha-docs/validation).

## Recursos

| Recurso                | Uso                                                        | Documentação                                                                    |
| ---------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Rotas e parâmetros     | `@Get`, `@Post`, `@Param`, `@Query`                        | [Criar uma rota](https://empilhajs.github.io/empilha-docs/routes)               |
| Respostas e schemas    | `@Status`, `@Produces`, `@Returns`                         | [Definir respostas](https://empilhajs.github.io/empilha-docs/responses)         |
| Injeção de dependência | `@Injectable`, `@Inject`, `app.provide()`                  | [Services e DI](https://empilhajs.github.io/empilha-docs/services)              |
| PostgreSQL             | `@Sql`, `@Transaction("read")`, `@Transaction("write")`    | [Usar SQL em uma rota](https://empilhajs.github.io/empilha-docs/sql)            |
| Middleware e segurança | `app.useMiddleware()`, `app.usePlugin()`, `@Use`, `@Roles` | [Middleware e autorização](https://empilhajs.github.io/empilha-docs/middleware) |
| Erros                  | `HttpError`, `@Catch`, `app.catch()`                       | [Tratamento de erros](https://empilhajs.github.io/empilha-docs/errors)          |
| Operação               | limites, CORS, health, shutdown                            | [Configurações comuns](https://empilhajs.github.io/empilha-docs/configuration)  |

## Documentação

### Começar uma API

- [Primeiros passos](https://empilhajs.github.io/empilha-docs) — instale, crie uma rota e teste sem servidor.
- [Controllers e rotas](https://empilhajs.github.io/empilha-docs/routes) — path, query, headers, body, schemas e status.
- [Organize o projeto](https://empilhajs.github.io/empilha-docs/project) — estrutura de uma API Empilha pronta para crescer.

### Construir recursos

- [SQL nomeado](https://empilhajs.github.io/empilha-docs/sql) — arquivos `.sql`, resultados e transações PostgreSQL.
- [Bindings SQL](https://empilhajs.github.io/empilha-docs/sql-bindings) — bindings de request, casts e validação dos parâmetros.
- [JWT e autenticação](https://empilhajs.github.io/empilha-docs/authentication) — Bearer token, `@Inject()`, `@Identity()` e roles.
- [Injeção de dependência](https://empilhajs.github.io/empilha-docs/services) — providers, mocks e escopos de requisição.
- [Middleware e background](https://empilhajs.github.io/empilha-docs/middleware) — políticas transversais, roles, health checks e jobs.
- [Tratamento de erros](https://empilhajs.github.io/empilha-docs/errors) — `HttpError`, `@Catch`, catcher global e falhas de validação.
- [Contexto de requisição](https://empilhajs.github.io/empilha-docs/scopes) — `AbortSignal`, `requestId`, tarefas e DI request-scoped.

### Operar e entender

- [Configuração](https://empilhajs.github.io/empilha-docs/configuration) — CORS, limites, OpenAPI, banco, shutdown e observabilidade.
- [OpenAPI](https://empilhajs.github.io/empilha-docs/openapi) — contrato da API gerado a partir das rotas.
- [Testes](https://empilhajs.github.io/empilha-docs/testing) — `app.test()`, requests brutas e mocks de dependência.
- [Ciclo de uma requisição](https://empilhajs.github.io/empilha-docs/execution-model) — ordem do bootstrap e das etapas HTTP.

## Desenvolvimento do framework

```sh
bun install
bun run check
```

`check` executa typecheck, formatação, lint, testes e build. Para trabalhar em
uma etapa específica, use:

```sh
bun run typecheck
bun test
bun run format
bun run build
```

O build gera JavaScript ESM e declarações TypeScript em `dist/`.
