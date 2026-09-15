/**
 * Espelho das permissões do backend, usado APENAS para decidir o que a
 * interface mostra.
 *
 * Isto não é controle de acesso — é ergonomia: não faz sentido oferecer um
 * botão que a API vai recusar. A checagem que vale é a do backend
 * (`middleware/requireRole.ts`), e os testes provam que ela recusa a
 * chamada mesmo quando o botão é forjado ou a API é chamada direto.
 *
 * Esconder no frontend sem recusar no backend seria exatamente o que a
 * especificação proíbe ("escondido apenas no frontend não conta como
 * controle de acesso").
 */
export type Papel = 'OWNER' | 'ADMIN' | 'ATENDENTE' | 'READ_ONLY';

export type Acao =
  | 'ver_dashboard'
  | 'ver_agenda'
  | 'editar_agenda'
  | 'ver_inbox'
  | 'atender_inbox';

const MATRIZ: Record<Acao, readonly Papel[]> = {
  // Dashboard consolida o tenant inteiro: Owner/Admin (Prompt 3.1).
  ver_dashboard: ['OWNER', 'ADMIN'],
  // "Read Only: visualizar agendamentos e conversas" (Referência Rápida 2).
  ver_agenda: ['OWNER', 'ADMIN', 'ATENDENTE', 'READ_ONLY'],
  // "Atendente: criar/editar agendamentos"; Read Only não edita nada.
  editar_agenda: ['OWNER', 'ADMIN', 'ATENDENTE'],
  ver_inbox: ['OWNER', 'ADMIN', 'ATENDENTE', 'READ_ONLY'],
  atender_inbox: ['OWNER', 'ADMIN', 'ATENDENTE'],
};

export function pode(papel: Papel | undefined, acao: Acao): boolean {
  if (!papel) return false;
  return MATRIZ[acao].includes(papel);
}
