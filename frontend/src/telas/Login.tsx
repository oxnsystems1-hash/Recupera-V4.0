import { useState } from 'react';
import { useSessao } from '../auth/sessao';
import { ErroApi } from '../api/client';
import { Cartao, estiloBotaoPrimario } from '../componentes/Estados';

/** Owner e Admin têm MFA obrigatório (Dia 3): o login tem dois passos. */
export function Login() {
  const { entrar, concluirMfa } = useSessao();
  const [etapa, setEtapa] = useState<'credenciais' | 'mfa'>('credenciais');
  const [challengeToken, setChallengeToken] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function enviarCredenciais(evento: React.FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const form = new FormData(evento.currentTarget);
    setErro(null);
    setEnviando(true);
    try {
      const resultado = await entrar(String(form.get('email')), String(form.get('senha')));
      if (resultado.tipo === 'mfa_requerido') {
        setChallengeToken(resultado.challengeToken);
        setEtapa('mfa');
      } else if (resultado.tipo === 'mfa_setup') {
        setErro('Este usuário precisa concluir a configuração de MFA antes de acessar.');
      }
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Não foi possível entrar.');
    } finally {
      setEnviando(false);
    }
  }

  async function enviarCodigo(evento: React.FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const codigo = String(new FormData(evento.currentTarget).get('codigo'));
    setErro(null);
    setEnviando(true);
    try {
      await concluirMfa(challengeToken, codigo);
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Código inválido.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 380 }}>
        <Cartao titulo={etapa === 'credenciais' ? 'Entrar na Recupera' : 'Verificação em duas etapas'}>
          {etapa === 'credenciais' ? (
            <form onSubmit={enviarCredenciais} style={{ display: 'grid', gap: 12 }}>
              <label style={{ display: 'grid', gap: 4 }}>
                E-mail
                <input name="email" type="email" required autoComplete="username" style={campo} />
              </label>
              <label style={{ display: 'grid', gap: 4 }}>
                Senha
                <input
                  name="senha"
                  type="password"
                  required
                  autoComplete="current-password"
                  style={campo}
                />
              </label>
              <button type="submit" disabled={enviando} style={estiloBotaoPrimario}>
                {enviando ? 'Entrando…' : 'Entrar'}
              </button>
            </form>
          ) : (
            <form onSubmit={enviarCodigo} style={{ display: 'grid', gap: 12 }}>
              <label style={{ display: 'grid', gap: 4 }}>
                Código do autenticador
                <input
                  name="codigo"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  style={campo}
                />
              </label>
              <button type="submit" disabled={enviando} style={estiloBotaoPrimario}>
                {enviando ? 'Verificando…' : 'Verificar'}
              </button>
            </form>
          )}

          {erro && (
            <p role="alert" style={{ color: 'var(--marsala-escuro)', marginBottom: 0 }}>
              {erro}
            </p>
          )}
        </Cartao>
      </div>
    </main>
  );
}

const campo: React.CSSProperties = {
  padding: '10px 12px',
  border: '1px solid var(--neutro)',
  borderRadius: 8,
  font: 'inherit',
};
