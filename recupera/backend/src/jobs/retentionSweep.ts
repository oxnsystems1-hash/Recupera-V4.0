import { prismaUnscoped } from '../lib/prisma';
import { storage } from '../lib/storage/localFilesystemStorage';

/**
 * Varredura de retenção (Dia 4 / Prompt 2.1, bullet RETENÇÃO): exclusão
 * real (bytes + registro) de todo arquivo cujo prazo de retenção já
 * venceu, exceto os com bloqueio legal ativo (exclusaoBloqueada) — que
 * respeitam o prazo legal em vez do prazo de retenção padrão.
 *
 * É uma tarefa de sistema, cross-tenant por natureza (varre todos os
 * tenants de uma vez, sem uma requisição HTTP autenticada por trás) —
 * mesma exceção documentada em lib/prisma.ts para login/refresh: usa
 * prismaUnscoped diretamente.
 *
 * "Cron automático" aqui é um setInterval no processo (ver server.ts),
 * suficiente para o MVP; um scheduler externo com monitoramento real é
 * decisão de infraestrutura do Dia 14, fora de escopo do Dia 4.
 */
export async function runRetentionSweep(
  referenceDate: Date = new Date(),
): Promise<{ removidos: number }> {
  const vencidos = await prismaUnscoped.arquivo.findMany({
    where: { retentionUntil: { lt: referenceDate }, exclusaoBloqueada: false },
  });

  for (const arquivo of vencidos) {
    await storage.delete(arquivo.storagePath);
    await prismaUnscoped.arquivo.delete({ where: { id: arquivo.id } });
  }

  return { removidos: vencidos.length };
}
