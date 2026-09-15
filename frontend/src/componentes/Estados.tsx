import type { ReactNode } from 'react';

/**
 * Estados que toda tela que busca dado precisa tratar. O "caminho feliz"
 * sozinho é o que produz tela em branco quando a API cai ou a conta é nova.
 */

export function Carregando({ rotulo }: { rotulo: string }) {
  return (
    <div role="status" aria-live="polite" style={{ padding: 24, color: 'var(--neutro-texto)' }}>
      {rotulo}
    </div>
  );
}

export function ErroDeCarga({ mensagem, aoTentarDeNovo }: { mensagem: string; aoTentarDeNovo?: () => void }) {
  return (
    <div
      role="alert"
      style={{
        padding: 16,
        border: '1px solid var(--neutro)',
        borderLeft: '4px solid var(--marsala)',
        borderRadius: 'var(--raio)',
        background: 'var(--base)',
      }}
    >
      <p style={{ margin: '0 0 8px' }}>{mensagem}</p>
      {aoTentarDeNovo && (
        <button type="button" onClick={aoTentarDeNovo} style={estiloBotaoSecundario}>
          Tentar de novo
        </button>
      )}
    </div>
  );
}

export function Vazio({ titulo, descricao }: { titulo: string; descricao: string }) {
  return (
    <div
      style={{
        padding: 24,
        textAlign: 'center',
        color: 'var(--neutro-texto)',
        border: '1px dashed var(--neutro)',
        borderRadius: 'var(--raio)',
      }}
    >
      <p style={{ margin: '0 0 4px', color: 'var(--estrutura)', fontWeight: 600 }}>{titulo}</p>
      <p style={{ margin: 0 }}>{descricao}</p>
    </div>
  );
}

export function SemPermissao({ recurso }: { recurso: string }) {
  return (
    <div role="alert" style={{ padding: 24 }}>
      <h2>Acesso não autorizado</h2>
      <p style={{ color: 'var(--neutro-texto)' }}>
        Seu papel não permite acessar {recurso}. Fale com o responsável pela conta.
      </p>
    </div>
  );
}

export function Cartao({ children, titulo }: { children: ReactNode; titulo?: string }) {
  return (
    <section
      style={{
        background: 'var(--base)',
        border: '1px solid var(--neutro)',
        borderRadius: 'var(--raio)',
        boxShadow: 'var(--sombra)',
        padding: 16,
      }}
    >
      {titulo && <h2>{titulo}</h2>}
      {children}
    </section>
  );
}

export const estiloBotaoPrimario: React.CSSProperties = {
  background: 'var(--marsala)',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  padding: '10px 16px',
  fontFamily: 'inherit',
  fontSize: '1rem',
  fontWeight: 600,
  cursor: 'pointer',
};

export const estiloBotaoSecundario: React.CSSProperties = {
  background: 'transparent',
  color: 'var(--estrutura)',
  border: '1px solid var(--neutro)',
  borderRadius: 8,
  padding: '8px 14px',
  fontFamily: 'inherit',
  fontSize: 'var(--fs-secundario)',
  cursor: 'pointer',
};
