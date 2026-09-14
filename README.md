# Recupera

> "Transforma conversas em agendamentos."

Plataforma SaaS multi-tenant de agendamento, relacionamento comercial via
WhatsApp e agente de IA, aplicável a qualquer negócio baseado em agenda
(clínicas, salões, estúdios de estética, academias, escritórios de
advocacia, imobiliárias, autoescolas, pet shops, consultorias).

## Estrutura do repositório

```
/recupera/backend   Backend (Node.js + TypeScript + Express + Prisma + PostgreSQL)
/frontend           Frontend (a implementar — Fase C, Dias 6–7)
/ai-agent           Agente de IA comercial (a implementar — Fase E, Dias 10–11)
/automations        Automations / integrações (WhatsApp, agenda externa — Fases D e I)
/docs               Documentação normativa e de referência
```

## Documentos normativos

- `/docs/especificacao-seguranca-lgpd.md` — regras inegociáveis de
  segurança, LGPD e isolamento de tenant.
- `/docs/guia-mestre-v4.pdf` — Guia Mestre v4 (fonte deste plano de 15 dias).
- `/docs/resultado-teste-isolamento-dia2.md` — resultado documentado do
  teste obrigatório de isolamento entre tenants.

## Regra de ouro

Nunca inserir dados reais de clientes, pacientes ou negócios em nenhum
ambiente. Todos os dados usados em desenvolvimento e testes neste
repositório são 100% fictícios.

## Status

- [x] Dia 1 — Repositório estruturado, documentos normativos salvos em `/docs`.
- [x] Dia 2 — Estrutura base de multi-tenancy implementada e testada
      (`/recupera/backend`); ver `/docs/resultado-teste-isolamento-dia2.md`.
- [ ] Dia 3 — Autenticação e RBAC completos (matriz de permissões).
