import { useCallback, useEffect, useRef, useState } from 'react';
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

interface Conversa {
  id: string;
  canal: string;
  naoLidas: number;
  ultimaMensagemEm: string;
  cliente: { id: string; nome: string };
  ultimaMensagem: { conteudo: string; autor: string } | null;
}

interface Mensagem {
  id: string;
  autor: 'CLIENTE' | 'ATENDENTE' | 'AGENTE_IA';
  conteudo: string;
  status: 'RECEBIDA' | 'ENVIADA' | 'SUGERIDA' | 'DESCARTADA';
  createdAt: string;
}

/** Mesmo teto de `MAX_MENSAGEM` em modules/inbox/inbox.controller.ts. */
const MAX_MENSAGEM = 4000;

/** Ações rápidas do Prompt 3.1: preenchem o campo, nunca enviam sozinhas. */
const RESPOSTAS_RAPIDAS = [
  'Bom dia! Como posso ajudar?',
  'Confirmado, até lá!',
  'Vou verificar e já retorno.',
];

export function Inbox() {
  const { sessao } = useSessao();
  const podeAtender = pode(sessao?.papel, 'atender_inbox');

  const [conversas, setConversas] = useState<Conversa[]>([]);
  const [selecionada, setSelecionada] = useState<string | null>(null);
  const [mensagens, setMensagens] = useState<Mensagem[]>([]);
  const [carregandoLista, setCarregandoLista] = useState(true);
  const [carregandoMensagens, setCarregandoMensagens] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  // Erro de conversa é separado do erro da lista: misturar os dois fazia a
  // lista inteira sumir quando só a abertura de uma conversa falhava — e o
  // "Tentar de novo" recarregava a coisa errada.
  const [erroConversa, setErroConversa] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [rascunho, setRascunho] = useState('');

  /**
   * Mesma proteção que a agenda já tinha: cada abertura recebe um número de
   * sequência. Clicar em duas conversas em sequência rápida faria a resposta
   * da PRIMEIRA chegar depois e pintar o histórico da conversa errada sob o
   * nome da segunda — dado de um cliente exibido como se fosse de outro.
   */
  const sequencia = useRef(0);

  const carregarConversas = useCallback(
    async (sinal?: AbortSignal) => {
      setCarregandoLista(true);
      setErro(null);
      try {
        const dados = await chamarApi<{ conversas: Conversa[] }>('/conversas', {
          token: sessao?.token,
          sinal,
        });
        setConversas(dados.conversas);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setErro(e instanceof ErroApi ? e.message : 'Não foi possível carregar as conversas.');
      } finally {
        setCarregandoLista(false);
      }
    },
    [sessao?.token],
  );

  useEffect(() => {
    const controlador = new AbortController();
    void carregarConversas(controlador.signal);
    return () => controlador.abort();
  }, [carregarConversas]);

  const abrir = useCallback(
    async (conversaId: string) => {
      const minhaSequencia = ++sequencia.current;
      setSelecionada(conversaId);
      setCarregandoMensagens(true);
      setAviso(null);
      setErroConversa(null);
      try {
        const dados = await chamarApi<{ mensagens: Mensagem[] }>(
          `/conversas/${conversaId}/mensagens`,
          { token: sessao?.token },
        );
        if (minhaSequencia !== sequencia.current) return; // resposta obsoleta
        setMensagens(dados.mensagens);

        // Marcar como lida é edição: Read Only não pode, e o backend recusa.
        if (podeAtender) {
          try {
            await chamarApi(`/conversas/${conversaId}/lida`, {
              metodo: 'PATCH',
              token: sessao?.token,
            });
            // Só zera o contador depois que o backend confirmou. Zerar antes
            // (otimista) fazia a tela afirmar "lida" quando o servidor havia
            // recusado — interface mentindo sobre o estado real.
            setConversas((atuais) =>
              atuais.map((c) => (c.id === conversaId ? { ...c, naoLidas: 0 } : c)),
            );
          } catch {
            setAviso('A conversa foi aberta, mas não foi possível marcá-la como lida.');
          }
        }
      } catch (e) {
        if (minhaSequencia !== sequencia.current) return;
        setErroConversa(e instanceof ErroApi ? e.message : 'Não foi possível abrir a conversa.');
      } finally {
        if (minhaSequencia === sequencia.current) setCarregandoMensagens(false);
      }
    },
    [sessao?.token, podeAtender],
  );

  async function agirNaSugestao(mensagemId: string, acao: 'enviar' | 'descartar') {
    if (!selecionada) return;
    setAviso(null);
    try {
      await chamarApi(`/conversas/${selecionada}/sugestoes/${mensagemId}/${acao}`, {
        metodo: 'POST',
        token: sessao?.token,
      });
      setAviso(acao === 'enviar' ? 'Sugestão enviada ao cliente.' : 'Sugestão descartada.');
      await abrir(selecionada);
    } catch (e) {
      setAviso(e instanceof ErroApi ? e.message : 'Não foi possível concluir a ação.');
    }
  }

  async function enviar(evento: React.FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    if (!selecionada) return;
    const conteudo = rascunho.trim();
    if (!conteudo) return;
    setAviso(null);
    try {
      await chamarApi(`/conversas/${selecionada}/mensagens`, {
        metodo: 'POST',
        token: sessao?.token,
        corpo: { conteudo },
      });
      // Só limpa o campo depois que o envio deu certo: em caso de erro, o
      // texto continua ali para o atendente tentar de novo.
      setRascunho('');
      await abrir(selecionada);
    } catch (e) {
      setAviso(e instanceof ErroApi ? e.message : 'Não foi possível enviar a mensagem.');
    }
  }

  if (!pode(sessao?.papel, 'ver_inbox')) return <SemPermissao recurso="o inbox" />;

  const sugestoesPendentes = mensagens.filter(
    (m) => m.autor === 'AGENTE_IA' && m.status === 'SUGERIDA',
  );
  const historico = mensagens.filter((m) => m.status === 'RECEBIDA' || m.status === 'ENVIADA');

  return (
    <>
      <h1>Inbox</h1>

      <div className="grade-inbox">
        <Cartao titulo="Conversas">
          {carregandoLista ? (
            <Carregando rotulo="Carregando conversas…" />
          ) : erro ? (
            <ErroDeCarga mensagem={erro} aoTentarDeNovo={() => void carregarConversas()} />
          ) : conversas.length === 0 ? (
            <Vazio titulo="Sem conversas" descricao="Nenhuma conversa neste tenant ainda." />
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 4 }}>
              {conversas.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => void abrir(c.id)}
                    aria-current={selecionada === c.id ? 'true' : undefined}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      background: selecionada === c.id ? 'var(--base-alt)' : 'transparent',
                      border: '1px solid var(--neutro)',
                      borderRadius: 8,
                      padding: 10,
                      font: 'inherit',
                      cursor: 'pointer',
                      display: 'grid',
                      gap: 2,
                    }}
                  >
                    <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <strong style={{ color: 'var(--estrutura)' }}>{c.cliente.nome}</strong>
                      {c.naoLidas > 0 && (
                        <span
                          style={{
                            background: 'var(--azul-vivo-escuro)',
                            color: '#fff',
                            borderRadius: 999,
                            padding: '0 8px',
                            fontSize: 'var(--fs-secundario)',
                            fontWeight: 600,
                          }}
                        >
                          {c.naoLidas}
                          <span className="visualmente-oculto"> mensagens não lidas</span>
                        </span>
                      )}
                    </span>
                    <span
                      style={{
                        color: 'var(--neutro-texto)',
                        fontSize: 'var(--fs-secundario)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {c.ultimaMensagem?.conteudo ?? 'Sem mensagens'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Cartao>

        <Cartao titulo="Histórico">
          {!selecionada ? (
            <Vazio titulo="Nenhuma conversa aberta" descricao="Escolha uma conversa à esquerda." />
          ) : carregandoMensagens ? (
            <Carregando rotulo="Carregando mensagens…" />
          ) : erroConversa ? (
            <ErroDeCarga mensagem={erroConversa} aoTentarDeNovo={() => void abrir(selecionada)} />
          ) : (
            <>
              {aviso && (
                <p role="status" aria-live="polite" style={{ marginTop: 0 }}>
                  {aviso}
                </p>
              )}

              {sugestoesPendentes.length > 0 && (
                <section
                  aria-label="Sugestões do agente de IA"
                  style={{
                    border: '1px solid var(--neutro)',
                    borderLeft: '4px solid var(--azul-vivo)',
                    borderRadius: 'var(--raio)',
                    padding: 12,
                    marginBottom: 12,
                    background: 'var(--base-alt)',
                  }}
                >
                  <h3 style={{ marginTop: 0 }}>Sugestões do agente</h3>
                  <p style={{ margin: '0 0 8px', fontSize: 'var(--fs-secundario)', color: 'var(--neutro-texto)' }}>
                    Exibidas para revisão. Nada é enviado ao cliente sem alguém aprovar.
                  </p>
                  {sugestoesPendentes.map((s) => (
                    <article key={s.id} style={{ display: 'grid', gap: 8, marginBottom: 8 }}>
                      {/* Conteúdo sempre como texto: React escapa por padrão e
                          nunca usamos dangerouslySetInnerHTML aqui. */}
                      <p style={{ margin: 0 }}>{s.conteudo}</p>
                      {podeAtender && (
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <button
                            type="button"
                            onClick={() => void agirNaSugestao(s.id, 'enviar')}
                            style={estiloBotaoPrimario}
                          >
                            Enviar ao cliente
                          </button>
                          <button
                            type="button"
                            onClick={() => void agirNaSugestao(s.id, 'descartar')}
                            style={estiloBotaoSecundario}
                          >
                            Descartar
                          </button>
                        </div>
                      )}
                    </article>
                  ))}
                </section>
              )}

              {historico.length === 0 ? (
                <Vazio titulo="Sem mensagens" descricao="Esta conversa ainda não tem histórico." />
              ) : (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
                  {historico.map((m) => (
                    <li
                      key={m.id}
                      style={{
                        justifySelf: m.autor === 'CLIENTE' ? 'start' : 'end',
                        maxWidth: '75%',
                        background: m.autor === 'CLIENTE' ? 'var(--base-alt)' : 'var(--estrutura)',
                        color: m.autor === 'CLIENTE' ? 'var(--texto)' : '#fff',
                        borderRadius: 10,
                        padding: '8px 12px',
                      }}
                    >
                      <span className="visualmente-oculto">
                        {m.autor === 'CLIENTE'
                          ? 'Cliente:'
                          : m.autor === 'AGENTE_IA'
                            ? 'Sugestão do agente aprovada por uma pessoa:'
                            : 'Atendimento:'}
                      </span>
                      <p style={{ margin: 0 }}>{m.conteudo}</p>
                      {/* Transparência: depois de aprovada, a mensagem do
                          agente segue identificada como tal no histórico —
                          não vira "texto do atendimento" sem origem. */}
                      {m.autor === 'AGENTE_IA' && (
                        <p
                          style={{
                            margin: '4px 0 0',
                            fontSize: 'var(--fs-secundario)',
                            opacity: 0.85,
                          }}
                        >
                          Sugestão do agente, aprovada por uma pessoa
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {podeAtender && (
                <>
                  <section
                    aria-label="Respostas rápidas"
                    style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}
                  >
                    {RESPOSTAS_RAPIDAS.map((texto) => (
                      <button
                        key={texto}
                        type="button"
                        onClick={() => setRascunho(texto)}
                        style={estiloBotaoSecundario}
                      >
                        {texto}
                      </button>
                    ))}
                  </section>

                  <form onSubmit={enviar} style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <label htmlFor="conteudo" className="visualmente-oculto">
                      Mensagem
                    </label>
                    <input
                      id="conteudo"
                      name="conteudo"
                      value={rascunho}
                      onChange={(e) => setRascunho(e.target.value)}
                      // Mesmo teto do backend (MAX_MENSAGEM): sem ele, o
                      // atendente escreve, envia e só então recebe um 400.
                      maxLength={MAX_MENSAGEM}
                      placeholder="Escreva uma mensagem…"
                      style={{
                        flex: 1,
                        padding: '10px 12px',
                        border: '1px solid var(--neutro)',
                        borderRadius: 8,
                        font: 'inherit',
                      }}
                    />
                    <button type="submit" style={estiloBotaoPrimario}>
                      Enviar
                    </button>
                  </form>
                </>
              )}
            </>
          )}
        </Cartao>
      </div>
    </>
  );
}
