# Recupera — Backend

Backend multi-tenant da Recupera (SaaS de agendamento, relacionamento via
WhatsApp e agente de IA comercial), construído em Node.js + TypeScript +
Express + Prisma + PostgreSQL.

Regras inegociáveis de segurança/LGPD: ver `/docs/especificacao-seguranca-lgpd.md`
na raiz do repositório.

## Setup local

```bash
cp .env.example .env   # ajuste DATABASE_URL/JWT_SECRET/MFA_ENCRYPTION_KEY se necessário
npm install
npm run prisma:migrate  # cria o schema no banco de DATABASE_URL
npm run prisma:generate
npx prisma db seed      # dados fictícios de exemplo (2 tenants, 4 papéis cada)
npm run dev
```

`MFA_ENCRYPTION_KEY` precisa ser uma chave AES-256 de 32 bytes (64 caracteres
hex) — gere uma nova por ambiente com
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

## Testes

```bash
npm test
```

Sobe o schema no banco definido em `TEST_DATABASE_URL` (padrão:
`recupera_test`) e roda a suíte sequencialmente (todos os arquivos
compartilham o mesmo banco), incluindo os testes obrigatórios de
isolamento entre tenants (`tests/tenant-isolation.test.ts`) e de escalação
de privilégio (`tests/rbac-privilege-escalation.test.ts`), além da suíte
de autenticação/MFA/sessão (`tests/auth-mfa-sessions.test.ts`).

## Isolamento de tenant (Dia 2)

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

## Autenticação e RBAC (Dia 3)

- `POST /auth/login` → sessão direto (Atendente/Read Only) ou
  `mfaSetupRequired`/`mfaRequired` (Owner/Admin — MFA obrigatório).
- `POST /auth/mfa/setup`, `POST /auth/mfa/enable`, `POST /auth/mfa/verify`
  — handshake de TOTP (segredo criptografado em repouso, `lib/crypto.ts`).
- `POST /auth/refresh` — rotaciona o refresh token; `POST /auth/logout` —
  revoga de verdade a sessão de 30 dias.
- `src/lib/rateLimiter.ts` — 5 tentativas falhas/15min por IP e por conta,
  em memória (single-process; para múltiplas instâncias, trocar por um
  store compartilhado como Redis mantendo a mesma interface).
- `src/middleware/requireRole.ts` — RBAC por rota (`GET/POST /usuarios`,
  `PATCH /usuarios/:id/role`, `DELETE /usuarios/:id`,
  `DELETE /clientes/:id`), sempre depois de `authenticate`.

Limitação conhecida: um usuário desativado (`active = false`) só perde
acesso quando o access token atual expirar (até 8h) — `authenticate` não
consulta o banco a cada requisição. Aceito para o MVP; revisar se o
produto exigir revogação imediata.

Resultado do teste obrigatório do Dia 3: ver
`/docs/resultado-teste-rbac-dia3.md`.
