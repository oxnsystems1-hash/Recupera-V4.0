# Especificação de Segurança, LGPD e Compliance — Recupera

> Fonte: consolidado a partir de `guia-mestre-v4.pdf` (RECUPERA — Guia Mestre v4.0, edição definitiva),
> seção "Dia 1 — Abertura do Repositório e Contexto Inicial" (Prompt 1.1) e referências rápidas 1–3.
> Este arquivo existe para que o Prompt 1.1 ("leia /docs/especificacao-seguranca-lgpd.md antes de
> gerar qualquer código") tenha um alvo concreto neste repositório. Os documentos-fonte originais
> (Especificação de Segurança/LGPD v1.0 e Planejamento Multissegmento v2.0) não foram fornecidos
> separadamente nesta sessão — apenas o Guia Mestre v4 consolidado, salvo em `guia-mestre-v4.pdf`
> nesta mesma pasta. Se os documentos originais existirem, devem substituir/complementar este arquivo.

## Regras inegociáveis (tratar como não-negociáveis em todo o código)

1. **Multi-tenancy real** — `tenant_id` nunca vem do frontend; sempre extraído do token autenticado (JWT).
2. **RBAC aplicado no backend** em toda rota — nunca apenas escondido na interface.
3. **Proteção contra IDOR, SQL Injection e XSS** em todo endpoint.
4. **Criptografia de dados sensíveis** em repouso e em trânsito.
5. **Validação de assinatura de webhooks do WhatsApp** antes de processar qualquer payload.
6. **Logs de auditoria** para toda ação sensível, sem senha/token/secret em texto puro.
7. **Nenhum campo fixo de setor único no núcleo** — sensibilidade de dado é resolvida dinamicamente
   pelo campo `segmento` do tenant (nunca criar tabela separada por setor nem coluna fixa,
   ex.: "prontuário").
8. **O agente de IA nunca dá aconselhamento especializado** (clínico, jurídico, financeiro ou
   qualquer área regulada), em nenhum segmento, mesmo se solicitado explicitamente.

## Ordem de verificação obrigatória em toda rota autenticada

```
autenticado? → tenant correto (do token, nunca do body/URL)? → papel autorizado? → executar
```

## Regra de isolamento entre tenants (Dia 2 / Módulo 1)

- Toda tabela de tenant tem `tenant_id` obrigatório e indexado.
- Todo acesso a dado filtra por `tenant_id` extraído do JWT — nunca do body/URL.
- Um middleware/camada central injeta esse filtro automaticamente em toda query — não é
  responsabilidade de cada desenvolvedor lembrar de filtrar manualmente.
- `tenant_id` recebido no body/URL é **ignorado silenciosamente** (nunca validado/rejeitado
  explicitamente, para não revelar a existência do campo a um atacante).
- Acesso a dado de outro tenant (por ID, listagem ou busca) deve sempre responder **404**,
  nunca 403 (403 revelaria que o dado existe em outro tenant).

## Referência — Segmentos-alvo e sensibilidade de dado

| Segmento | Sensibilidade LGPD |
|---|---|
| Clínicas / consultórios (saúde, odonto, estética) | Alta — dado de saúde |
| Salões, barbearias, estúdios de estética | Padrão |
| Academias / personal trainers | Padrão |
| Advocacia / contabilidade | Alta — sigilo profissional |
| Imobiliárias / corretores | Padrão |
| Autoescolas | Padrão |
| Pet shops / clínicas veterinárias | Moderada |
| Consultorias (financeira, RH, negócios) | Alta — dado financeiro |

O grau de sensibilidade e o comportamento do sistema/agente de IA são resolvidos **dinamicamente**
a partir do campo `Tenant.segmento` — nunca por tabela ou coluna dedicada a um setor.

## Referência — Matriz RBAC (válida para todos os segmentos)

| Papel | Pode | Não pode |
|---|---|---|
| Owner | Acesso total ao tenant; aprova ações sensíveis; exclui/transfere o tenant; auditoria completa | — |
| Admin | Gerencia usuários (exceto Owner); configura serviços/horários/integrações; cria solicitações sensíveis; acessa relatórios | Aprovar as próprias solicitações sensíveis; excluir/transferir o tenant |
| Atendente | Inbox, criar/editar agendamentos | Configurações, usuários, dados financeiros, exclusão de clientes |
| Read Only | Visualizar agendamentos e conversas | Editar qualquer coisa; configurações; dados sensíveis |

RBAC completo é implementado no Dia 3 (Módulo 1). Neste repositório, o modelo `User.role`
já existe com os quatro papéis acima, mas a matriz de permissões ainda não está aplicada
em todas as rotas.

## Regra de ouro

Nunca inserir dados reais de clientes, pacientes ou negócios em nenhuma sessão/ambiente.
Usar sempre dados fictícios — em prototipagem, testes e conteúdo de marketing.
