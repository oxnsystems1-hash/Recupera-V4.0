import { prismaUnscoped } from '../lib/prisma';
import { registrarAuditoria } from '../lib/auditoria';
import { executarExclusaoDoTitular, obrigacaoLegalPendente } from '../modules/lgpd/lgpd.service';

/** Teto por execução, pelo mesmo motivo da varredura de retenção. */
const MAX_POR_EXECUCAO = 200;

/**
 * Executa as exclusões LGPD que ficaram bloqueadas por obrigação legal e
 * cujo prazo já venceu (Dia 5 / Prompt 2.2: "excluir automaticamente após
 * vencer o prazo"). É o outro lado do bloqueio: o titular não perde o
 * direito, ele só espera o prazo fiscal/contratual passar.
 *
 * Tarefa de sistema, cross-tenant, sem requisição HTTP por trás — mesma
 * exceção documentada em lib/prisma.ts.
 */
export async function runLgpdSweep(
  referenceDate: Date = new Date(),
): Promise<{ executadas: number; falhas: number }> {
  const vencidas = await prismaUnscoped.solicitacaoLgpd.findMany({
    where: {
      tipo: 'EXCLUSAO',
      status: 'BLOQUEADA',
      bloqueadoAteEm: { lt: referenceDate },
    },
    orderBy: { bloqueadoAteEm: 'asc' },
    take: MAX_POR_EXECUCAO,
  });

  let executadas = 0;
  let falhas = 0;

  for (const solicitacao of vencidas) {
    try {
      // Revalida antes de apagar: entre o bloqueio e o vencimento pode ter
      // surgido obrigação legal NOVA (outra nota fiscal do mesmo titular,
      // com prazo mais longo). Sem esta checagem, a varredura apagaria dado
      // sob guarda obrigatória — o erro que o Prompt 2.2 manda evitar dos
      // dois lados.
      const obrigacaoAtual = await obrigacaoLegalPendente(solicitacao.clienteId, prismaUnscoped);
      if (obrigacaoAtual && obrigacaoAtual.ateEm > referenceDate) {
        await prismaUnscoped.solicitacaoLgpd.update({
          where: { id: solicitacao.id },
          data: { motivoBloqueio: obrigacaoAtual.motivo, bloqueadoAteEm: obrigacaoAtual.ateEm },
        });
        await registrarAuditoria({
          acao: 'LGPD_EXCLUSAO_BLOQUEADA',
          entidade: 'Cliente',
          entidadeId: solicitacao.clienteId,
          tenantId: solicitacao.tenantId,
          detalhes: {
            solicitacaoId: solicitacao.id,
            motivo: obrigacaoAtual.motivo,
            bloqueadoAteEm: obrigacaoAtual.ateEm,
            reavaliada: true,
          },
        });
        continue;
      }

      const { arquivosRemovidos } = await executarExclusaoDoTitular(
        solicitacao.clienteId,
        prismaUnscoped,
      );

      await registrarAuditoria({
        acao: 'LGPD_EXCLUSAO_EXECUTADA',
        entidade: 'Cliente',
        entidadeId: solicitacao.clienteId,
        tenantId: solicitacao.tenantId,
        detalhes: {
          solicitacaoId: solicitacao.id,
          arquivosRemovidos,
          imediata: false,
          motivoBloqueioAnterior: solicitacao.motivoBloqueio,
        },
      });
      executadas += 1;
    } catch (error) {
      falhas += 1;
      console.error(`Falha ao executar exclusão LGPD ${solicitacao.id}:`, error);
    }
  }

  return { executadas, falhas };
}
