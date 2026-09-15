# Resultado — Telas principais (Dia 6 / Fase C / Prompt 3.1)

Data: 2026-09-15
Ambiente: local (PostgreSQL 16, Node 22, Chromium), dados 100% fictícios.
Critério do guia: *"3 telas funcionais integradas ao backend real."*

Escopo: TELA 1 Dashboard (Owner/Admin), TELA 2 Agendamento
(Owner/Admin/Atendente), TELA 3 Inbox (Atendente/Admin/Owner) — integradas ao
backend das Fases A e B, não protótipo isolado.

---

## 1. O que foi construído

### Dependência que precisou vir antes
As três telas dependem de entidades que não existiam: `Profissional`,
`Servico`, `Agendamento`, `Conversa`, `Mensagem`. Como a regra inegociável do
Prompt 3.1 proíbe tela apoiada em backend simulado, elas foram modeladas,
migradas e expostas com RBAC antes de qualquer componente.

### Backend novo
| Rota | Papéis | Observação |
|---|---|---|
| `GET /dashboard` | Owner, Admin | Métricas do dia, próximos 4h, conversas recentes |
| `GET /agenda/agendamentos` | todos autenticados | Janela obrigatória, teto de 62 dias e 1000 registros |
| `GET /agenda/profissionais` · `/servicos` · `/disponibilidade` | todos autenticados | Leitura |
| `POST /agenda/agendamentos` | Owner, Admin, Atendente | 409 em conflito de horário |
| `PATCH /agenda/agendamentos/:id` | Owner, Admin, Atendente | Remarcação e status |
| `POST /agenda/agendamentos/:id/cancelar` | Owner, Admin, Atendente | Motivo obrigatório |
| `GET /conversas` · `GET /conversas/:id/mensagens` | todos autenticados | Leitura |
| `POST /conversas/:id/mensagens` | Owner, Admin, Atendente | |
| `POST /conversas/:id/sugestoes/:mensagemId/enviar` · `/descartar` | Owner, Admin, Atendente | Único caminho de decisão sobre sugestão de IA |
| `PATCH /conversas/:id/lida` | Owner, Admin, Atendente | Marcar como lida é edição |

### Duas garantias que não são de aplicação, são de banco
1. **Double-booking.** `EXCLUDE USING gist` em `agendamentos`
   (`profissionalId` + `tsrange(inicioEm, fimEm)`, ignorando cancelados).
   Checar "está livre?" na aplicação perde a corrida entre o `SELECT` e o
   `INSERT`; a restrição decide dentro da transação. Provado com duas
   requisições em `Promise.all`: o resultado é exatamente `[201, 409]` e o
   banco fica com 1 linha.
2. **Intervalo válido.** `CHECK (fimEm > inicioEm)`.

### A regra da sugestão de IA, escrita no dado
`Mensagem.status` nasce `SUGERIDA` e só vira `ENVIADA` por uma transição
condicional (`updateMany ... where status = 'SUGERIDA'`) disparada por um
endpoint que carimba `enviadaPorId` e `enviadaEm`. Não existe outro caminho
no código que produza uma mensagem de IA enviada. Abrir a conversa não
dispara nenhuma chamada a `/sugestoes/` — há teste que conta as chamadas.

### Design (Referência Rápida 5)
Paleta em tokens CSS: Branco/Bege `#FDFDFB` (base), Azul-Marinho `#0F2747`
(estrutura), Cinza-Claro `#D1D5DB` (bordas), Marsala `#722F37`
(ação/destaque), Verde-Oliva (status), Azul-Vivo (notificação). **O Dourado
`#D4AF37` do Manual de Marca não aparece na interface** — há teste que falha
se ele entrar. Poppins com piso de 14px, foco sempre visível, layout que
colapsa em tablet.

---

## 2. FASE 1 — Auditoria

Checklist do Apêndice A, linha a linha:

| Item | Situação |
|---|---|
| Nenhum tenant_id, ID interno ou dado de outro usuário exposto por engano | OK — todos os models novos entraram em `TENANT_SCOPED_MODELS`; testes de IDOR por rota |
| Nenhuma chave/senha/secret hardcoded | OK |
| Toda query usa parâmetros | OK — Prisma, sem SQL concatenado |
| Toda rota nova com autenticação e permissão antes de qualquer ação | OK — `authenticate` no router, `requireRole` em toda escrita |
| Upload valida tipo real e nome aleatório | N/A no Dia 6 (inalterado do Dia 4) |
| Webhooks validam assinatura | N/A no Dia 6 (Fase D) |
| Nenhum log com senha/token/secret | OK — auditoria registra ids, nunca conteúdo de mensagem |
| Automação com limite/cooldown/opt-out | N/A no Dia 6 |
| Nenhum dado real de cliente | OK — seed, testes e capturas 100% fictícios |

### Falhas encontradas

Nenhuma 🔴 crítica. A classe de falha que o prompt manda caçar — ação visível
sem checagem real no backend, tenant_id vazando, chamada de API sem validação
de papel — foi verificada rota por rota, com chamada direta à API usando o
token de quem não pode. As falhas reais são de outra natureza:

**🟠 Alta**

| # | Onde | Por que é falha |
|---|---|---|
| F-01 | `frontend/src/telas/Agenda.tsx`, `criar()` | `evento.currentTarget.reset()` depois de um `await`: o React zera `currentTarget` ao fim do despacho. No caminho de sucesso o POST retorna 201, o agendamento é criado **e a tela diz que falhou** — o atendente tenta de novo e leva 409. Os testes existentes só exercitavam o caminho de erro, por isso passava despercebido |
| F-02 | `frontend/src/estilos/tokens.css` e as três telas | Raiz de 15px com textos em `0.75rem` (11,25px) e `0.85rem` (12,75px): abaixo do piso de 14px da Referência Rápida 5, em contador de não lidas, rótulos, status e cabeçalhos de tabela |
| F-04 | `frontend/src/telas/Agenda.tsx` | "Disponibilidade por profissional" é requisito explícito do Prompt 3.1 e não estava na tela — o endpoint existia e ficou órfão |
| F-05 | `frontend/src/telas/Inbox.tsx`, `abrir()` | Sem guarda de sequência: clicar em duas conversas em sequência rápida deixa a resposta da primeira chegar depois e pintar o histórico **de um cliente sob o nome de outro**. A Agenda já tratava essa corrida; o Inbox não |
| F-06 | `frontend/src/telas/Agenda.tsx` + `clientes.repository.ts` | A tela puxava `GET /clientes` inteiro (telefone, e-mail e endereço de **todos** os clientes) só para preencher um `<select>` de id + nome — dado pessoal no navegador sem finalidade (LGPD art. 6º, III) |
| F-07 | `agenda.service.ts`, `SELECAO_AGENDAMENTO` | `observacao` e `motivoCancelamento` (texto livre, potencialmente sensível conforme o segmento do tenant) trafegavam em toda listagem e no dashboard, para todo papel — sem nenhuma tela usá-los |

**🟡 Média**

| # | Onde | Por que é falha |
|---|---|---|
| F-03 | `tokens.css` + badges | Branco sobre `#2E6BFF` dá **4,503:1**: passa em WCAG AA por três milésimos. Não é violação, é margem inexistente — qualquer ajuste de tom ou tema derruba |
| F-08 | `Inbox.tsx` | Erro ao abrir uma conversa era escrito no mesmo estado de erro da lista: a lista inteira sumia e o "Tentar de novo" recarregava a coisa errada |
| F-09 | `Inbox.tsx` | `PATCH /lida` com `.catch(() => undefined)` + zeragem otimista: se o backend recusasse, a tela afirmava "0 não lidas" que não existia |
| F-10 | `agenda.controller.ts`, `criarAgendamento` | `observacao` ia crua para o Prisma: qualquer não-string virava 500 em vez de 400, e o tamanho era limitado só pelo corpo de 100kb |
| F-11 | `agenda.controller.ts`, `listarAgendamentos` | Sem `take`: janela de 62 dias não limita nada em tenant com agenda cheia |
| F-12 | `agenda.routes.ts` | `GET /agenda/disponibilidade` exigia papel de edição, sendo leitura derivada dos mesmos agendamentos que o Read Only já lista — inconsistência de RBAC |
| F-13 | `agenda.controller.ts`, `atualizarAgendamento` | `servico?.duracaoMinutos ?? 30` remarcaria com duração inventada, silenciosamente |
| F-14 | `frontend/src/api/client.ts` | 401 sem tratamento global: token vencido deixava a pessoa presa numa tela de erro genérico |
| F-15 | `Agenda.tsx`, `cancelar()` | `window.prompt` para o motivo: não é formulário para leitor de tela, não aceita rótulo, não respeita a paleta, é bloqueado por navegador |
| F-16 | `componentes/Layout.tsx` | Link "Pular para o conteúdo" com `visualmente-oculto`: escondido **inclusive no foco** (WCAG 2.4.7) |
| F-17 | `Inbox.tsx`, `Agenda.tsx` | Grade de duas colunas e tabela larga sem colapso/contenção: overflow horizontal em tablet |
| F-18 | `src/App.tsx` | Owner e Admin aterrissavam na Agenda, não no Dashboard |
| F-19 | `src/api/client.ts` | Comentário afirmava que nenhuma mensagem do servidor é exibida crua — o código exibia `error` verbatim. Comentário que mente é pior que comentário ausente |
| F-20 | `Agenda.tsx` | `<th>` "Ações" renderizado vazio para quem não edita: leitor de tela anuncia coluna sem nome |
| F-21 | `Inbox.tsx` | Sugestão do agente, depois de aprovada, aparecia no histórico como texto do atendimento, sem origem |
| F-22 | `frontend/tests/telas.test.tsx` | Lacuna de cobertura: o caminho de sucesso do formulário da agenda nunca era exercido — foi o que escondeu F-01 |
| F-23 | `inbox.controller.ts` | Descartar sugestão já decidida devolvia 404; enviar devolvia 409. Mesmo estado, dois códigos |
| F-24 | `Inbox.tsx` | Campo de mensagem sem `maxLength`: só se descobre o teto de 4000 depois do 400 |
| F-25 | `tokens.css`, `.grade-formulario` | `min-width: auto` de item de grade: a largura intrínseca do `<input type="datetime-local">` estourava a coluna e passava por cima do campo vizinho. Só apareceu renderizando a tela de verdade |

---

## 3. FASE 2 — Revalidação independente

Regra adotada: **toda correção precisa de um teste que falhe se ela for
revertida.** Cada teste abaixo foi rodado contra o código sem a correção,
confirmado falhando, e só então aceito. As reversões foram feitas uma a uma,
de forma automatizada, e o resultado está na coluna "evidência".

### Backend — `recupera/backend/tests/telas-dia6-correcoes.test.ts`

| Falha | Correção | Evidência (teste que falha sem ela) | Veredito |
|---|---|---|---|
| F-06 | `list(q, resumo)` com `select` explícito; `?resumo=1` devolve só id + nome | Corpo da resposta não contém telefone nem endereço; chaves == `['id','nome']`. Revertido → falha | RESOLVIDO |
| F-07 | `SELECAO_AGENDAMENTO` (lista) sem observação; `SELECAO_AGENDAMENTO_DETALHE` só para quem acabou de escrever | Listagem e dashboard não contêm o texto da observação; o 201 do create contém. Revertido → falha | RESOLVIDO |
| F-10 | `observacaoValida()` na borda, em criar e atualizar | `observacao: {objeto}` → 400 (não 500); 501 caracteres → 400 e nada gravado. Revertido → falha | RESOLVIDO |
| F-11 | `take: MAX+1` + campo `truncado` na resposta | 1001 agendamentos fictícios reais no banco; resposta ≤ 1000 e `truncado: true`. Revertido → falha (`expected 1001 to be ≤ 1000`) | RESOLVIDO |
| F-12 | `GET /disponibilidade` movido para o grupo de leitura | Read Only recebe 200; sem token, 401; a faixa devolvida só tem `inicioEm`/`fimEm`, nenhum dado de cliente. Revertido → falha | RESOLVIDO |
| F-13 | `?? 30` removido; sem serviço, 409 | Ao reproduzir, o **banco** mostrou que o cenário não acontece: a FK recusa apagar serviço com agendamento. O teste passou a provar a garantia real (FK) e que a remarcação recalcula pela duração do serviço (90 min, não 30) | RESOLVIDO COM RESSALVA — o `?? 30` era código morto; a correção é defesa em profundidade, não conserto de bug alcançável |
| F-23 | `descartar` devolve 409 para sugestão já decidida | Enviar → descartar = 409; a decisão humana (`ENVIADA`, `enviadaPorId`) não é desfeita; inexistente ainda é 404; Read Only ainda é 403. Revertido → falha | RESOLVIDO |

### Frontend — `frontend/tests/telas-dia6-correcoes.test.tsx`

| Falha | Correção | Evidência (teste que falha sem ela) | Veredito |
|---|---|---|---|
| F-01 | Elemento do formulário guardado antes do `await` | Caminho feliz: aparece "Agendamento criado.", não aparece a mensagem de erro, e o `<select>` volta a vazio. Revertido → falha | RESOLVIDO |
| F-02 | Raiz 16px + token `--fs-secundario: 0.875rem`; nenhum tamanho menor | Varredura de `src/**`: nenhum `font-size` abaixo de 0,875rem. Revertido (raiz 15px) → falha | RESOLVIDO |
| F-03 | Todo fundo com texto branco usa `--azul-vivo-escuro` (6,7:1) | Contraste calculado pela fórmula da WCAG sobre os tokens; e nenhuma tela usa o tom claro como fundo. Revertido → falha | RESOLVIDO |
| F-04 | Painel de disponibilidade por profissional | Escolher profissional chama `/agenda/disponibilidade` e exibe as faixas; sem profissional escolhido, nenhuma chamada. Revertido → falha | RESOLVIDO |
| F-05 | Número de sequência em `abrir()` | Conversa A responde em 120ms, B na hora; abre A, abre B: o conteúdo de A nunca aparece, mesmo depois de a resposta atrasada chegar. Revertido → falha | RESOLVIDO |
| F-06 | Tela pede `/clientes?resumo=1` | A chamada registrada contém `resumo=1`. Revertido → falha | RESOLVIDO |
| F-08 | Estado de erro separado por painel | Erro 500 ao abrir: a mensagem aparece no histórico e a conversa continua clicável na lista. Revertido → falha | RESOLVIDO |
| F-09 | Contador só zera após confirmação do backend | `PATCH` 404: aviso explícito e o contador "3" permanece. Revertido → falha | RESOLVIDO |
| F-14 | Gancho de expiração no cliente HTTP, registrado pelo provedor de sessão | 401 no dashboard devolve a pessoa à tela "Entrar na Recupera". Revertido → falha | RESOLVIDO |
| F-15 | Formulário com campo rotulado "Motivo do cancelamento" | `window.prompt` espionado: nunca chamado; o cancelamento conclui pelo formulário. Revertido → falha | RESOLVIDO |
| F-16 | Classe `.link-pular`, visível ao receber foco | Link com a classe certa, regra `:focus { left: 0 }` presente, `main#conteudo` existe. Revertido → falha | RESOLVIDO |
| F-17 | `.grade-inbox` com media query, tabela em `.rolagem-horizontal` | Estrutura verificada no DOM; e, no navegador real a 768px, `scrollWidth == clientWidth` (sem rolagem horizontal de página) | RESOLVIDO |
| F-18 | Tela inicial derivada do papel | Owner entra e vê o `<h1>Dashboard`. Revertido → falha | RESOLVIDO |
| F-20 | Coluna "Ações" não é renderizada para quem não edita | Cabeçalhos == `[Quando, Cliente, Serviço, Profissional, Status]`, nenhum vazio. Revertido → falha | RESOLVIDO |
| F-21 | Marcação de origem no histórico | Mensagem `AGENTE_IA` com status `ENVIADA` mostra "Sugestão do agente, aprovada por uma pessoa". Revertido → falha | RESOLVIDO |
| F-19, F-22, F-24, F-25 | Comentário corrigido; caminho de sucesso coberto (F-01); `maxLength` igual ao teto do backend; `min-width: 0` na grade do formulário | F-22 é o próprio teste de F-01. F-25 foi medido no navegador: o campo de data ia a 234px numa coluna de 191px (vazava 43px sobre o vizinho) e passou a 190px | RESOLVIDO |

### Qualidade dos testes (critério do prompt)

- **Falham se a proteção sumir?** Sim — 18 correções foram revertidas uma a
  uma e todos os testes correspondentes falharam. Nenhum teste passou nos
  dois estados.
- **Cobrem o caso negativo via API direta?** Sim. O controle de acesso é
  provado em `telas-principais.test.ts` e `telas-dia6-correcoes.test.ts`
  chamando a API com o token de quem não pode (Read Only tentando criar
  agendamento, enviar mensagem, decidir sugestão, marcar como lida;
  Atendente tentando o dashboard; tenant A tentando entidades do tenant B).
  Os testes de tela provam apenas que o botão não aparece — que é ergonomia,
  não controle de acesso, e está documentado como tal no cabeçalho do arquivo.
- **Dependem de mock que mascara o backend?** Os testes de backend não usam
  mock nenhum: app real, PostgreSQL real, migrations reais (inclusive a
  restrição `EXCLUDE`, que `db push` não aplicaria). Os testes de tela
  substituem só o `fetch` — e por isso não valem como prova de permissão.
  A ponte entre os dois foi fechada rodando a aplicação de verdade (seção 4).

**Nenhum item 🔴 permaneceu como AINDA FALHA — porque nenhum 🔴 foi
encontrado. Nenhum item de qualquer severidade ficou como AINDA FALHA.**

---

## 4. Verificação no navegador (aplicação real)

Backend em `:3000`, Vite em `:5173`, banco `recupera_dev` com o seed
fictício, Chromium via Playwright. O que foi observado:

| Verificação | Resultado |
|---|---|
| Owner: login + MFA/TOTP → Dashboard | Métricas reais do seed (1 agendamento hoje, 1 confirmado, 0 cancelados, 1 conversa não lida); próximo agendamento na janela de 4h |
| Owner: agenda com filtro por profissional | Painel de disponibilidade lista as faixas ocupadas; tabela com os 2 agendamentos |
| Owner: inbox | Sugestão do agente exibida com "Enviar ao cliente"/"Descartar"; nada enviado ao abrir |
| Read Only: menu | Sem item "Dashboard" |
| Read Only: agenda | Sem "Novo agendamento" e sem botão de cancelar |
| Read Only: inbox | Sem enviar/descartar sugestão e sem campo de resposta |
| Tablet (768px) | Inbox colapsa para uma coluna; sem rolagem horizontal de página |
| Console do navegador | Nenhum erro da aplicação |

Observação de ambiente: o Google Fonts está bloqueado neste sandbox, então as
capturas saem com a fonte de sistema. A `font-family` já declara a cadeia de
fallback, então a degradação é silenciosa e esperada.

Uma correção (F-25) só apareceu aqui — nenhum teste em jsdom a pegaria,
porque jsdom não faz layout. Vale registrar: suíte verde não substitui abrir
a tela.

---

## 5. Números

| | Antes do Dia 6 | Depois |
|---|---|---|
| Testes de backend | 84 | 122 (12 arquivos) |
| Testes de tela | 0 | 31 (2 arquivos) |
| `tsc --noEmit` | limpo | limpo nos dois projetos |

---

## 6. Limitações conhecidas (entram no Dia 7 ou depois)

- **Token de acesso em memória.** Nada em `localStorage` — XSS não lê a
  sessão. O custo é reautenticar ao recarregar a página. Cookie `httpOnly` +
  CSRF é decisão de infraestrutura do Dia 14.
- **Sem refresh automático no frontend.** O refresh token existe no backend
  desde o Dia 3; a tela ainda não o usa. Hoje o 401 devolve ao login (F-14).
- **Calendário como lista.** As três visões (mensal/semanal/diária) mudam o
  período consultado, mas o desenho é tabular. Grade visual fica no Dia 7.
- **`GET /conversas/:id/mensagens` não é auditado.** Leitura de cadastro
  também não é, desde o Dia 2 — é coerente, mas é uma decisão a revisar na
  validação final (Dia 15) para tenants de segmento sensível.
- **Sem paginação.** Listas têm teto (1000 agendamentos, 200 conversas, 500
  mensagens) e a resposta avisa quando trunca, mas não há navegação por
  página.
- **Sem favicon.** O Dourado da marca é justamente permitido ali (Regras de
  Ouro); entra na Fase F.
