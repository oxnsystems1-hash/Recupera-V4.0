import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chamarApi, ErroApi } from '../api/client';
import { useSessao } from '../auth/sessao';
import { pode } from '../auth/permissoes';
import {
  Cartao,
  Carregando,
  ErroDeCarga,
  SemPermissao,
  Vazio,
  estiloBotaoPrimario,
  estiloBotaoSecundario,
} from '../componentes/Estados';

type Visao = 'mes' | 'semana' | 'dia';

interface Agendamento {
  id: string;
  inicioEm: string;
  fimEm: string;
  status: string;
  cliente: { id: string; nome: string };
  profissional: { id: string; nome: string };
  servico: { id: string; nome: string; categoria: string };
}

interface Ocupacao { inicioEm: string; fimEm: string }
interface Profissional { id: string; nome: string }
interface Servico { id: string; nome: string; categoria: string; duracaoMinutos: number }
interface Cliente { id: string; nome: string }

function inicioDaVisao(referencia: Date, visao: Visao): Date {
  const data = new Date(referencia);
  data.setHours(0, 0, 0, 0);
  if (visao === 'mes') data.setDate(1);
  if (visao === 'semana') data.setDate(data.getDate() - data.getDay());
  return data;
}

function fimDaVisao(inicio: Date, visao: Visao): Date {
  const data = new Date(inicio);
  if (visao === 'mes') data.setMonth(data.getMonth() + 1);
  if (visao === 'semana') data.setDate(data.getDate() + 7);
  if (visao === 'dia') data.setDate(data.getDate() + 1);
  return data;
}

function formatarDiaHora(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function Agenda() {
  const { sessao } = useSessao();
  const podeEditar = pode(sessao?.papel, 'editar_agenda');

  const [visao, setVisao] = useState<Visao>('semana');
  const [referencia, setReferencia] = useState(() => new Date());
  const [profissionalId, setProfissionalId] = useState('');
  const [categoria, setCategoria] = useState('');

  const [agendamentos, setAgendamentos] = useState<Agendamento[]>([]);
  const [profissionais, setProfissionais] = useState<Profissional[]>([]);
  const [servicos, setServicos] = useState<Servico[]>([]);
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [ocupacao, setOcupacao] = useState<Ocupacao[] | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  // Cancelamento pede motivo num formulário de verdade — ver comentário em
  // `cancelar`.
  const [cancelando, setCancelando] = useState<string | null>(null);
  const [motivo, setMotivo] = useState('');

  const intervalo = useMemo(() => {
    const de = inicioDaVisao(referencia, visao);
    return { de, ate: fimDaVisao(de, visao) };
  }, [referencia, visao]);

  /**
   * Toda carga recebe um número de sequência. Sem isso, trocar de visão
   * rápido (semana → dia → mês) pode fazer a resposta da requisição ANTIGA
   * chegar depois e sobrescrever a nova — o calendário mostraria um período
   * que o usuário não está mais olhando.
   */
  const sequencia = useRef(0);

  const carregar = useCallback(
    async (sinal?: AbortSignal) => {
      const minhaSequencia = ++sequencia.current;
      setCarregando(true);
      setErro(null);
      try {
        const busca = new URLSearchParams({
          de: intervalo.de.toISOString(),
          ate: intervalo.ate.toISOString(),
        });
        if (profissionalId) busca.set('profissionalId', profissionalId);
        if (categoria) busca.set('categoria', categoria);

        const dados = await chamarApi<{ agendamentos: Agendamento[] }>(
          `/agenda/agendamentos?${busca}`,
          { token: sessao?.token, sinal },
        );
        if (minhaSequencia !== sequencia.current) return; // resposta obsoleta
        setAgendamentos(dados.agendamentos);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        if (minhaSequencia !== sequencia.current) return;
        setErro(e instanceof ErroApi ? e.message : 'Não foi possível carregar a agenda.');
      } finally {
        if (minhaSequencia === sequencia.current) setCarregando(false);
      }
    },
    [intervalo, profissionalId, categoria, sessao?.token],
  );

  useEffect(() => {
    const controlador = new AbortController();
    void carregar(controlador.signal);
    return () => controlador.abort();
  }, [carregar]);

  useEffect(() => {
    const controlador = new AbortController();
    const opcoes = { token: sessao?.token, sinal: controlador.signal };
    void Promise.all([
      chamarApi<{ profissionais: Profissional[] }>('/agenda/profissionais', opcoes),
      chamarApi<{ servicos: Servico[] }>('/agenda/servicos', opcoes),
      podeEditar
        // `resumo=1`: a tela precisa de id + nome para um <select>. Puxar o
        // cadastro inteiro (telefone, e-mail, endereço de todos os clientes)
        // para desenhar uma lista de nomes seria dado pessoal no navegador
        // sem finalidade — ver clientes.repository.ts.
        ? chamarApi<{ clientes: Cliente[] }>('/clientes?resumo=1', opcoes)
        : Promise.resolve({ clientes: [] as Cliente[] }),
    ])
      .then(([p, s, c]) => {
        setProfissionais(p.profissionais);
        setServicos(s.servicos);
        setClientes(c.clientes);
      })
      .catch(() => {
        /* filtros indisponíveis não impedem ver a agenda */
      });
    return () => controlador.abort();
  }, [sessao?.token, podeEditar]);

  /**
   * Disponibilidade por profissional (Prompt 3.1). Só faz sentido com UM
   * profissional escolhido — "quem está livre" é pergunta sobre uma agenda,
   * não sobre a soma de todas.
   */
  useEffect(() => {
    if (!profissionalId) {
      setOcupacao(null);
      return;
    }
    const controlador = new AbortController();
    const busca = new URLSearchParams({
      profissionalId,
      de: intervalo.de.toISOString(),
      ate: intervalo.ate.toISOString(),
    });
    chamarApi<{ ocupado: Ocupacao[] }>(`/agenda/disponibilidade?${busca}`, {
      token: sessao?.token,
      sinal: controlador.signal,
    })
      .then((dados) => setOcupacao(dados.ocupado))
      .catch(() => setOcupacao(null));
    return () => controlador.abort();
  }, [profissionalId, intervalo, sessao?.token]);

  const categorias = useMemo(
    () => [...new Set(servicos.map((s) => s.categoria))].sort(),
    [servicos],
  );

  async function criar(evento: React.FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    // O elemento precisa ser guardado ANTES do await: o React zera
    // `evento.currentTarget` ao fim do despacho do evento, então
    // `evento.currentTarget.reset()` depois do await estoura TypeError —
    // o agendamento é criado e a tela diz que falhou.
    const elemento = evento.currentTarget;
    const form = new FormData(elemento);
    setAviso(null);
    try {
      await chamarApi('/agenda/agendamentos', {
        metodo: 'POST',
        token: sessao?.token,
        corpo: {
          clienteId: form.get('clienteId'),
          profissionalId: form.get('profissionalId'),
          servicoId: form.get('servicoId'),
          inicioEm: new Date(String(form.get('inicioEm'))).toISOString(),
        },
      });
      elemento.reset();
      setAviso('Agendamento criado.');
      await carregar();
    } catch (e) {
      // 409 aqui é o banco recusando double-booking — a mensagem precisa
      // dizer isso, não um "erro genérico" que leva o atendente a tentar
      // de novo no mesmo horário.
      setAviso(e instanceof ErroApi ? e.message : 'Não foi possível criar o agendamento.');
    }
  }

  /**
   * `window.prompt` resolvia isto em uma linha e estava errado: não é
   * anunciado por leitor de tela como formulário, não aceita rótulo, não
   * respeita a paleta e é bloqueado por navegador em várias situações. O
   * motivo é obrigatório no backend, então precisa ser um campo de verdade.
   */
  async function confirmarCancelamento(evento: React.FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const id = cancelando;
    const texto = motivo.trim();
    if (!id || !texto) return;
    setAviso(null);
    try {
      await chamarApi(`/agenda/agendamentos/${id}/cancelar`, {
        metodo: 'POST',
        token: sessao?.token,
        corpo: { motivo: texto },
      });
      setCancelando(null);
      setMotivo('');
      setAviso('Agendamento cancelado.');
      await carregar();
    } catch (e) {
      setAviso(e instanceof ErroApi ? e.message : 'Não foi possível cancelar.');
    }
  }

  if (!pode(sessao?.papel, 'ver_agenda')) return <SemPermissao recurso="a agenda" />;

  return (
    <>
      <h1>Agenda</h1>

      <Cartao>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
          <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
            <legend className="visualmente-oculto">Visão do calendário</legend>
            <div role="group" style={{ display: 'flex', gap: 4 }}>
              {(['mes', 'semana', 'dia'] as Visao[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setVisao(v)}
                  aria-pressed={visao === v}
                  style={visao === v ? estiloBotaoPrimario : estiloBotaoSecundario}
                >
                  {v === 'mes' ? 'Mensal' : v === 'semana' ? 'Semanal' : 'Diária'}
                </button>
              ))}
            </div>
          </fieldset>

          <label style={rotulo}>
            Filtrar por profissional
            <select
              value={profissionalId}
              onChange={(e) => setProfissionalId(e.target.value)}
              style={campo}
            >
              <option value="">Todos</option>
              {profissionais.map((p) => (
                <option key={p.id} value={p.id}>{p.nome}</option>
              ))}
            </select>
          </label>

          <label style={rotulo}>
            Segmento de serviço
            <select value={categoria} onChange={(e) => setCategoria(e.target.value)} style={campo}>
              <option value="">Todos</option>
              {categorias.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={() => setReferencia(new Date())}
            style={estiloBotaoSecundario}
          >
            Hoje
          </button>
        </div>
      </Cartao>

      {podeEditar && (
        <Cartao titulo="Novo agendamento">
          <form onSubmit={criar} className="grade-formulario">
            <label style={rotulo}>
              Cliente
              <select name="clienteId" required style={campo}>
                <option value="">Selecione</option>
                {clientes.map((c) => (
                  <option key={c.id} value={c.id}>{c.nome}</option>
                ))}
              </select>
            </label>
            <label style={rotulo}>
              Profissional
              <select name="profissionalId" required style={campo}>
                <option value="">Selecione</option>
                {profissionais.map((p) => (
                  <option key={p.id} value={p.id}>{p.nome}</option>
                ))}
              </select>
            </label>
            <label style={rotulo}>
              Serviço
              <select name="servicoId" required style={campo}>
                <option value="">Selecione</option>
                {servicos.map((s) => (
                  <option key={s.id} value={s.id}>{s.nome} ({s.duracaoMinutos}min)</option>
                ))}
              </select>
            </label>
            <label style={rotulo}>
              Início
              <input type="datetime-local" name="inicioEm" required style={campo} />
            </label>
            <button type="submit" style={{ ...estiloBotaoPrimario, alignSelf: 'end' }}>
              Agendar
            </button>
          </form>
        </Cartao>
      )}

      {profissionalId && (
        <Cartao titulo="Disponibilidade do profissional no período">
          {ocupacao === null ? (
            <Carregando rotulo="Carregando disponibilidade…" />
          ) : ocupacao.length === 0 ? (
            <Vazio
              titulo="Agenda livre"
              descricao="Nenhum horário ocupado para este profissional no período."
            />
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 4 }}>
              {ocupacao.map((o) => (
                <li key={`${o.inicioEm}-${o.fimEm}`}>
                  {/* Só faixa ocupada: a grade de horário não precisa saber
                      de quem é o agendamento para desenhar "ocupado". */}
                  Ocupado: {formatarDiaHora(o.inicioEm)} — {formatarDiaHora(o.fimEm)}
                </li>
              ))}
            </ul>
          )}
        </Cartao>
      )}

      {aviso && (
        <p role="status" aria-live="polite" style={{ color: 'var(--estrutura)', margin: 0 }}>
          {aviso}
        </p>
      )}

      <Cartao titulo={`${agendamentos.length} agendamento(s) no período`}>
        {carregando ? (
          <Carregando rotulo="Carregando agenda…" />
        ) : erro ? (
          <ErroDeCarga mensagem={erro} aoTentarDeNovo={() => void carregar()} />
        ) : agendamentos.length === 0 ? (
          <Vazio titulo="Nenhum agendamento" descricao="Nada marcado para este período e filtro." />
        ) : (
          <div className="rolagem-horizontal">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <caption className="visualmente-oculto">Agendamentos do período selecionado</caption>
            <thead>
              <tr>
                {/* A coluna "Ações" não existe para quem não tem ação: um
                    <th> vazio é anunciado como cabeçalho sem nome. */}
                {['Quando', 'Cliente', 'Serviço', 'Profissional', 'Status', ...(podeEditar ? ['Ações'] : [])].map((h) => (
                  <th
                    key={h}
                    scope="col"
                    style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid var(--neutro)', fontSize: 'var(--fs-secundario)', color: 'var(--neutro-texto)' }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {agendamentos.map((a) => (
                <tr key={a.id}>
                  <td style={celula}>{formatarDiaHora(a.inicioEm)}</td>
                  <td style={celula}>{a.cliente.nome}</td>
                  <td style={celula}>{a.servico.nome}</td>
                  <td style={celula}>{a.profissional.nome}</td>
                  <td style={celula}>
                    <span
                      style={{
                        color: a.status === 'CANCELADO' ? 'var(--neutro-texto)' : 'var(--oliva-escuro)',
                        fontWeight: 600,
                        fontSize: 'var(--fs-secundario)',
                      }}
                    >
                      {a.status}
                    </span>
                  </td>
                  {/* A coluna some para quem não pode editar — e o backend
                      recusa a mesma chamada via API direta (403). */}
                  {podeEditar && (
                    <td style={celula}>
                      {a.status !== 'CANCELADO' && cancelando !== a.id && (
                        <button
                          type="button"
                          onClick={() => {
                            setCancelando(a.id);
                            setMotivo('');
                          }}
                          style={estiloBotaoSecundario}
                        >
                          Cancelar
                        </button>
                      )}
                      {cancelando === a.id && (
                        <form
                          onSubmit={confirmarCancelamento}
                          style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}
                        >
                          <label style={rotulo}>
                            Motivo do cancelamento
                            <input
                              name="motivo"
                              value={motivo}
                              onChange={(e) => setMotivo(e.target.value)}
                              required
                              maxLength={300}
                              autoFocus
                              style={campo}
                            />
                          </label>
                          <button type="submit" style={estiloBotaoPrimario}>
                            Confirmar
                          </button>
                          <button
                            type="button"
                            onClick={() => setCancelando(null)}
                            style={estiloBotaoSecundario}
                          >
                            Voltar
                          </button>
                        </form>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </Cartao>
    </>
  );
}

const rotulo: React.CSSProperties = {
  display: 'grid',
  gap: 4,
  fontSize: 'var(--fs-secundario)',
  color: 'var(--neutro-texto)',
};

const campo: React.CSSProperties = {
  padding: '8px 10px',
  border: '1px solid var(--neutro)',
  borderRadius: 8,
  font: 'inherit',
  color: 'var(--texto)',
  background: '#fff',
};

const celula: React.CSSProperties = {
  padding: 8,
  borderBottom: '1px solid var(--neutro)',
  fontSize: 'var(--fs-secundario)',
};
