/**
 * Cliente HTTP da API.
 *
 * Duas decisões de segurança concentradas aqui:
 *
 * 1. O access token vive só em memória (ver auth/sessao.ts). Não vai para
 *    localStorage: qualquer XSS leria de lá trivialmente. O custo é precisar
 *    reautenticar ao recarregar a página — aceito conscientemente no MVP.
 *    Cookie httpOnly + CSRF é o próximo passo (Dia 14, infraestrutura).
 *
 * 2. A mensagem exibida vem do campo `error` da API — que é, por contrato do
 *    backend, texto curto para humano ("Horário indisponível para este
 *    profissional."), nunca stack trace nem detalhe interno; o
 *    `errorHandler` do servidor é quem garante isso. Quando o corpo não traz
 *    esse campo (500 sem corpo, HTML de proxy, resposta ilegível), a tela
 *    mostra um texto genérico em vez de imprimir o que vier.
 */
export const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3000';

/**
 * Sessão expirada (401) é evento global, não problema de uma tela: o token
 * de acesso vale 8h e pode vencer no meio de qualquer requisição. Sem este
 * gancho, a tela onde o 401 caiu mostraria "erro ao carregar" e o usuário
 * ficaria preso numa interface que não funciona mais. O provedor de sessão
 * registra aqui o que fazer (derrubar a sessão e voltar ao login).
 */
type TratadorDeExpiracao = () => void;
let aoExpirar: TratadorDeExpiracao | null = null;

export function registrarTratadorDeExpiracao(tratador: TratadorDeExpiracao | null): void {
  aoExpirar = tratador;
}

export class ErroApi extends Error {
  constructor(
    readonly status: number,
    mensagem: string,
  ) {
    super(mensagem);
  }

  /** Falta de permissão: a tela trata diferente de um erro genérico. */
  get semPermissao(): boolean {
    return this.status === 403;
  }

  get naoAutenticado(): boolean {
    return this.status === 401;
  }
}

type Opcoes = {
  metodo?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  corpo?: unknown;
  token?: string | null;
  sinal?: AbortSignal;
};

export async function chamarApi<T>(caminho: string, opcoes: Opcoes = {}): Promise<T> {
  const { metodo = 'GET', corpo, token, sinal } = opcoes;

  const resposta = await fetch(`${API_BASE}${caminho}`, {
    method: metodo,
    headers: {
      ...(corpo !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
    signal: sinal,
  });

  if (resposta.status === 204) return undefined as T;

  const dados = await resposta.json().catch(() => ({}));

  if (!resposta.ok) {
    if (resposta.status === 401) aoExpirar?.();
    const mensagem =
      typeof (dados as { error?: unknown }).error === 'string'
        ? (dados as { error: string }).error
        : 'Não foi possível concluir a operação.';
    throw new ErroApi(resposta.status, mensagem);
  }

  return dados as T;
}
