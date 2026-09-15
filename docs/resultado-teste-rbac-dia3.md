# Resultado — Teste obrigatório de escalação de privilégio (Dia 3 / Prompt 1.3)

Data: 2026-09-15
Ambiente: local (PostgreSQL 16), dados 100% fictícios.

## O que foi implementado

**Autenticação:**
- bcrypt custo 12 (`src/config/security.ts`).
- JWT de sessão (access token) de 8h, com claim `type: "access"` — `authenticate` recusa
  qualquer token com `type` diferente, evitando reaproveitar um token de MFA como sessão.
- Refresh token opaco de 30 dias, hash SHA-256 persistido (`RefreshToken`), rotacionado a
  cada `POST /auth/refresh`; `POST /auth/logout` revoga de verdade o refresh token no banco.
- MFA/TOTP obrigatório para Owner e Admin: `POST /auth/login` desses papéis nunca devolve
  sessão direto — devolve `mfaSetupRequired` (primeira vez, via `/auth/mfa/setup` +
  `/auth/mfa/enable`) ou `mfaRequired` (já configurado, via `/auth/mfa/verify`). Segredo TOTP
  criptografado em repouso com AES-256-GCM (`src/lib/crypto.ts`).
- Rate limiting de 5 tentativas falhas / 15 min, por IP e por conta (`src/lib/rateLimiter.ts`),
  aplicado a `/auth/login`, `/auth/mfa/enable` e `/auth/mfa/verify`.

**RBAC:**
- `src/middleware/requireRole.ts`, aplicado em toda rota sensível, sempre depois de
  `authenticate` (ordem: autenticado → tenant correto → papel autorizado → executar).
- `GET/POST /usuarios`: só Owner/Admin.
- `PATCH /usuarios/:id/role`: só Owner (escalação de privilégio exige aprovação do Owner).
- `DELETE /usuarios/:id`, `DELETE /clientes/:id`: só Owner/Admin.
- Alvo com papel Owner é protegido nas rotas de usuário: tentativa de alterar/desativar um
  Owner responde 403 (RBAC dentro do mesmo tenant — diferente do 404 do Dia 2, que esconde
  existência **entre** tenants).

## Cenário do teste obrigatório

1. Tenant fictício com um usuário **Admin** e um usuário **Atendente**, e um cliente fictício.
2. Autenticado como o usuário **Atendente**.
3. Com o token do Atendente, tentativa de:
   1. Gerenciar usuários (`GET /usuarios` e `POST /usuarios`).
   2. Excluir cliente (`DELETE /clientes/:id`).
   3. Alterar permissão de outro usuário (`PATCH /usuarios/:id/role`, Atendente→Admin sobre a
      conta do Admin fictício).
4. Esperado: **403 em todos os casos**.

## Execução automatizada

Suíte: `recupera/backend/tests/rbac-privilege-escalation.test.ts` (Vitest + Supertest).

```
$ npm test

 ✓ tests/rbac-privilege-escalation.test.ts (6 tests)
   ✓ (1) Atendente tentando gerenciar usuários (listar) → 403
   ✓ (1) Atendente tentando gerenciar usuários (criar) → 403
   ✓ (2) Atendente tentando excluir cliente → 403
   ✓ (3) Atendente tentando alterar permissão de outro usuário (Atendente→Admin) → 403
   ✓ sanidade: Admin sem MFA configurado não recebe sessão direto no login
   ✓ cliente da própria RBAC permanece intacto (Atendente não conseguiu excluir)

 Test Files  3 passed (3)
      Tests  17 passed (17)   ← inclui as 7 do Dia 2 + 6 de RBAC + 4 de MFA/sessão
```

Suíte complementar `tests/auth-mfa-sessions.test.ts` cobre os demais itens do Prompt 1.3
(MFA setup→enable→verify, rotação de refresh token, invalidação real no logout, rate limiting
de login) — os 4 testes passaram.

## Verificação manual (smoke test end-to-end)

Servidor local (`npm run dev`) contra `recupera_dev`, seed fictício, acessado via `curl`:

| Cenário | Resultado |
|---|---|
| Atendente → `GET /usuarios` | **403** `{"error":"Papel não autorizado para esta ação."}` |
| Atendente → `DELETE /clientes/:id` | **403** (mesmo erro) |
| Atendente → `PATCH /usuarios/:id/role` (tentando promover o Admin a Owner) | **403** (mesmo erro) |
| Owner sem MFA → `POST /auth/login` | `{"mfaSetupRequired":true,"setupToken":"..."}` (nunca sessão direto) |
| `POST /auth/mfa/setup` + `/auth/mfa/enable` com código TOTP válido | Sessão emitida (`accessToken`/`refreshToken`) |
| Owner com MFA já habilitado → `POST /auth/login` novamente | `{"mfaRequired":true,"challengeToken":"..."}` (exige `/mfa/verify`, não repete o setup) |

## Conclusão

☑ Escalação de privilégio (gerenciar usuários, excluir cliente, alterar papel de outro
usuário) resulta **sempre em 403** para o Atendente, em todos os três casos exigidos.
☑ MFA/TOTP obrigatório para Owner/Admin, com segredo criptografado em repouso.
☑ Sessão com access token curto (8h) + refresh token longo (30d) rotacionado, com invalidação
real no logout.
☑ Rate limiting de 5 tentativas/15min por IP e por conta.
☑ Nenhum dado real foi usado — apenas tenants, usuários e clientes fictícios.

**Teste de escalação de privilégio aprovado.** Critério de aceite do Dia 3 atendido; liberado
para avançar à Fase B (Dia 4 — Storage Privado e Política de Retenção).
