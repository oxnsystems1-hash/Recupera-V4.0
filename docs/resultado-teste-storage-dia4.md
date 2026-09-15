# Resultado — Teste obrigatório de storage privado e retenção (Dia 4 / Prompt 2.1)

Data: 2026-09-15
Ambiente: local (PostgreSQL 16 + filesystem local como storage privado), dados 100% fictícios.

## O que foi implementado

**Upload** (`src/modules/arquivos`):
- `POST /arquivos` (multipart, campo `arquivo` + `tipo`) — `multer` com `memoryStorage`, limite de
  10MB.
- MIME real detectado pelos **bytes** do arquivo (`src/lib/fileSignature.ts`, números mágicos de
  JPEG/PNG/WEBP/PDF) — nunca pela extensão nem pelo `Content-Type` enviado pelo cliente. Um
  arquivo de texto renomeado para `.png` é rejeitado (415).
- `tipo` (categoria genérica, ex. "documento") validado por regex (`^[a-z0-9_-]{1,40}$`) —
  bloqueia tentativa de path traversal (`../../etc`) antes de tocar o storage.
- Nome do arquivo no storage é sempre `uuid-hash(sha256).ext` — nunca o nome original enviado
  pelo cliente. Path: `tenantId/tipo/nomeArmazenado`.

**Storage privado** (`src/lib/storage/localFilesystemStorage.ts`):
- Diretório fora de qualquer pasta servida estaticamente pelo Express — só o backend consegue ler.
  Em produção, a mesma interface troca para S3/GCS/R2 (decisão de infraestrutura do Dia 14, fora
  de escopo do Dia 4).

**Acesso** (`src/lib/signedUrl.ts` + `GET /arquivos/:id/url` + `GET /arquivos/download`):
- URL assinada por HMAC-SHA256, comparação por `crypto.timingSafeEqual` (evita timing attack na
  verificação da assinatura). Expiração máxima de 15 min — 5 min para tenants de segmento
  "reforçado" (saúde, jurídico/contábil, financeiro/consultoria, pet/veterinário).
- Geração só acontece dentro de rota autenticada, com o arquivo resolvido pelo Prisma Client
  escopado por tenant (404 se o arquivo for de outro tenant — nunca 403, mesma regra do Dia 2).
- Cada geração de URL é registrada em `LogAcessoArquivo` (quem, qual arquivo, até quando valia).

**Retenção** (`Tenant.retencaoArquivosDias` + `src/config/segmentos.ts` + `src/jobs/retentionSweep.ts`):
- Retenção configurável por tenant, com piso mínimo decidido automaticamente pelo `segmento`
  (365 dias para segmentos padrão, 1825 dias/~5 anos para segmentos de sensibilidade reforçada) —
  o tenant pode configurar mais, nunca menos que o piso do seu segmento.
- `exclusaoBloqueada` + `motivoBloqueioExclusao`: bloqueio legal (ex. fiscal) que impede exclusão
  manual (`DELETE /arquivos/:id` → 409) **e** a varredura automática de retenção.
- Varredura de retenção (`runRetentionSweep`) remove de verdade (bytes + registro) todo arquivo
  vencido e não bloqueado. Rodando como `setInterval` de 1h no processo real (`server.ts`) — cron
  externo com monitoramento é decisão do Dia 14.

## Cenário do teste obrigatório

"Upload inválido rejeitado · URL expirada negada · exclusão real verificada no storage."

1. Upload de um arquivo cujos bytes não correspondem a nenhum tipo permitido, mesmo com extensão
   `.png` (o vetor de ataque citado no Prompt 2.1: "arquivo malicioso renomeado").
2. Geração de URL assinada válida, download com sucesso, comparado byte a byte com o original.
3. URL com token já expirado (e também um token com assinatura adulterada).
4. Exclusão de um arquivo, verificando tanto o banco quanto o **filesystem real** (não apenas a
   resposta HTTP) antes e depois.
5. Arquivo com bloqueio legal ativo: exclusão manual negada (409) e ignorado pela varredura
   automática mesmo com retenção vencida.

## Execução automatizada

Suítes: `tests/arquivos-storage.test.ts` (11 testes), `tests/fileSignature.test.ts` (4 testes),
`tests/segmentos.test.ts` (6 testes).

```
$ npm test

 ✓ tests/arquivos-storage.test.ts (11 tests)
   ✓ upload inválido (bytes que não batem com nenhum tipo permitido) é rejeitado, mesmo com extensão de imagem
   ✓ tipo de categoria inválido (path traversal) é rejeitado antes de tocar o storage
   ✓ upload válido é aceito, com MIME detectado pelos bytes reais
   ✓ URL assinada e download > URL assinada válida permite baixar o arquivo dentro do prazo
   ✓ URL assinada e download > URL expirada é negada (nunca serve o arquivo)
   ✓ URL assinada e download > token adulterado (assinatura não bate) é negado
   ✓ URL assinada e download > acessar URL de arquivo de outro tenant é negado com 404 (nunca 403)
   ✓ Exclusão real e bloqueio legal > exclusão remove o registro e os bytes de verdade do storage
   ✓ Exclusão real e bloqueio legal > arquivo com exclusão bloqueada (prazo legal) não pode ser excluído manualmente
   ✓ Varredura automática de retenção > remove (bytes + registro) arquivo com retenção vencida
   ✓ Varredura automática de retenção > respeita bloqueio legal: não remove arquivo vencido marcado como exclusaoBloqueada
 ✓ tests/fileSignature.test.ts (4 tests)
 ✓ tests/segmentos.test.ts (6 tests)

 Test Files  7 passed (7)
      Tests  42 passed (42)   ← inclui as 25 dos Dias 2–3
```

## Verificação manual (smoke test end-to-end)

Servidor local (`npm run dev`) contra `recupera_dev`, seed fictício, `curl`:

| Cenário | Resultado |
|---|---|
| Upload de PNG com bytes válidos | **201**, `mimeType: "image/png"`, `retentionUntil` ~5 anos à frente (tenant de segmento reforçado) |
| Upload de arquivo de texto renomeado para `.png` | **415** `{"error":"Tipo de arquivo não suportado."}` |
| `GET /arquivos/:id/url` autenticado | URL assinada de curta duração |
| Download pela URL assinada | **200**, bytes idênticos byte a byte ao arquivo original enviado |

## Bug real encontrado e corrigido durante a escrita dos testes

As checagens de assinatura em `fileSignature.ts` usavam `buffer.length > N` em vez de `>= N`,
rejeitando por engano qualquer arquivo cujo conteúdo tivesse exatamente o tamanho da assinatura
mágica (ex.: um PNG de exatamente 8 bytes). Corrigido antes de declarar o dia concluído — é
exatamente o tipo de erro que a exigência "gerar o teste junto com o código" (ver Dia 2) existe
para pegar.

## Conclusão

☑ Upload inválido (MIME real não permitido, inclusive extensão forjada) é sempre rejeitado.
☑ URL assinada expirada ou adulterada é sempre negada; nunca serve o arquivo.
☑ Exclusão é real — verificada tanto no banco quanto no storage (bytes removidos de fato).
☑ Retenção respeita bloqueio legal, tanto na exclusão manual quanto na varredura automática.
☑ Segmento do tenant decide automaticamente a sensibilidade (retenção mínima e TTL de URL).
☑ Nenhum dado real foi usado — apenas tenants, usuários e arquivos fictícios.

**Teste de storage e retenção aprovado.** Critério de aceite do Dia 4 atendido; liberado para
avançar ao Dia 5 (Endpoints LGPD e Auditoria).
