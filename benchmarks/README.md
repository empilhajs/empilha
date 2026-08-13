# Benchmarks

Benchmarks de runtime, build e bundle do Empilha. Execute-os a partir da raiz
do repositório, sempre registrando a versão do Bun, sistema operacional e
arquitetura ao comparar resultados.

## Estrutura

```text
benchmarks/
├── runtime/    # bootstrap, rotas, requests, plugins e validators
├── build/      # bundle, subpaths e performance de tipos
├── fixtures/   # aplicações usadas pelo smoke test de bundle
└── budgets.json
```

## Baseline

Mede compilação, primeira resposta, heap e RSS para diferentes tamanhos de
aplicação:

```sh
bun --expose-gc benchmarks/runtime/baseline.ts
bun --expose-gc benchmarks/runtime/baseline.ts 25 1000
```

O resultado é JSON versionado, adequado para redirecionar para um arquivo:

```sh
bun --expose-gc benchmarks/runtime/baseline.ts > baseline.json
```

Os limites versionados estão em [`budgets.json`](./budgets.json) e são
verificados por:

```sh
bun run check:budgets
```

A referência da release é selecionada por plataforma (`0.2.3-linux.json` ou
`0.2.3-macos.json`), com fallback explícito para
[`baselines/0.2.3.json`](./baselines/0.2.3.json). Use
`EMPILHA_BENCHMARK_BASELINE=/caminho/arquivo.json` para uma baseline de CI
específica.

## Perfis de runtime

```sh
bun benchmarks/runtime/path.ts
bun benchmarks/runtime/route-profile.ts
bun --expose-gc benchmarks/runtime/register.ts 1000
bun benchmarks/runtime/register-profile.ts 10000
bun --expose-gc benchmarks/runtime/request-profile.ts
bun --expose-gc benchmarks/runtime/plugin-profile.ts
bun --expose-gc benchmarks/runtime/validator-profile.ts
bun benchmarks/runtime/di-scope.ts
```

Eles medem, respectivamente, parsing de paths, custo de registro, fases de
bootstrap, latência do pipeline HTTP, plugins e compilação de validators/
serializers.

## Build, bundle e tipos

```sh
bun benchmarks/build/build-profile.ts
bun benchmarks/build/bundle-smoke.ts
bun benchmarks/build/type-profile.ts
```

O `bundle-smoke` compila cenários mínimo, schema, OpenAPI, PostgreSQL e
PostgreSQL + JWT. Também verifica os subpaths públicos e impede que `pg` ou
`jose` apareçam em bundles que não os utilizam.

## Comandos equivalentes

Os principais benchmarks também estão disponíveis no `package.json`:

```sh
bun run benchmark:baseline
bun run benchmark:path
bun run benchmark:routes
bun run benchmark:request
bun run benchmark:build
bun run benchmark:bundle
bun run benchmark:types
bun run benchmark:plugins
bun run benchmark:validators
```

Se estiver dentro de `benchmarks/`, use o caminho relativo:

```sh
bun --expose-gc runtime/baseline.ts 25 1000
```

## Interpretação

O baseline faz duas requisições de aquecimento antes de medir a resposta,
reduzindo o impacto do primeiro caminho de execução. O JSON registra a
quantidade em `warmupRequests`.

Resultados não devem ser comparados entre máquinas diferentes sem registrar:

- versão do Bun;
- sistema operacional e arquitetura;
- quantidade de rotas ou schemas;
- uso de `--expose-gc`;
- carga concorrente existente no host.

Benchmarks são protocolos de medição. Budgets só devem ser ajustados após uma
baseline reproduzível e versionada.
