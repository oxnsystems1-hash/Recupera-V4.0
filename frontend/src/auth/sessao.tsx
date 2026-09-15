import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { chamarApi, ErroApi, registrarTratadorDeExpiracao } from '../api/client';
import type { Papel } from './permissoes';

interface Sessao {
  token: string;
  papel: Papel;
  email: string;
}

interface ContextoSessao {
  sessao: Sessao | null;
  entrar: (email: string, senha: string) => Promise<ResultadoLogin>;
  concluirMfa: (challengeToken: string, codigo: string) => Promise<void>;
  sair: () => void;
}

export type ResultadoLogin =
  | { tipo: 'autenticado' }
  | { tipo: 'mfa_requerido'; challengeToken: string }
  | { tipo: 'mfa_setup'; setupToken: string };

const Contexto = createContext<ContextoSessao | null>(null);

interface RespostaLogin {
  accessToken?: string;
  mfaRequired?: boolean;
  challengeToken?: string;
  mfaSetupRequired?: boolean;
  setupToken?: string;
}

/** Lê o papel de dentro do JWT só para decidir o que renderizar. O papel
 *  que vale é o que o backend confere a cada requisição. */
function papelDoToken(token: string): Papel {
  try {
    const payload = JSON.parse(atob(token.split('.')[1] ?? '')) as { role?: string };
    return (payload.role as Papel) ?? 'READ_ONLY';
  } catch {
    return 'READ_ONLY';
  }
}

export function ProvedorSessao({ children }: { children: ReactNode }) {
  // Token em memória de propósito — ver comentário em api/client.ts.
  const [sessao, setSessao] = useState<Sessao | null>(null);
  const [emailPendente, setEmailPendente] = useState('');

  const aplicar = useCallback((token: string, email: string) => {
    setSessao({ token, papel: papelDoToken(token), email });
  }, []);

  const entrar = useCallback(
    async (email: string, senha: string): Promise<ResultadoLogin> => {
      const resposta = await chamarApi<RespostaLogin>('/auth/login', {
        metodo: 'POST',
        corpo: { email, senha },
      });
      setEmailPendente(email);

      if (resposta.accessToken) {
        aplicar(resposta.accessToken, email);
        return { tipo: 'autenticado' };
      }
      if (resposta.mfaRequired && resposta.challengeToken) {
        return { tipo: 'mfa_requerido', challengeToken: resposta.challengeToken };
      }
      if (resposta.mfaSetupRequired && resposta.setupToken) {
        return { tipo: 'mfa_setup', setupToken: resposta.setupToken };
      }
      throw new ErroApi(500, 'Resposta de login inesperada.');
    },
    [aplicar],
  );

  const concluirMfa = useCallback(
    async (challengeToken: string, codigo: string) => {
      const resposta = await chamarApi<RespostaLogin>('/auth/mfa/verify', {
        metodo: 'POST',
        corpo: { challengeToken, code: codigo },
      });
      if (!resposta.accessToken) throw new ErroApi(401, 'Código inválido.');
      aplicar(resposta.accessToken, emailPendente);
    },
    [aplicar, emailPendente],
  );

  const sair = useCallback(() => setSessao(null), []);

  // Qualquer 401 vindo da API derruba a sessão e devolve a pessoa ao login,
  // venha de qual tela vier.
  useEffect(() => {
    registrarTratadorDeExpiracao(() => setSessao(null));
    return () => registrarTratadorDeExpiracao(null);
  }, []);

  const valor = useMemo(
    () => ({ sessao, entrar, concluirMfa, sair }),
    [sessao, entrar, concluirMfa, sair],
  );

  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>;
}

export function useSessao(): ContextoSessao {
  const contexto = useContext(Contexto);
  if (!contexto) throw new Error('useSessao precisa estar dentro de <ProvedorSessao>.');
  return contexto;
}
