# Resultado — Endpoints LGPD e Auditoria (Dia 5 / Prompt 2.2)

Data: 2026-09-15
Ambiente: local (PostgreSQL 16), dados 100% fictícios.
Critério de aceite do guia: *"3 endpoints testados com casos reais; auditoria
completa e sem dado sensível em texto puro."*

## O que foi implementado

### Portabilidade — `POST /lgpd/exportar`
Pacote com dados cadastrais do titular, **referências** de arquivo (nunca os
bytes nem o caminho interno do storage) e as solicitações LGPD dele, sempre
restrito ao tenant de quem pede (titular de outro tenant → 404, nunca 403).
Prazo de 15 dias registrado na solicitação.

`agendamentos` e `conversas` saíam como listas vazias porque essas entidades
ainda não existiam no backend. **Atualizado no Dia 6:** elas passaram a
existir e a exportação já as devolve de verdade, com uma exceção deliberada —
sugestões do agente de IA ainda não decididas ficam fora, porque nunca foram
comunicadas ao titular. Ver `/docs/resultado-teste-telas-dia6.md`.

### Correção — `PATCH /lgpd/corrigir` + `POST /lgpd/corrigir/confirmar`
Só campos cadastrais (`nome`, `email`, `telefone`, `endereco`); qualquer outro
campo é descartado. O dado **não muda** no momento do pedido: fica uma
proposta com token de confirmação (opaco, guardado só como hash SHA-256,
válido 48h, uso único). O titular confirma por endpoint público — ele não é
usuário do sistema, então a credencial é o token, com rate limiting por IP.

### Exclusão — `DELETE /lgpd/excluir` + aprovação do Owner
Abre solicitação `PENDENTE`; nada é apagado até o **Owner** aprovar (Admin
recebe 403). Na aprovação, o caso limítrofe do Prompt 2.2 é decidido:

| Situação | Comportamento |
|---|---|
| Sem obrigação legal | Exclusão real imediata: bytes fora do storage, registros fora do banco |
| Com obrigação legal (fiscal/contratual) | `BLOQUEADA` com motivo registrado e data de vencimento; **executa sozinha** quando o prazo vence (`jobs/lgpdSweep.ts`) |

A obrigação legal não é um campo solto: vem do bloqueio já modelado no Dia 4
(`Arquivo.exclusaoBloqueada` + `retentionUntil`), ligando os dois dias.

### Auditoria — imutabilidade garantida pelo banco
`logs_auditoria` generaliza o `LogAcessoArquivo` do Dia 4 e cobre login
(sucesso e falha), logout, MFA habilitado, reuso de sessão detectado, CRUD de
usuário, cliente, arquivo e todo o ciclo LGPD.

A imutabilidade **não depende do código da aplicação**: a migration instala um
trigger que recusa qualquer `UPDATE` e só permite `DELETE` de linha com mais
de 5 anos — exatamente a "retenção mínima de 5 anos, independente da política
do tenant". Vale também para quem chegar no Postgres por fora do backend.

Mascaramento (`lib/mascarar.ts`): CPF vira `***.***.***-**`, e-mail vira
`j***@gmail.com`, e o valor de qualquer chave que contenha senha/password/
token/secret/hash/authorization é substituído por `[removido]`,
recursivamente, antes de chegar ao banco.

## Execução automatizada

```
$ npm test

 ✓ tests/lgpd-auditoria.test.ts (24 tests)
 ✓ tests/seguranca-regressao.test.ts (17 tests)
 ✓ tests/arquivos-storage.test.ts (11 tests)
 ✓ tests/auth-mfa-sessions.test.ts (4 tests)
 ✓ tests/tenant-isolation.test.ts (7 tests)
 ✓ tests/rbac-privilege-escalation.test.ts (6 tests)
 ✓ tests/lgpd-aprovacao-falha.test.ts (1 test)
 ✓ tests/error-handling.test.ts (4 tests)
 ✓ tests/segmentos.test.ts (6 tests)
 ✓ tests/fileSignature.test.ts (4 tests)

 Test Files  10 passed (10)
      Tests  84 passed (84)
```

Rodado duas vezes, mesmo resultado (sem flakiness). `tsc --noEmit` e
`npm run build` limpos.

## Verificação manual (servidor real)

| Cenário | Resultado |
|---|---|
| `POST /lgpd/exportar` | Pacote do titular com prazo `2026-09-30` (15 dias) |
| `PATCH /lgpd/corrigir` → endereço | Antes: `(vazio)` — dado **não** mudou no pedido |
| `POST /lgpd/corrigir/confirmar` | HTTP 200 → depois: `Rua Confirmada, 500` |
| `DELETE /lgpd/excluir` | `PENDENTE` + aviso "requer aprovação do Owner"; titular intacto |
| Aprovação do Owner | `CONCLUIDA`; titular removido de verdade do banco |
| Trilha de auditoria do titular | `LGPD_EXPORTACAO → LGPD_CORRECAO_SOLICITADA → LGPD_CORRECAO_CONFIRMADA → LGPD_EXCLUSAO_SOLICITADA → LGPD_EXCLUSAO_APROVADA → LGPD_EXCLUSAO_EXECUTADA` |

## Defeitos encontrados na revisão e corrigidos

Revisão linha a linha do código do Dia 5, com os erros listados antes de
qualquer correção. Cada um tem teste de regressão em `tests/lgpd-auditoria.test.ts`.

| # | Defeito | Gravidade | Correção |
|---|---|---|---|
| E1 | Exclusão do titular deixava **registros de arquivo órfãos** (relação é `SetNull`, não cascade): bytes iam embora, metadado do titular ficava | Grave | Remoção explícita das linhas de `arquivos` antes de apagar o cliente |
| E2 | Varredura excluía titular que ganhou **obrigação legal nova** depois do bloqueio | Grave | Revalida a obrigação antes de executar; se houver, reagenda e audita |
| E3 | Token de confirmação voltava na resposta **também em produção** — o tenant confirmaria no lugar do titular | Grave | Em produção o token nunca volta; fora dela, sim (teste manual) |
| E4 | Corrida na aprovação: duas aprovações simultâneas → segunda em 500 | Médio | Trava otimista por `aprovadoEm: null` (a primeira tentativa de trava, por `status`, não funcionava — pega pelo teste) |
| E12 | A trava do E4 deixava a solicitação **travada para sempre** se a exclusão falhasse depois da reserva: status PENDENTE + `aprovadoEm` preenchido fazia toda retentativa devolver 409, bloqueando o direito do titular em silêncio | Grave | Reserva é liberada em caso de falha (`tests/lgpd-aprovacao-falha.test.ts`, verificado que falha sem a correção) |
| E5 | `GET /lgpd/solicitacoes` devolvia `tokenConfirmacaoHash` | Médio | `select` explícito de campos |
| E6 | Confirmar correção de titular já excluído → 500 | Médio | 410 tratado |
| E7 | `?limite=-5` na auditoria invertia a consulta do Prisma | Médio | Clamp entre 1 e 500 |
| E8 | `LOGOUT` e `MFA_HABILITADO` declarados mas nunca emitidos | Médio | Auditoria adicionada nos dois pontos |
| E9 | Máscara de CPF casava 11 dígitos de um timestamp de 13 | Menor | Fronteiras de dígito no regex |
| E10 | `as never` nos `create` do módulo | Menor | Padrão `as Prisma.XUncheckedCreateInput` do resto do projeto |
| E11 | Assinatura confusa de `executarExclusaoDoTitular` | Menor | Tipo `ClientePrisma` explícito |

### Dois defeitos de infraestrutura descobertos pelos próprios testes

**Banco de teste não rodava as migrations.** `globalSetup` usava
`prisma db push`, que reconcilia só o schema declarado e **ignora o conteúdo
das migrations** — o trigger de imutabilidade nunca existiu no banco de teste.
A suíte passaria verde sem nunca exercitar a garantia que produção aplica.
Corrigido para `prisma migrate reset`: teste roda sobre o mesmo banco que vai
para produção.

**Excluir um tenant quebraria em produção.** Com FK
`logs_auditoria → tenants ON DELETE SET NULL`, apagar um tenant dispara um
`UPDATE` na tabela append-only e o trigger recusa. A correção é conceitual: um
log de auditoria com retenção de 5 anos **precisa sobreviver** ao tenant — é
justamente quando a trilha mais importa —, então `tenantId` virou coluna
simples, sem foreign key.

## Conclusão

☑ Os 3 endpoints do Prompt 2.2 implementados e testados com casos reais.
☑ Conflito exclusão × prazo legal resolvido nos dois sentidos: não viola
obrigação fiscal nem nega o direito do titular — agenda e cumpre sozinho.
☑ Auditoria imutável garantida pelo banco, com retenção mínima de 5 anos.
☑ Nenhum dado sensível em texto puro: e-mail/CPF mascarados, segredos removidos.
☑ Dados 100% fictícios.

**Critério de aceite do Dia 5 atendido.** Liberado para a Fase C (Dia 6 —
Telas principais).

## Limitações conhecidas (decisões, não omissões)

- **Envio por e-mail em até 15 dias**: o prazo é registrado e cobrado na
  solicitação, mas o disparo automático depende da infraestrutura de
  mensageria (Fases D/G). Até lá, em produção o token de confirmação não é
  devolvido a quem pediu — o pedido fica pendente de envio ao titular.
- `agendamentos` e `conversas` na portabilidade ficam vazios até as entidades
  existirem (Fases C e D).
- A varredura LGPD roda como `setInterval` no processo, junto com a de
  retenção; scheduler externo com monitoramento é decisão do Dia 14.
