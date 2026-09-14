# Resultado — Teste obrigatório de isolamento entre tenants (Dia 2 / Prompt 1.2)

Data: 2026-09-14
Ambiente: local (PostgreSQL 16), dados 100% fictícios.

## O que foi implementado

- `Tenant.tenant_id` (`id`) obrigatório e presente em toda tabela de tenant
  (`clientes.tenantId`, `users.tenantId`), com índice (`@@index([tenantId])`).
- `Tenant.segmento` carrega a sensibilidade de dado — nenhuma tabela/coluna
  fixa de setor (ex.: nenhum campo "prontuário").
- `tenant_id` só é aceito vindo do JWT (`src/middleware/authenticate.ts` +
  `src/lib/tenantContext.ts`, via `AsyncLocalStorage`) — nunca de
  body/query/params.
- Middleware global (`src/middleware/stripSpoofedTenantId.ts`) remove
  silenciosamente qualquer `tenantId`/`tenant_id` enviado por um cliente,
  sem gerar erro de validação (não revela a existência do campo).
- Prisma Client estendido (`src/lib/prisma.ts`) injeta `tenantId`
  automaticamente em toda query dos models tenant-scoped (`Cliente`,
  `User`) — `findMany`, `findFirst`, `count`, `update*`, `delete*`,
  `create*`, `upsert`. `findUnique`/`findUniqueOrThrow` são bloqueados
  nesses models (lançam erro em tempo de execução) para impedir buscas por
  ID que ignorariam o tenant.

## Cenário do teste

1. Criados **Tenant A** ("Clínica Fictícia A") e **Tenant B** ("Salão
   Fictício B"), cada um com 1 usuário e ao menos 1 cliente, todos
   fictícios.
2. Autenticado via `POST /auth/login` como usuária do **Tenant A**.
3. Com o token do Tenant A, tentativa de acessar dado do **Tenant B**:
   - por ID (`GET /clientes/:id`)
   - por listagem (`GET /clientes`)
   - por busca textual (`GET /clientes?q=...`)
4. Tentativas adicionais de burlar o isolamento enviando `tenantId`
   forjado no **body** (ao criar) e na **query string** (ao buscar por ID).

## Execução automatizada

Suíte: `recupera/backend/tests/tenant-isolation.test.ts` (Vitest + Supertest,
contra banco `recupera_test` isolado).

```
$ npm test

 ✓ tests/tenant-isolation.test.ts (7 tests) 784ms
   ✓ sem token, acesso é negado (401) antes mesmo do isolamento de tenant
   ✓ busca por ID de cliente de outro tenant → 404 (nunca 403)
   ✓ listagem nunca inclui dados de outro tenant
   ✓ busca textual nunca retorna resultado de outro tenant
   ✓ tenant_id enviado no body é ignorado silenciosamente ao criar
   ✓ tenant_id enviado na query string é ignorado — ainda 404 para dado de outro tenant
   ✓ busca por ID de cliente do próprio tenant funciona normalmente

 Test Files  1 passed (1)
      Tests  7 passed (7)
```

## Verificação manual (smoke test end-to-end)

Servidor local (`npm run dev`) contra `recupera_dev`, seed fictício
(`npx prisma db seed`), acessado via `curl` com o token do Tenant A:

| Cenário | Resultado |
|---|---|
| `GET /clientes/:id` com ID de cliente do Tenant B | **404** `{"error":"Cliente não encontrado."}` |
| `GET /clientes?q=<termo exclusivo do cliente do Tenant B>` | `{"clientes":[]}` |
| `GET /clientes/:id?tenantId=<id do Tenant A>` (spoof na query) para ID do Tenant B | **404** (o `tenantId` da query é descartado; o real, do JWT, prevalece) |
| `GET /clientes` sem token | **401** |
| `POST /clientes` com `tenantId` de outro tenant no body | Cliente criado **no Tenant A** (o `tenantId` do body foi ignorado) |

## Conclusão

☑ Acesso cruzado entre tenants (por ID, listagem e busca) resulta **sempre
em 404**, nunca em 403 — não há sinal de que o dado do outro tenant exista.
☑ `tenant_id` vindo de body/URL é ignorado silenciosamente, em toda rota.
☑ Nenhum dado real foi usado — apenas tenants, usuários e clientes fictícios.

**Teste de isolamento entre tenants aprovado.** Critério de aceite do Dia 2
atendido; liberado para avançar ao Dia 3 (Autenticação e RBAC completos).
