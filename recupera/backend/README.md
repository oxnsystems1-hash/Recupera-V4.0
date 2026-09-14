# Recupera — Backend

Backend multi-tenant da Recupera (SaaS de agendamento, relacionamento via
WhatsApp e agente de IA comercial), construído em Node.js + TypeScript +
Express + Prisma + PostgreSQL.

Regras inegociáveis de segurança/LGPD: ver `/docs/especificacao-seguranca-lgpd.md`
na raiz do repositório.

## Setup local

```bash
cp .env.example .env   # ajuste DATABASE_URL/JWT_SECRET se necessário
npm install
npm run prisma:migrate  # cria o schema no banco de DATABASE_URL
npm run prisma:generate
npx prisma db seed      # dados fictícios de exemplo (2 tenants)
npm run dev
```

## Testes

```bash
npm test
```

Sobe o schema no banco definido em `TEST_DATABASE_URL` (padrão:
`recupera_test`) e roda a suíte, incluindo o teste obrigatório de
isolamento entre tenants (`tests/tenant-isolation.test.ts`).

## Isolamento de tenant

- `src/lib/tenantContext.ts` — contexto por requisição (AsyncLocalStorage)
  com o `tenantId` extraído do JWT.
- `src/middleware/authenticate.ts` — único ponto que lê o JWT e popula o
  contexto de tenant.
- `src/middleware/stripSpoofedTenantId.ts` — remove silenciosamente
  qualquer `tenantId`/`tenant_id` vindo de body/query/params.
- `src/lib/prisma.ts` — Prisma Client estendido que injeta `tenantId`
  automaticamente em toda query dos models tenant-scoped; bloqueia
  `findUnique`/`findUniqueOrThrow` nesses models para forçar o uso de
  `findFirst` (a única forma seguro de filtrar por tenant nesses casos).

Resultado do teste obrigatório do Dia 2: ver
`/docs/resultado-teste-isolamento-dia2.md`.
