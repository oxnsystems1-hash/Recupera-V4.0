# Revisão completa dos Dias 1–4 — defeitos encontrados e corrigidos

Data: 2026-09-15
Escopo: leitura linha a linha de todo o código escrito nos Dias 1–4
(~2.700 linhas entre `src/`, `tests/` e `prisma/`), com verificação empírica
das garantias de isolamento no banco.

Cada item abaixo tem teste de regressão em
`recupera/backend/tests/seguranca-regressao.test.ts` (salvo onde indicado).

## Crítico

### 1. Contexto com `tenant_id` indefinido rodava query SEM filtro de tenant
`requireTenantId()` devolvia `context.tenantId` sem checar se era uma string
válida. Como o **Prisma descarta silenciosamente campos `undefined` no
`where`**, um contexto malformado faria toda query tenant-scoped rodar sem
filtro nenhum — devolvendo dados de todos os tenants.

Confirmado empiricamente antes da correção: `findMany` devolveu registros de
outro tenant. **Corrigido**: `requireTenantId()` exige string não vazia e
aborta a query; `authenticate` passou a validar o payload do JWT campo a
campo (`verifyAccessToken` em `lib/tokens.ts`).

### 2. Extensão de isolamento do Prisma falhava ABERTA em operação desconhecida
Qualquer operação fora da lista conhecida (ex.: `createManyAndReturn`, ou uma
operação nova em futura versão do Prisma) passava direto, sem filtro de
tenant. **Corrigido**: a extensão agora é fail-closed — operação não tratada
lança erro em vez de rodar sem escopo.

### 3. Carregamento do `.env` dependia de efeito colateral acidental
O app só encontrava `DATABASE_URL` porque o construtor do PrismaClient
carrega o `.env` como efeito colateral, e `lib/prisma` era importado antes de
`config/env` na cadeia de imports. Reordenar um import quebrava o boot — e
quebrou, durante esta revisão. **Corrigido**: `dotenv.config()` explícito no
topo de `config/env.ts` (não sobrescreve variáveis já definidas, então
produção e testes seguem tendo precedência).

## Alto

### 4. Enumeração de usuários por tempo de resposta no login
Quando o e-mail não existia, o `bcrypt.compare` era pulado — a resposta
voltava muito mais rápido que para um e-mail existente com senha errada.
**Corrigido**: comparação contra um hash descartável de custo idêntico
quando não há candidato.

### 5. E-mail repetido entre tenants logava em tenant arbitrário
O schema permite o mesmo e-mail em tenants diferentes (`@@unique([tenantId,
email])`), mas o login usava `findFirst` sem critério — o usuário podia cair
no tenant errado. **Corrigido**: todos os candidatos com aquele e-mail são
considerados e a senha desempata, com `take` limitando o custo.

### 6. Refresh token: sem detecção de reuso e com corrida na rotação
Um token roubado e replayado só recebia 401, sem nenhuma reação; e duas
requisições simultâneas com o mesmo token podiam gerar duas sessões válidas.
**Corrigido**: reuso de token já rotacionado revoga **todas** as sessões do
usuário (tratamento de comprometimento), e a rotação virou um
compare-and-swap condicional (`updateMany ... where revokedAt: null`).

### 7. `tenant_id` forjado sobrevivia em upload multipart
`stripSpoofedTenantId` roda no `app.ts` antes de o corpo multipart ser
interpretado pelo multer — um campo de formulário `tenantId` chegava intacto
ao controller. Não havia vazamento (o `tenantId` real é reinjetado pela
extensão), mas a garantia documentada não valia para multipart.
**Corrigido**: o middleware roda de novo depois do multer na rota de upload.

### 8. Varredura de retenção parava toda no primeiro arquivo problemático
Um erro em um arquivo abortava a varredura inteira — e voltaria a abortar no
mesmo arquivo a cada hora, deixando de excluir todos os outros vencidos.
**Corrigido**: try/catch por arquivo com log e contador de falhas, `take`
limitando o lote, e bytes removidos antes do registro (a ordem inversa
deixava bytes órfãos que nenhum registro aponta).

### 9. Replay de código TOTP
O mesmo código valia por toda a janela de 30s e podia ser usado mais de uma
vez — o RFC 6238 §5.2 exige o contrário. **Corrigido**: `User.mfaUltimaJanela`
registra a última janela aceita; reuso é recusado, com atualização
condicional para resolver corrida entre requisições simultâneas.

## Médio

| # | Defeito | Correção |
|---|---|---|
| 10 | `jwt.verify` sem algoritmo fixado | `algorithms: ['HS256']` na verificação e `algorithm` na assinatura |
| 11 | Rate limiter crescia sem limite (e-mails aleatórios ⇒ exaustão de memória) | Teto de chaves + expurgo de janelas vencidas |
| 12 | Login zerava o contador de IP no sucesso | Só o contador da conta é zerado |
| 13 | `req.ip` sem `trust proxy` configurado | `TRUST_PROXY` por env, documentado nos dois sentidos do risco |
| 14 | Exclusão de arquivo apagava o registro antes dos bytes | Bytes primeiro; a varredura reencontra a linha se algo falhar |
| 15 | Download com bytes ausentes retornava 500 | 404 honesto, além de `nosniff` + CSP `sandbox` na resposta |
| 16 | Entrada malformada virava 500 (ex.: `email: 123`) | `lib/validation.ts` com tipo, formato e teto de tamanho |
| 17 | Endpoints de MFA não checavam `active` | Usuário desativado entre login e verificação não recebe sessão |
| 18 | Usuário podia desativar a própria conta | Bloqueado com 400 |
| 19 | `decryptSecret` estourava com payload malformado | Valida formato antes de decifrar |
| 20 | Segredos de exemplo podiam ir para produção | Boot falha com `NODE_ENV=production` usando valor do `.env.example` |
| 21 | Senha sem teto de tamanho | Limite de 72 (bcrypt ignora além disso) |
| 22 | Código morto (`getAuthContext`, `textoOpcional`) | Removido |

## O que foi verificado e estava correto

- **Isolamento cross-tenant em `update`/`delete`**: confirmado empiricamente
  que o Prisma aplica o `tenantId` extra no `where` (erro P2025), não o
  ignora — as garantias dos Dias 2–4 se sustentam. Agora coberto por teste
  permanente.
- Bloqueio de `findUnique` em models tenant-scoped.
- Hash de refresh token (nunca em texto puro) e criptografia do segredo TOTP.
- Validação de MIME por bytes e defesa contra path traversal no storage.
- `tenant_id` de body/query ignorado silenciosamente (JSON).

## Resultado

Suíte: **59 testes, 8 arquivos, todos passando**, com execução repetida para
confirmar que não há flakiness. `tsc --noEmit` e `npm run build` limpos.
Servidor real validado subindo e respondendo (login, validação de entrada,
normalização de e-mail).

## Limitações conhecidas que permanecem (decisões, não omissões)

- Rate limiter em memória: não sobrevive a restart nem escala horizontalmente
  (trocar por Redis mantendo a interface).
- Access token de 8h continua válido após desativação do usuário (limitação
  aceita de JWT stateless; o refresh é revogado de verdade).
- URL assinada já emitida continua válida até expirar (máx. 15 min), mesmo
  se o acesso for revogado — mesmo modelo de URL pré-assinada de S3.
- CORS ainda não configurado (entra com o frontend, Fase C).
- Storage local; object storage real é decisão do Dia 14.
