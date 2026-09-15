import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProvedorSessao, useSessao } from '../src/auth/sessao';
import { type Papel } from '../src/auth/permissoes';
import { App } from '../src/App';
import { Agenda } from '../src/telas/Agenda';
import { Inbox } from '../src/telas/Inbox';
import { useEffect, type ReactNode } from 'react';

/**
 * FASE 2 do Dia 6 — revalidação das correções da auditoria, do lado da tela.
 *
 * Cada teste foi rodado contra o código ANTES da correção e falhou; só então
 * entrou aqui. Um teste que passa dos dois jeitos não prova nada.
 *
 * O que estes testes NÃO provam continua sendo controle de acesso: isso é do
 * backend e está em `recupera/backend/tests/telas-dia6-correcoes.test.ts`,
 * chamando a API direto com o token de quem não pode.
 *
 * Dados 100% fictícios.
 */

type Resposta = { corpo?: unknown; status?: number; atrasoMs?: number };

const respostas = new Map<string, Resposta>();
const chamadas: string[] = [];

function responder(chave: string, corpo: unknown, extra: Omit<Resposta, 'corpo'> = {}) {
  respostas.set(chave, { corpo, ...extra });
}

beforeEach(() => {
  respostas.clear();
  chamadas.length = 0;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const caminho = new URL(url).pathname;
      const busca = new URL(url).search;
      const chave = `${init?.method ?? 'GET'} ${caminho}`;
      chamadas.push(`${chave}${busca}`);

      const resposta = respostas.get(chave);
      if (!resposta) {
        return new Response(JSON.stringify({ error: 'Rota não encontrada.' }), { status: 404 });
      }
      if (resposta.atrasoMs) {
        await new Promise((resolver) => setTimeout(resolver, resposta.atrasoMs));
      }
      return new Response(JSON.stringify(resposta.corpo ?? {}), { status: resposta.status ?? 200 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function tokenFicticio(papel: Papel): string {
  const payload = btoa(JSON.stringify({ role: papel, tenantId: 't', userId: 'u', type: 'access' }));
  return `cabecalho.${payload}.assinatura`;
}

function Autenticar({ children }: { children: ReactNode }) {
  const { sessao, entrar } = useSessao();
  useEffect(() => {
    if (!sessao) void entrar('usuario@ficticio.com', 'SenhaFicticia123!').catch(() => undefined);
  }, [sessao, entrar]);
  return sessao ? <>{children}</> : null;
}

function renderizarComPapel(papel: Papel, children: ReactNode) {
  responder('POST /auth/login', { accessToken: tokenFicticio(papel) });
  return render(
    <ProvedorSessao>
      <Autenticar>{children}</Autenticar>
    </ProvedorSessao>,
  );
}

const AGENDA_BASE = {
  agendamentos: [
    {
      id: 'a1',
      inicioEm: '2026-09-20T13:00:00.000Z',
      fimEm: '2026-09-20T14:00:00.000Z',
      status: 'AGENDADO',
      cliente: { id: 'c1', nome: 'Cliente Fictício' },
      profissional: { id: 'p1', nome: 'Profissional Fictício' },
      servico: { id: 's1', nome: 'Avaliação', categoria: 'consulta' },
    },
  ],
  truncado: false,
};

function prepararAgenda() {
  responder('GET /agenda/profissionais', {
    profissionais: [{ id: 'p1', nome: 'Profissional Fictício' }],
  });
  responder('GET /agenda/servicos', {
    servicos: [{ id: 's1', nome: 'Avaliação', categoria: 'consulta', duracaoMinutos: 60 }],
  });
  responder('GET /clientes', { clientes: [{ id: 'c1', nome: 'Cliente Fictício' }] });
  responder('GET /agenda/agendamentos', AGENDA_BASE);
}

async function preencherFormulario(usuario: ReturnType<typeof userEvent.setup>) {
  await usuario.selectOptions(await screen.findByLabelText('Cliente'), 'c1');
  await usuario.selectOptions(screen.getByLabelText('Profissional'), 'p1');
  await usuario.selectOptions(screen.getByLabelText('Serviço'), 's1');
  await usuario.type(screen.getByLabelText('Início'), '2026-09-20T13:00');
}

describe('F-01 — criar agendamento com sucesso não pode ser reportado como falha', () => {
  it('o caminho feliz avisa "Agendamento criado." e limpa o formulário', async () => {
    prepararAgenda();
    responder('POST /agenda/agendamentos', { agendamento: { id: 'novo' } }, { status: 201 });
    renderizarComPapel('ATENDENTE', <Agenda />);

    const usuario = userEvent.setup();
    await screen.findByRole('heading', { name: 'Novo agendamento' });
    await preencherFormulario(usuario);
    await usuario.click(screen.getByRole('button', { name: 'Agendar' }));

    // Antes da correção, `evento.currentTarget` já era null depois do await:
    // o POST dava 201, o agendamento existia e a tela dizia que falhou.
    expect(await screen.findByText('Agendamento criado.')).toBeInTheDocument();
    expect(
      screen.queryByText('Não foi possível criar o agendamento.'),
    ).not.toBeInTheDocument();
    expect((screen.getByLabelText('Cliente') as HTMLSelectElement).value).toBe('');
  });
});

describe('F-06 — a tela pede o resumo de clientes, não o cadastro inteiro', () => {
  it('a requisição de clientes leva resumo=1', async () => {
    prepararAgenda();
    renderizarComPapel('ATENDENTE', <Agenda />);

    await waitFor(() => expect(chamadas.some((c) => c.startsWith('GET /clientes'))).toBe(true));
    const chamada = chamadas.find((c) => c.startsWith('GET /clientes'));
    expect(chamada).toContain('resumo=1');
  });
});

describe('F-04 — disponibilidade por profissional (requisito do Prompt 3.1)', () => {
  it('escolher um profissional consulta e exibe as faixas ocupadas', async () => {
    prepararAgenda();
    responder('GET /agenda/disponibilidade', {
      ocupado: [{ inicioEm: '2026-09-20T13:00:00.000Z', fimEm: '2026-09-20T14:00:00.000Z' }],
    });
    renderizarComPapel('READ_ONLY', <Agenda />);

    const usuario = userEvent.setup();
    await usuario.selectOptions(await screen.findByLabelText('Filtrar por profissional'), 'p1');

    expect(
      await screen.findByRole('heading', { name: 'Disponibilidade do profissional no período' }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/^Ocupado:/)).toBeInTheDocument();
    expect(chamadas.some((c) => c.startsWith('GET /agenda/disponibilidade'))).toBe(true);
  });

  it('sem profissional escolhido, a tela não pergunta disponibilidade de ninguém', async () => {
    prepararAgenda();
    renderizarComPapel('READ_ONLY', <Agenda />);

    await screen.findByText('Cliente Fictício');
    expect(chamadas.some((c) => c.startsWith('GET /agenda/disponibilidade'))).toBe(false);
  });
});

describe('F-15 — cancelar pede o motivo num formulário acessível', () => {
  it('o motivo é um campo rotulado, e não window.prompt', async () => {
    prepararAgenda();
    responder('POST /agenda/agendamentos/a1/cancelar', { status: 'CANCELADO' });
    const prompt = vi.fn();
    vi.stubGlobal('prompt', prompt);

    renderizarComPapel('ATENDENTE', <Agenda />);
    const usuario = userEvent.setup();
    await usuario.click(await screen.findByRole('button', { name: 'Cancelar' }));

    const campo = await screen.findByLabelText('Motivo do cancelamento');
    expect(prompt).not.toHaveBeenCalled();

    await usuario.type(campo, 'Cliente fictício remarcou');
    await usuario.click(screen.getByRole('button', { name: 'Confirmar' }));

    expect(await screen.findByText('Agendamento cancelado.')).toBeInTheDocument();
  });
});

describe('F-05 — corrida ao trocar de conversa no inbox', () => {
  const DUAS_CONVERSAS = {
    conversas: [
      {
        id: 'k1',
        canal: 'WHATSAPP',
        naoLidas: 1,
        ultimaMensagemEm: '2026-09-20T12:00:00.000Z',
        cliente: { id: 'c1', nome: 'Primeira Cliente Fictícia' },
        ultimaMensagem: { conteudo: 'Olá', autor: 'CLIENTE' },
      },
      {
        id: 'k2',
        canal: 'WHATSAPP',
        naoLidas: 0,
        ultimaMensagemEm: '2026-09-20T11:00:00.000Z',
        cliente: { id: 'c2', nome: 'Segunda Cliente Fictícia' },
        ultimaMensagem: { conteudo: 'Oi', autor: 'CLIENTE' },
      },
    ],
  };

  function mensagem(id: string, conteudo: string) {
    return {
      conversa: { id, cliente: { id: 'c', nome: 'x' } },
      mensagens: [
        {
          id: `m-${id}`,
          autor: 'CLIENTE',
          conteudo,
          status: 'RECEBIDA',
          createdAt: '2026-09-20T12:00:00.000Z',
        },
      ],
    };
  }

  it('a resposta lenta da conversa anterior não sobrescreve a conversa aberta agora', async () => {
    responder('GET /conversas', DUAS_CONVERSAS);
    // A primeira conversa responde devagar; a segunda, na hora.
    responder('GET /conversas/k1/mensagens', mensagem('k1', 'SEGREDO DA PRIMEIRA CONVERSA'), {
      atrasoMs: 120,
    });
    responder('GET /conversas/k2/mensagens', mensagem('k2', 'Texto da segunda conversa'));
    responder('PATCH /conversas/k1/lida', { naoLidas: 0 });
    responder('PATCH /conversas/k2/lida', { naoLidas: 0 });

    renderizarComPapel('ATENDENTE', <Inbox />);
    const usuario = userEvent.setup();

    await usuario.click(await screen.findByRole('button', { name: /Primeira Cliente Fictícia/ }));
    await usuario.click(screen.getByRole('button', { name: /Segunda Cliente Fictícia/ }));

    expect(await screen.findByText('Texto da segunda conversa')).toBeInTheDocument();

    // Tempo de sobra para a resposta atrasada chegar e tentar pintar a tela.
    await new Promise((resolver) => setTimeout(resolver, 250));
    expect(screen.queryByText('SEGREDO DA PRIMEIRA CONVERSA')).not.toBeInTheDocument();
    expect(screen.getByText('Texto da segunda conversa')).toBeInTheDocument();
  });
});

describe('F-08 — erro ao abrir conversa não derruba a lista', () => {
  it('a lista continua na tela e o erro fica no painel do histórico', async () => {
    responder('GET /conversas', {
      conversas: [
        {
          id: 'k1',
          canal: 'WHATSAPP',
          naoLidas: 1,
          ultimaMensagemEm: '2026-09-20T12:00:00.000Z',
          cliente: { id: 'c1', nome: 'Cliente Fictício' },
          ultimaMensagem: { conteudo: 'Olá', autor: 'CLIENTE' },
        },
      ],
    });
    responder('GET /conversas/k1/mensagens', { error: 'Falha fictícia ao abrir.' }, { status: 500 });

    renderizarComPapel('ATENDENTE', <Inbox />);
    const usuario = userEvent.setup();
    await usuario.click(await screen.findByRole('button', { name: /Cliente Fictício/ }));

    expect(await screen.findByText('Falha fictícia ao abrir.')).toBeInTheDocument();
    // A conversa continua clicável: a lista não foi substituída pelo erro.
    expect(screen.getByRole('button', { name: /Cliente Fictício/ })).toBeInTheDocument();
  });
});

describe('F-09 — contador de não lidas só zera quando o backend confirma', () => {
  it('PATCH recusado mantém o contador e avisa a pessoa', async () => {
    responder('GET /conversas', {
      conversas: [
        {
          id: 'k1',
          canal: 'WHATSAPP',
          naoLidas: 3,
          ultimaMensagemEm: '2026-09-20T12:00:00.000Z',
          cliente: { id: 'c1', nome: 'Cliente Fictício' },
          ultimaMensagem: { conteudo: 'Olá', autor: 'CLIENTE' },
        },
      ],
    });
    responder('GET /conversas/k1/mensagens', {
      conversa: { id: 'k1', cliente: { id: 'c1', nome: 'Cliente Fictício' } },
      mensagens: [],
    });
    responder('PATCH /conversas/k1/lida', { error: 'Conversa não encontrada.' }, { status: 404 });

    renderizarComPapel('ATENDENTE', <Inbox />);
    const usuario = userEvent.setup();
    await usuario.click(await screen.findByRole('button', { name: /Cliente Fictício/ }));

    expect(
      await screen.findByText('A conversa foi aberta, mas não foi possível marcá-la como lida.'),
    ).toBeInTheDocument();
    // O "3" continua ali: a tela não afirma que leu o que o servidor recusou.
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});

describe('F-21 — mensagem aprovada do agente continua identificada como tal', () => {
  it('o histórico marca a origem em vez de exibi-la como texto do atendimento', async () => {
    responder('GET /conversas', {
      conversas: [
        {
          id: 'k1',
          canal: 'WHATSAPP',
          naoLidas: 0,
          ultimaMensagemEm: '2026-09-20T12:00:00.000Z',
          cliente: { id: 'c1', nome: 'Cliente Fictício' },
          ultimaMensagem: { conteudo: 'Olá', autor: 'CLIENTE' },
        },
      ],
    });
    responder('GET /conversas/k1/mensagens', {
      conversa: { id: 'k1', cliente: { id: 'c1', nome: 'Cliente Fictício' } },
      mensagens: [
        {
          id: 'm1',
          autor: 'AGENTE_IA',
          conteudo: 'Texto fictício aprovado.',
          status: 'ENVIADA',
          createdAt: '2026-09-20T12:02:00.000Z',
        },
      ],
    });
    responder('PATCH /conversas/k1/lida', { naoLidas: 0 });

    renderizarComPapel('ATENDENTE', <Inbox />);
    const usuario = userEvent.setup();
    await usuario.click(await screen.findByRole('button', { name: /Cliente Fictício/ }));

    expect(await screen.findByText('Texto fictício aprovado.')).toBeInTheDocument();
    expect(
      screen.getByText('Sugestão do agente, aprovada por uma pessoa'),
    ).toBeInTheDocument();
  });
});

describe('F-14 — sessão expirada volta ao login em vez de travar a tela', () => {
  it('um 401 vindo de qualquer tela derruba a sessão', async () => {
    responder('POST /auth/login', { accessToken: tokenFicticio('OWNER') });
    responder('GET /dashboard', { error: 'Token de autenticação inválido ou expirado.' }, { status: 401 });

    render(<App />);
    const usuario = userEvent.setup();

    await usuario.type(screen.getByLabelText('E-mail'), 'owner@ficticio.com');
    await usuario.type(screen.getByLabelText('Senha'), 'SenhaFicticia123!');
    await usuario.click(screen.getByRole('button', { name: 'Entrar' }));

    // Volta para a tela de login, em vez de ficar num erro genérico.
    expect(await screen.findByRole('heading', { name: 'Entrar na Recupera' })).toBeInTheDocument();
  });
});

describe('F-18 — cada papel aterrissa na primeira tela que pode usar', () => {
  it('Owner entra no Dashboard, não na Agenda', async () => {
    responder('POST /auth/login', { accessToken: tokenFicticio('OWNER') });
    responder('GET /dashboard', {
      metricas: { agendamentosHoje: 1, confirmadosHoje: 1, canceladosHoje: 0, conversasNaoLidas: 0 },
      janelaProximosHoras: 4,
      proximosAgendamentos: [],
      conversasRecentes: [],
    });

    render(<App />);
    const usuario = userEvent.setup();
    await usuario.type(screen.getByLabelText('E-mail'), 'owner@ficticio.com');
    await usuario.type(screen.getByLabelText('Senha'), 'SenhaFicticia123!');
    await usuario.click(screen.getByRole('button', { name: 'Entrar' }));

    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
  });
});

describe('F-16, F-17 e F-20 — estrutura acessível e responsiva', () => {
  it('F-20: quem não pode editar não recebe uma coluna "Ações" sem nome', async () => {
    prepararAgenda();
    const { container } = renderizarComPapel('READ_ONLY', <Agenda />);
    await screen.findByText('Cliente Fictício');

    const cabecalhos = [...container.querySelectorAll('th')].map((th) => th.textContent);
    expect(cabecalhos).toEqual(['Quando', 'Cliente', 'Serviço', 'Profissional', 'Status']);
    // Nenhum cabeçalho vazio: leitor de tela anunciaria "coluna em branco".
    expect(cabecalhos.some((t) => !t?.trim())).toBe(false);
  });

  it('F-17: a tabela da agenda rola dentro do cartão em vez de esticar a página', async () => {
    prepararAgenda();
    const { container } = renderizarComPapel('ATENDENTE', <Agenda />);
    await screen.findByText('Cliente Fictício');

    const tabela = container.querySelector('table');
    expect(tabela?.parentElement?.className).toBe('rolagem-horizontal');
  });

  it('F-17: o inbox usa a grade que colapsa em tela estreita', async () => {
    responder('GET /conversas', { conversas: [] });
    const { container } = renderizarComPapel('ATENDENTE', <Inbox />);
    await screen.findByText('Sem conversas');

    expect(container.querySelector('.grade-inbox')).not.toBeNull();
  });

  it('F-16: o link de pular navegação reaparece no foco', async () => {
    responder('POST /auth/login', { accessToken: tokenFicticio('ATENDENTE') });
    responder('GET /agenda/agendamentos', AGENDA_BASE);
    responder('GET /agenda/profissionais', { profissionais: [] });
    responder('GET /agenda/servicos', { servicos: [] });
    responder('GET /clientes', { clientes: [] });

    const { container } = render(<App />);
    const usuario = userEvent.setup();
    await usuario.type(screen.getByLabelText('E-mail'), 'atendente@ficticio.com');
    await usuario.type(screen.getByLabelText('Senha'), 'SenhaFicticia123!');
    await usuario.click(screen.getByRole('button', { name: 'Entrar' }));

    const link = await screen.findByRole('link', { name: 'Pular para o conteúdo' });
    // `visualmente-oculto` esconde inclusive no foco — inútil para quem
    // enxerga e navega por teclado.
    expect(link.className).toBe('link-pular');

    const css = readFileSync(join(__dirname, '../src/estilos/tokens.css'), 'utf8');
    expect(css).toMatch(/\.link-pular:focus\s*\{[^}]*left:\s*0/);
    expect(container.querySelector('main#conteudo')).not.toBeNull();
  });
});

/**
 * F-02 e F-03 não se provam clicando: são regras numéricas da Referência
 * Rápida 5 (piso de 14px) e da WCAG AA (contraste 4,5:1). Então a prova é
 * calculada sobre o que está no código — e falha se alguém reintroduzir um
 * tamanho abaixo do piso ou um fundo azul-claro com texto branco.
 */
function luminancia(hex: string): number {
  const canais = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = canais.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contraste(a: string, b: string): number {
  const [claro, escuro] = [luminancia(a), luminancia(b)].sort((x, y) => y - x);
  return (claro + 0.05) / (escuro + 0.05);
}

function arquivosDaInterface(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entrada) => {
    const caminho = join(dir, entrada.name);
    if (entrada.isDirectory()) return arquivosDaInterface(caminho);
    return /\.(tsx?|css)$/.test(entrada.name) ? [caminho] : [];
  });
}

describe('F-02 e F-03 — tipografia e contraste da Referência Rápida 5', () => {
  const css = readFileSync(join(__dirname, '../src/estilos/tokens.css'), 'utf8');

  it('a raiz é 16px e o menor tamanho da interface é 0.875rem (14px)', () => {
    expect(css).toMatch(/font-size:\s*16px/);

    const infratores: string[] = [];
    for (const arquivo of arquivosDaInterface(join(__dirname, '../src'))) {
      const conteudo = readFileSync(arquivo, 'utf8');
      for (const [, valor] of conteudo.matchAll(/font-?[sS]ize:\s*'?([0-9.]+)rem'?/g)) {
        if (Number(valor) < 0.875) infratores.push(`${arquivo}: ${valor}rem`);
      }
    }
    expect(infratores).toEqual([]);
  });

  it('todo fundo colorido que recebe texto branco passa em AA (4,5:1)', () => {
    const tons = Object.fromEntries(
      [...css.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]),
    );

    for (const token of ['estrutura', 'marsala', 'azul-vivo-escuro']) {
      expect(contraste('#ffffff', tons[token])).toBeGreaterThanOrEqual(4.5);
    }
    // Texto secundário sobre a base também precisa passar.
    expect(contraste(tons['neutro-texto'], tons['base'])).toBeGreaterThanOrEqual(4.5);

    /*
     * O tom claro (#2e6bff) marca 4,503:1 com branco — passa em AA por três
     * milésimos. Não é violação, é margem inexistente: qualquer ajuste de
     * tom, opacidade ou tema o derruba, e ninguém perceberia. Por isso todo
     * fundo COM TEXTO usa o tom escuro, que tem folga de verdade.
     */
    expect(contraste('#ffffff', tons['azul-vivo'])).toBeLessThan(4.6);
    expect(contraste('#ffffff', tons['azul-vivo-escuro'])).toBeGreaterThan(6);
    for (const arquivo of arquivosDaInterface(join(__dirname, '../src/telas'))) {
      expect(readFileSync(arquivo, 'utf8')).not.toMatch(/background:\s*'var\(--azul-vivo\)'/);
    }
  });

  it('o dourado da marca não atravessou para dentro do produto', () => {
    // Comentários explicam justamente por que o dourado NÃO está aqui —
    // a busca é pelo uso real, então o comentário sai antes.
    const semComentarios = (texto: string) =>
      texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    for (const arquivo of arquivosDaInterface(join(__dirname, '../src'))) {
      expect(semComentarios(readFileSync(arquivo, 'utf8')).toLowerCase()).not.toContain('#d4af37');
    }
  });
});
