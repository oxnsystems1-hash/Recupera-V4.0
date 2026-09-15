import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProvedorSessao, useSessao } from '../src/auth/sessao';
import { pode, type Papel } from '../src/auth/permissoes';
import { Dashboard } from '../src/telas/Dashboard';
import { Agenda } from '../src/telas/Agenda';
import { Inbox } from '../src/telas/Inbox';
import { useEffect, type ReactNode } from 'react';

/**
 * Testes das telas do Dia 6.
 *
 * O que estes testes provam e o que NÃO provam: eles provam que a interface
 * não oferece ação que o papel não tem, que os estados de carga/erro/vazio
 * aparecem, e que o conteúdo é renderizado como texto (sem HTML injetado).
 *
 * Eles NÃO provam controle de acesso — isso é do backend, e está provado em
 * `recupera/backend/tests/telas-principais.test.ts`, chamando a API direto
 * com o token de quem não pode. Esconder no frontend nunca é a garantia.
 */

/** Token fictício com o papel desejado — só a parte do payload importa aqui. */
function tokenFicticio(papel: Papel): string {
  const payload = btoa(JSON.stringify({ role: papel, tenantId: 't', userId: 'u', type: 'access' }));
  return `cabecalho.${payload}.assinatura`;
}

function Autenticar({ papel, children }: { papel: Papel; children: ReactNode }) {
  const { sessao, entrar } = useSessao();
  useEffect(() => {
    if (!sessao) void entrar('usuario@ficticio.com', 'SenhaFicticia123!').catch(() => undefined);
  }, [sessao, entrar]);
  void papel;
  return sessao ? <>{children}</> : null;
}

function renderizarComPapel(papel: Papel, children: ReactNode) {
  // O login devolve um accessToken cujo payload carrega o papel: é assim que
  // a sessão real descobre o papel, então o teste usa o mesmo caminho.
  respostas.set('POST /auth/login', { accessToken: tokenFicticio(papel) });
  return render(
    <ProvedorSessao>
      <Autenticar papel={papel}>{children}</Autenticar>
    </ProvedorSessao>,
  );
}

/** Respostas roteadas por "MÉTODO /caminho". */
const respostas = new Map<string, unknown>();
const chamadas: string[] = [];

beforeEach(() => {
  respostas.clear();
  chamadas.length = 0;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const caminho = new URL(url).pathname;
      const chave = `${init?.method ?? 'GET'} ${caminho}`;
      chamadas.push(chave);

      const corpo = respostas.get(chave) ?? respostas.get(`${init?.method ?? 'GET'} *`);
      if (corpo === undefined) {
        return new Response(JSON.stringify({ error: 'Rota não encontrada.' }), { status: 404 });
      }
      if (corpo instanceof Error) {
        return new Response(JSON.stringify({ error: corpo.message }), { status: 500 });
      }
      if (typeof corpo === 'object' && corpo !== null && '__status' in corpo) {
        const { __status, ...resto } = corpo as { __status: number };
        return new Response(JSON.stringify(resto), { status: __status });
      }
      return new Response(JSON.stringify(corpo), { status: 200 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const DASHBOARD_VAZIO = {
  metricas: { agendamentosHoje: 3, confirmadosHoje: 2, canceladosHoje: 0, conversasNaoLidas: 5 },
  janelaProximosHoras: 4,
  proximosAgendamentos: [],
  conversasRecentes: [],
};

describe('Matriz de permissões da interface', () => {
  it('espelha a matriz RBAC do guia, papel por papel', () => {
    expect(pode('OWNER', 'ver_dashboard')).toBe(true);
    expect(pode('ADMIN', 'ver_dashboard')).toBe(true);
    expect(pode('ATENDENTE', 'ver_dashboard')).toBe(false);
    expect(pode('READ_ONLY', 'ver_dashboard')).toBe(false);

    // Read Only visualiza, mas não edita nada.
    expect(pode('READ_ONLY', 'ver_agenda')).toBe(true);
    expect(pode('READ_ONLY', 'editar_agenda')).toBe(false);
    expect(pode('READ_ONLY', 'ver_inbox')).toBe(true);
    expect(pode('READ_ONLY', 'atender_inbox')).toBe(false);

    expect(pode('ATENDENTE', 'editar_agenda')).toBe(true);
    expect(pode('ATENDENTE', 'atender_inbox')).toBe(true);
    expect(pode(undefined, 'ver_agenda')).toBe(false);
  });
});

describe('TELA 1 — Dashboard', () => {
  it('mostra métricas do dia para o Owner', async () => {
    respostas.set('GET /dashboard', DASHBOARD_VAZIO);
    renderizarComPapel('OWNER', <Dashboard aoIrPara={() => {}} />);

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByText('Agendamentos hoje')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('estado vazio aparece quando não há nada nas próximas 4h', async () => {
    respostas.set('GET /dashboard', DASHBOARD_VAZIO);
    renderizarComPapel('OWNER', <Dashboard aoIrPara={() => {}} />);

    expect(await screen.findByText('Nada nas próximas horas')).toBeInTheDocument();
  });

  it('estado de erro aparece e oferece nova tentativa', async () => {
    respostas.set('GET /dashboard', new Error('Erro interno.'));
    renderizarComPapel('OWNER', <Dashboard aoIrPara={() => {}} />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeInTheDocument();
  });

  it('Atendente não vê o dashboard — e a tela nem chama a API', async () => {
    renderizarComPapel('ATENDENTE', <Dashboard aoIrPara={() => {}} />);

    expect(await screen.findByText('Acesso não autorizado')).toBeInTheDocument();
    expect(chamadas).not.toContain('GET /dashboard');
  });
});

describe('TELA 2 — Agenda', () => {
  const AGENDA_COM_UM = {
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
  };

  beforeEach(() => {
    respostas.set('GET /agenda/profissionais', { profissionais: [{ id: 'p1', nome: 'Profissional Fictício' }] });
    respostas.set('GET /agenda/servicos', {
      servicos: [{ id: 's1', nome: 'Avaliação', categoria: 'consulta', duracaoMinutos: 60 }],
    });
    respostas.set('GET /clientes', { clientes: [{ id: 'c1', nome: 'Cliente Fictício' }] });
  });

  it('Atendente vê o formulário de novo agendamento e o botão de cancelar', async () => {
    respostas.set('GET /agenda/agendamentos', AGENDA_COM_UM);
    renderizarComPapel('ATENDENTE', <Agenda />);

    expect(await screen.findByRole('heading', { name: 'Novo agendamento' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeInTheDocument();
  });

  it('Read Only vê a agenda mas NÃO vê ação de criar nem de cancelar', async () => {
    respostas.set('GET /agenda/agendamentos', AGENDA_COM_UM);
    renderizarComPapel('READ_ONLY', <Agenda />);

    expect(await screen.findByText('Cliente Fictício')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Novo agendamento' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancelar' })).not.toBeInTheDocument();
  });

  it('conflito de horário mostra a mensagem do backend, não um erro genérico', async () => {
    respostas.set('GET /agenda/agendamentos', { agendamentos: [] });
    respostas.set('POST /agenda/agendamentos', {
      __status: 409,
      error: 'Horário indisponível para este profissional.',
    });
    renderizarComPapel('ATENDENTE', <Agenda />);

    const usuario = userEvent.setup();
    await screen.findByRole('heading', { name: 'Novo agendamento' });

    await usuario.selectOptions(await screen.findByLabelText('Cliente'), 'c1');
    await usuario.selectOptions(screen.getByLabelText('Profissional'), 'p1');
    await usuario.selectOptions(screen.getByLabelText('Serviço'), 's1');
    await usuario.type(screen.getByLabelText('Início'), '2026-09-20T13:00');
    await usuario.click(screen.getByRole('button', { name: 'Agendar' }));

    expect(
      await screen.findByText('Horário indisponível para este profissional.'),
    ).toBeInTheDocument();
  });

  it('estado vazio da agenda é explícito', async () => {
    respostas.set('GET /agenda/agendamentos', { agendamentos: [] });
    renderizarComPapel('READ_ONLY', <Agenda />);

    expect(await screen.findByText('Nenhum agendamento')).toBeInTheDocument();
  });
});

describe('TELA 3 — Inbox', () => {
  const CONVERSAS = {
    conversas: [
      {
        id: 'k1',
        canal: 'WHATSAPP',
        naoLidas: 2,
        ultimaMensagemEm: '2026-09-20T12:00:00.000Z',
        cliente: { id: 'c1', nome: 'Cliente Fictício' },
        ultimaMensagem: { conteudo: 'Olá', autor: 'CLIENTE' },
      },
    ],
  };

  const MENSAGENS = {
    conversa: { id: 'k1', cliente: { id: 'c1', nome: 'Cliente Fictício' } },
    mensagens: [
      {
        id: 'm1',
        autor: 'CLIENTE',
        conteudo: 'Quero remarcar',
        status: 'RECEBIDA',
        createdAt: '2026-09-20T12:00:00.000Z',
      },
      {
        id: 'm2',
        autor: 'AGENTE_IA',
        conteudo: 'Posso verificar horários livres.',
        status: 'SUGERIDA',
        createdAt: '2026-09-20T12:01:00.000Z',
      },
    ],
  };

  beforeEach(() => {
    respostas.set('GET /conversas', CONVERSAS);
    respostas.set('GET /conversas/k1/mensagens', MENSAGENS);
    respostas.set('PATCH /conversas/k1/lida', { naoLidas: 0 });
  });

  it('lista conversas com contador de não lidas', async () => {
    renderizarComPapel('ATENDENTE', <Inbox />);
    expect(await screen.findByText('Cliente Fictício')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('sugestão do agente é exibida com ação humana explícita — nunca enviada sozinha', async () => {
    renderizarComPapel('ATENDENTE', <Inbox />);
    const usuario = userEvent.setup();

    await usuario.click(await screen.findByRole('button', { name: /Cliente Fictício/ }));

    expect(await screen.findByText('Posso verificar horários livres.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar ao cliente' })).toBeInTheDocument();

    // Nada foi enviado só por abrir a conversa.
    expect(chamadas.filter((c) => c.includes('/sugestoes/'))).toHaveLength(0);
  });

  it('Read Only vê a sugestão mas NÃO vê botão de enviar/descartar nem campo de resposta', async () => {
    renderizarComPapel('READ_ONLY', <Inbox />);
    const usuario = userEvent.setup();

    await usuario.click(await screen.findByRole('button', { name: /Cliente Fictício/ }));

    expect(await screen.findByText('Posso verificar horários livres.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enviar ao cliente' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Descartar' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Mensagem')).not.toBeInTheDocument();

    // Read Only não pode editar: nem a marcação de lida é disparada.
    await waitFor(() => expect(chamadas).not.toContain('PATCH /conversas/k1/lida'));
  });

  it('conteúdo de mensagem é renderizado como texto, nunca como HTML', async () => {
    respostas.set('GET /conversas/k1/mensagens', {
      conversa: MENSAGENS.conversa,
      mensagens: [
        {
          id: 'm9',
          autor: 'CLIENTE',
          conteudo: '<img src=x onerror="alert(1)">',
          status: 'RECEBIDA',
          createdAt: '2026-09-20T12:00:00.000Z',
        },
      ],
    });

    const { container } = renderizarComPapel('ATENDENTE', <Inbox />);
    const usuario = userEvent.setup();
    await usuario.click(await screen.findByRole('button', { name: /Cliente Fictício/ }));

    expect(await screen.findByText('<img src=x onerror="alert(1)">')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });
});
