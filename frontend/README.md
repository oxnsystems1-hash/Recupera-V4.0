# Recupera — Frontend (Fase C)

React 18 + TypeScript + Vite. Três telas do Prompt 3.1 (Dashboard, Agenda,
Inbox) integradas ao backend real em `../recupera/backend` — não há mock de
API fora dos testes.

## Rodar

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # Vitest + Testing Library
npx tsc --noEmit
```

O backend precisa estar de pé em `http://localhost:3000` (ou defina
`VITE_API_BASE`), e a origem do frontend precisa estar em `CORS_ORIGENS` no
`.env` do backend.

## Decisões que não são estilo

**O botão escondido não é o controle de acesso.** `src/auth/permissoes.ts`
espelha a matriz RBAC do guia apenas para decidir o que renderizar: não faz
sentido oferecer uma ação que a API vai recusar. A checagem que vale é a do
backend (`middleware/requireRole.ts`), e os testes de backend provam a recusa
chamando a API direto com o token de quem não pode — como faria alguém que
abriu o DevTools.

**Token de acesso só em memória.** Nada em `localStorage`: um XSS leria de lá
trivialmente. O custo é reautenticar ao recarregar a página, aceito
conscientemente no MVP. Cookie `httpOnly` + CSRF é decisão do Dia 14.

**Toda tela trata carga, erro, vazio e sem-permissão.** Componentes em
`src/componentes/Estados.tsx`. Caminho feliz sozinho é o que produz tela
branca quando a API cai ou a conta é nova.

**Sugestão do agente de IA é exibida, nunca enviada.** O Inbox mostra a
sugestão com dois botões explícitos ("Enviar ao cliente" / "Descartar"); abrir
a conversa não dispara nenhuma chamada de envio — há teste que conta as
chamadas.

**Paleta do produto ≠ paleta da marca.** `src/estilos/tokens.css` traz a
Referência Rápida 5. O Dourado `#D4AF37` do Manual de Marca não entra aqui:
há teste que falha se entrar. Piso tipográfico de 14px e contraste WCAG AA
também são verificados por teste.

## Estrutura

```
src/api/client.ts        fetch tipado, erros normalizados, 401 global
src/auth/                sessão (token em memória) e espelho de permissões
src/componentes/         layout e estados de tela
src/estilos/tokens.css   paleta, tipografia, grades responsivas
src/telas/               Dashboard, Agenda, Inbox, Login
tests/                   Vitest + jsdom + Testing Library
```
