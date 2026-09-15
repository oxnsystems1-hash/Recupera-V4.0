import { useCallback, useEffect, useState } from 'react';
import { chamarApi, ErroApi } from '../api/client';
import { useSessao } from '../auth/sessao';
import { pode } from '../auth/permissoes';
import { Cartao, Carregando, ErroDeCarga, SemPermissao, Vazio } from '../componentes/Estados';

interface Agendamento {
  id: string;
  inicioEm: string;
  status: string;
  cliente: { id: string; nome: string };
  profissional: { id: string; nome: string };
  servico: { id: string; nome: string };
}

interface RespostaDashboard {
  metricas: {
    agendamentosHoje: number;
    confirmadosHoje: number;
    canceladosHoje: number;
    conversasNaoLidas: number;
  };
  janelaProximosHoras: number;
  proximosAgendamentos: Agendamento[];
  conversasRecentes: Array<{
    id: string;
    naoLidas: number;
    ultimaMensagemEm: string;
    cliente: { id: string; nome: string };
  }>;
}

function hora(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export function Dashboard({ aoIrPara }: { aoIrPara: (tela: 'agenda' | 'inbox') => void }) {
  const { sessao } = useSessao();
  const podeVer = pode(sessao?.papel, 'ver_dashboard');
  const [dados, setDados] = useState<RespostaDashboard | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);

  const carregar = useCallback(
    async (sinal?: AbortSignal) => {
      setCarregando(true);
      setErro(null);
      try {
        setDados(await chamarApi<RespostaDashboard>('/dashboard', { token: sessao?.token, sinal }));
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setErro(e instanceof ErroApi ? e.message : 'Não foi possível carregar o dashboard.');
      } finally {
        setCarregando(false);
      }
    },
    [sessao?.token],
  );

  useEffect(() => {
    // A checagem de permissão precede a busca: sem isto, a tela dispara uma
    // requisição que o backend vai recusar (403) e ainda pisca um estado de
    // erro antes de mostrar "acesso não autorizado".
    if (!podeVer) {
      setCarregando(false);
      return;
    }
    // AbortController evita atualizar estado de um componente já desmontado
    // e descarta resposta de requisição antiga que chegue fora de ordem.
    const controlador = new AbortController();
    void carregar(controlador.signal);
    return () => controlador.abort();
  }, [carregar, podeVer]);

  if (!podeVer) return <SemPermissao recurso="o dashboard" />;
  if (carregando) return <Carregando rotulo="Carregando dashboard…" />;
  if (erro) return <ErroDeCarga mensagem={erro} aoTentarDeNovo={() => void carregar()} />;
  if (!dados) return null;

  const metricas = [
    { rotulo: 'Agendamentos hoje', valor: dados.metricas.agendamentosHoje },
    { rotulo: 'Confirmados', valor: dados.metricas.confirmadosHoje },
    { rotulo: 'Cancelados', valor: dados.metricas.canceladosHoje },
    { rotulo: 'Conversas não lidas', valor: dados.metricas.conversasNaoLidas },
  ];

  return (
    <>
      <h1>Dashboard</h1>

      <section aria-label="Métricas do dia" className="grade-metricas">
        {metricas.map((m) => (
          <Cartao key={m.rotulo}>
            <p style={{ margin: 0, color: 'var(--neutro-texto)', fontSize: 'var(--fs-secundario)' }}>{m.rotulo}</p>
            {/* Marsala como destaque numérico — a cor de "faça isso"/identidade. */}
            <p style={{ margin: 0, fontSize: '1.9rem', fontWeight: 700, color: 'var(--marsala)' }}>
              {m.valor}
            </p>
          </Cartao>
        ))}
      </section>

      <Cartao titulo={`Próximos agendamentos (${dados.janelaProximosHoras}h)`}>
        {dados.proximosAgendamentos.length === 0 ? (
          <Vazio titulo="Nada nas próximas horas" descricao="Nenhum agendamento na janela." />
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            {dados.proximosAgendamentos.map((a) => (
              <li
                key={a.id}
                style={{
                  display: 'flex',
                  gap: 12,
                  alignItems: 'baseline',
                  borderBottom: '1px solid var(--neutro)',
                  paddingBottom: 8,
                  flexWrap: 'wrap',
                }}
              >
                <strong style={{ color: 'var(--estrutura)' }}>{hora(a.inicioEm)}</strong>
                <span>{a.cliente.nome}</span>
                <span style={{ color: 'var(--neutro-texto)', fontSize: 'var(--fs-secundario)' }}>
                  {a.servico.nome} · {a.profissional.nome}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Cartao>

      <Cartao titulo="Conversas recentes">
        {dados.conversasRecentes.length === 0 ? (
          <Vazio titulo="Sem conversas" descricao="Nenhuma conversa registrada ainda." />
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            {dados.conversasRecentes.map((c) => (
              <li key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span>{c.cliente.nome}</span>
                {c.naoLidas > 0 && (
                  // Azul-Vivo = "veja / saiba mais": notificação, não ação.
                  <span
                    style={{
                      background: 'var(--azul-vivo-escuro)',
                      color: '#fff',
                      borderRadius: 999,
                      padding: '1px 8px',
                      fontSize: 'var(--fs-secundario)',
                      fontWeight: 600,
                    }}
                  >
                    {c.naoLidas} não lidas
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Cartao>

      <section aria-label="Atalhos rápidos" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" onClick={() => aoIrPara('agenda')} style={atalho}>
          Ir para a agenda
        </button>
        <button type="button" onClick={() => aoIrPara('inbox')} style={atalho}>
          Ir para o inbox
        </button>
      </section>
    </>
  );
}

const atalho: React.CSSProperties = {
  background: 'transparent',
  color: 'var(--marsala)',
  border: '1px solid var(--marsala)',
  borderRadius: 8,
  padding: '8px 14px',
  font: 'inherit',
  fontWeight: 600,
  cursor: 'pointer',
};
