import { Prisma } from '@prisma/client';
import { prismaUnscoped } from './prisma';
import { sanitizarParaAuditoria } from './mascarar';
import { getAuthContextOpcional } from './tenantContext';

/**
 * Ações sensíveis auditadas. Lista fechada de propósito: um `string` solto
 * viraria dezenas de variações da mesma ação e tornaria o painel de
 * auditoria inútil para investigar um incidente.
 */
export type AcaoAuditada =
  | 'LOGIN_SUCESSO'
  | 'LOGIN_FALHA'
  | 'LOGOUT'
  | 'MFA_HABILITADO'
  | 'SESSAO_REUSO_DETECTADO'
  | 'USUARIO_CRIADO'
  | 'USUARIO_PAPEL_ALTERADO'
  | 'USUARIO_DESATIVADO'
  | 'CLIENTE_CRIADO'
  | 'CLIENTE_EXCLUIDO'
  | 'ARQUIVO_ENVIADO'
  | 'ARQUIVO_URL_GERADA'
  | 'ARQUIVO_EXCLUIDO'
  | 'ARQUIVO_BLOQUEIO_ALTERADO'
  | 'LGPD_EXPORTACAO'
  | 'LGPD_CORRECAO_SOLICITADA'
  | 'LGPD_CORRECAO_CONFIRMADA'
  | 'LGPD_EXCLUSAO_SOLICITADA'
  | 'LGPD_EXCLUSAO_APROVADA'
  | 'LGPD_EXCLUSAO_BLOQUEADA'
  | 'LGPD_EXCLUSAO_EXECUTADA';

interface EventoAuditoria {
  acao: AcaoAuditada;
  entidade: string;
  entidadeId?: string | null;
  detalhes?: unknown;
  /** Só para eventos fora de requisição autenticada (jobs, login). */
  tenantId?: string | null;
  userId?: string | null;
  ip?: string | null;
}

/**
 * Grava um evento de auditoria. Sempre via prismaUnscoped: parte dos
 * eventos acontece antes de existir tenant no contexto (login que falhou)
 * ou fora de requisição HTTP (varredura automática), e o tenant é
 * resolvido explicitamente aqui.
 *
 * Nunca lança: auditoria quebrada não pode derrubar a operação que estava
 * sendo auditada. A falha vai para o log do processo, que é o sinal para
 * investigar — engolir em silêncio seria pior que o erro original.
 */
export async function registrarAuditoria(evento: EventoAuditoria): Promise<void> {
  try {
    const contexto = getAuthContextOpcional();
    const detalhes = sanitizarParaAuditoria(evento.detalhes);

    await prismaUnscoped.logAuditoria.create({
      data: {
        tenantId: evento.tenantId ?? contexto?.tenantId ?? null,
        userId: evento.userId ?? contexto?.userId ?? null,
        acao: evento.acao,
        entidade: evento.entidade,
        entidadeId: evento.entidadeId ?? null,
        detalhes: (detalhes ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        ip: evento.ip ?? null,
      },
    });
  } catch (error) {
    console.error('Falha ao gravar log de auditoria:', { acao: evento.acao }, error);
  }
}
