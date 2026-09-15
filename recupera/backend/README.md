# Recupera — Backend

Backend multi-tenant da Recupera (SaaS de agendamento, relacionamento via
WhatsApp e agente de IA comercial), construído em Node.js + TypeScript +
Express + Prisma + PostgreSQL.

Regras inegociáveis de segurança/LGPD: ver `/docs/especificacao-seguranca-lgpd.md`
na raiz do repositório.

## Setup local

```bash
cp .env.example .env   # ajuste DATABASE_URL/JWT_SECRET/MFA_ENCRYPTION_KEY/FILE_URL_SECRET se necessário
npm install
npm run prisma:migrate  # cria o schema no banco de DATABASE_URL
npm run prisma:generate
npx prisma db seed      # dados fictícios de exemplo (2 tenants, 4 papéis cada)
npm run dev
```

`MFA_ENCRYPTION_KEY` e `FILE_URL_SECRET` precisam de uma chave forte por
ambiente — gere com
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
`STORAGE_ROOT` (opcional) define onde o storage privado local grava os
arquivos — padrão `./storage-privado`, já no `.gitignore`.

## Testes

```bash
npm test
```

Sobe o schema no banco definido em `TEST_DATABASE_URL` (padrão:
`recupera_test`) e o storage em `STORAGE_ROOT` (padrão: uma pasta temporária
do SO), e roda a suíte sequencialmente (todos os arquivos compartilham o
mesmo banco), incluindo os testes obrigatórios de isolamento entre tenants
(`tests/tenant-isolation.test.ts`), de escalação de privilégio
(`tests/rbac-privilege-escalation.test.ts`) e de storage/retenção
(`tests/arquivos-storage.test.ts`) e de LGPD/auditoria
(`tests/lgpd-auditoria.test.ts`), além das suítes de autenticação/MFA/sessão
(`tests/auth-mfa-sessions.test.ts`), de regressão de segurança
(`tests/seguranca-regressao.test.ts`) e de utilitários puros
(`tests/fileSignature.test.ts`, `tests/segmentos.test.ts`).

O banco de teste é preparado com `prisma migrate reset`, não com `db push`:
`db push` ignora o conteúdo das migrations (triggers, constraints) e a suíte
passaria sem exercitar garantias que produção aplica de verdade.

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

## Robustez geral (revisão pós-Dia 3)

- `src/lib/asyncHandler.ts` + `src/middleware/errorHandler.ts`: Express 4 não
  encaminha sozinho uma Promise rejeitada de um handler `async` para o
  middleware de erro — sem isso, uma falha inesperada (ex.: banco fora do
  ar) virava um `unhandledRejection` capaz de derrubar o processo inteiro,
  afetando todos os tenants. Toda rota agora passa por `asyncHandler`, e
  qualquer erro chega ao `errorHandler` central, que nunca vaza stack
  trace/mensagem interna ao cliente (resposta genérica, log só no
  servidor). Coberto por `tests/error-handling.test.ts`.
- Rota desconhecida responde 404 em JSON (não a página HTML padrão do
  Express); corpo JSON malformado responde 400 em JSON.
- `helmet()` para cabeçalhos HTTP de segurança padrão; `express.json`
  limitado a 100kb (sem upload de arquivo ainda — Dia 4 vai rever esse
  limite para as rotas de upload).
- E-mail de usuário sempre normalizado para minúsculas na criação e no
  login — evita falha de login por diferença de caixa e duplicidade tipo
  `a@x.com` / `A@x.com` no mesmo tenant.
- `POST /usuarios` exige senha com no mínimo 8 caracteres; e-mail
  duplicado no mesmo tenant responde 409 (antes vazava como 500 genérico).

Gaps conhecidos, deliberadamente fora do Dia 3 (não é omissão silenciosa):
CORS ainda não configurado (sem frontend consumindo a API ainda — entra
junto com a Fase C, Dias 6–7); rate limiter em memória não sobrevive a
restart nem escala horizontalmente (documentado acima); usuário desativado
só perde acesso quando o access token expirar.

`TRUST_PROXY` precisa refletir quantos proxies existem de fato na frente da
aplicação: com 0 atrás de um load balancer, todos os clientes compartilham o
IP do proxy e o rate limiting por IP vira um balde único; com um número
maior que o real, o cliente forja `X-Forwarded-For` e escapa do limite.

## Storage privado e retenção (Dia 4)

- `POST /arquivos` (multipart, campo `arquivo` + `tipo`) — Owner/Admin/
  Atendente; Read Only não pode.
- `GET /arquivos` — lista metadados (não os bytes) dos arquivos do tenant.
- `GET /arquivos/:id/url` — gera URL assinada de curta duração (máx. 15min,
  5min para segmentos reforçados); registra o acesso no log de auditoria.
- `GET /arquivos/download?token=...` — único endpoint público do módulo; a
  segurança é a assinatura HMAC + expiração do token, não um JWT.
- `PATCH /arquivos/:id/bloqueio`, `DELETE /arquivos/:id` — Owner/Admin.
- `src/lib/fileSignature.ts` — MIME real por número mágico dos bytes
  (JPEG/PNG/WEBP/PDF), nunca por extensão ou `Content-Type` do cliente.
- `src/lib/storage/localFilesystemStorage.ts` — storage privado local (MVP);
  trocar por S3/GCS/R2 atrás da mesma interface é decisão do Dia 14.
- `src/config/segmentos.ts` — o `segmento` do tenant decide automaticamente
  a sensibilidade (`padrão`/`reforçada`), que por sua vez decide o piso
  mínimo de retenção e o teto de TTL da URL assinada — nunca configuração
  manual caso a caso.
- `src/jobs/retentionSweep.ts` — exclusão real (bytes + registro) de
  arquivo vencido, exceto com bloqueio legal ativo; roda a cada 1h via
  `setInterval` em `server.ts` (cron externo é decisão do Dia 14).

Resultado do teste obrigatório do Dia 4: ver
`/docs/resultado-teste-storage-dia4.md`.

## LGPD e auditoria (Dia 5)

- `POST /lgpd/exportar` — portabilidade (Owner/Admin).
- `PATCH /lgpd/corrigir` — propõe correção de campo cadastral e gera token;
  `POST /lgpd/corrigir/confirmar` é público (o titular não tem sessão) e
  aplica o dado só com o token válido, de uso único.
- `DELETE /lgpd/excluir` — abre a solicitação; `POST /lgpd/solicitacoes/:id/aprovar`
  é exclusivo do Owner e decide entre exclusão imediata e bloqueio por
  prazo legal.
- `GET /lgpd/auditoria` — painel do Owner, escopado ao próprio tenant.
- `src/jobs/lgpdSweep.ts` — executa exclusões cujo prazo legal venceu,
  revalidando a obrigação antes de apagar.
- `src/lib/mascarar.ts` / `src/lib/auditoria.ts` — mascaramento de CPF e
  e-mail e remoção de segredos antes de qualquer gravação no log.

A imutabilidade de `logs_auditoria` é garantida por trigger no banco (ver a
migration `lgpd_auditoria`), não pelo código — por isso o banco de teste é
preparado com `prisma migrate reset`, e não com `db push`: `db push` ignora
o conteúdo das migrations e a suíte passaria sem exercitar a garantia real.

Resultado do teste obrigatório do Dia 5: ver
`/docs/resultado-teste-lgpd-dia5.md`.

## Revisão completa dos Dias 1–4

`tests/seguranca-regressao.test.ts` guarda um teste para cada defeito
encontrado na revisão linha a linha do código dos Dias 1–4 — entre eles um
vazamento real entre tenants (contexto com `tenant_id` indefinido fazia o
Prisma descartar o filtro), a extensão de isolamento que falhava aberta em
operação desconhecida, enumeração de usuários por tempo de resposta no
login, reuso de refresh token sem reação e replay de código TOTP.

A lista completa, com o que foi corrigido e o que ficou como limitação
conhecida, está em `/docs/revisao-completa-dias-1-4.md`.
