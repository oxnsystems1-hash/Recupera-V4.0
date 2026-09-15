import type { ReactNode } from 'react';
import { useSessao } from '../auth/sessao';
import { pode, type Acao } from '../auth/permissoes';
import { estiloBotaoSecundario } from './Estados';

export type Tela = 'dashboard' | 'agenda' | 'inbox';

const NAVEGACAO: Array<{ tela: Tela; rotulo: string; acao: Acao }> = [
  { tela: 'dashboard', rotulo: 'Dashboard', acao: 'ver_dashboard' },
  { tela: 'agenda', rotulo: 'Agenda', acao: 'ver_agenda' },
  { tela: 'inbox', rotulo: 'Inbox', acao: 'ver_inbox' },
];

export function Layout({
  telaAtual,
  aoNavegar,
  children,
}: {
  telaAtual: Tela;
  aoNavegar: (tela: Tela) => void;
  children: ReactNode;
}) {
  const { sessao, sair } = useSessao();
  const visiveis = NAVEGACAO.filter((item) => pode(sessao?.papel, item.acao));

  return (
    <div style={{ display: 'flex', minHeight: '100vh', flexWrap: 'wrap' }}>
      <a href="#conteudo" className="link-pular">
        Pular para o conteúdo
      </a>

      {/* Azul-Marinho como estrutura da sidebar (Referência Rápida 5). */}
      <nav
        aria-label="Navegação principal"
        style={{
          background: 'var(--estrutura)',
          color: '#fff',
          padding: '20px 14px',
          width: 220,
          flexShrink: 0,
        }}
      >
        <p style={{ fontWeight: 700, fontSize: '1.05rem', margin: '0 0 20px' }}>Recupera</p>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 4 }}>
          {visiveis.map((item) => {
            const ativo = item.tela === telaAtual;
            return (
              <li key={item.tela}>
                <button
                  type="button"
                  onClick={() => aoNavegar(item.tela)}
                  aria-current={ativo ? 'page' : undefined}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    // Marsala marca o item ativo — nunca dourado.
                    background: ativo ? 'var(--marsala)' : 'transparent',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 8,
                    padding: '10px 12px',
                    font: 'inherit',
                    fontWeight: ativo ? 600 : 400,
                    cursor: 'pointer',
                  }}
                >
                  {item.rotulo}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div style={{ flex: 1, minWidth: 320, display: 'flex', flexDirection: 'column' }}>
        <header
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            padding: '12px 20px',
            borderBottom: '1px solid var(--neutro)',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ color: 'var(--neutro-texto)', fontSize: 'var(--fs-secundario)' }}>
            {sessao?.email} · {sessao?.papel}
          </span>
          <button type="button" onClick={sair} style={estiloBotaoSecundario}>
            Sair
          </button>
        </header>

        <main id="conteudo" style={{ padding: 20, display: 'grid', gap: 16 }}>
          {children}
        </main>
      </div>
    </div>
  );
}
