# Changelog

## 0.2.4 — 2026-08-13

### Correções

- Corrigido o parser de bindings SQL para respeitar a semântica de
  `standard_conforming_strings` do PostgreSQL.
- Runners PostgreSQL sem cancelamento nativo passaram a executar queries com
  timeout de parede, sem rejeição imediata; o comportamento é documentado.
- Testes HTTP usam portas dinâmicas para evitar colisões entre processos.
- Adicionadas regressões para middleware, PostgreSQL e strings SQL com
  backslash.

### Empacotamento e CI

- `@sinclair/typebox` deixou de ser peer dependency opcional do `@empilha/jwt`.
- Testes de PostgreSQL real foram separados dos checks gerais da CI.

### Novos recursos

- Adicionados `sse()` e `upgradeWebSocket()` para streaming nativo no Bun.
- DI ganhou `@Optional`, `@Lazy`, `@InjectAll` e providers multi.
- Migrations podem rodar pelo `PostgresQueryRunner` com checksum e advisory lock.
- Schemas recursivos são publicados em `components.schemas` no OpenAPI.
- O leitor HTTP aceita texto, urlencoded e multipart, além de JSON.
- O modo `bun run dev -- --hot` habilita o HMR nativo do Bun.

Esta release define um contrato novo; não há camada de compatibilidade ou
guia de migração entre versões.
