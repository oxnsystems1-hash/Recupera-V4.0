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
/** Teto por execução: evita carregar um lote gigante na memória de uma vez. */
const MAX_POR_EXECUCAO = 500;

export async function runRetentionSweep(
  referenceDate: Date = new Date(),
): Promise<{ removidos: number; falhas: number }> {
  const vencidos = await prismaUnscoped.arquivo.findMany({
    where: { retentionUntil: { lt: referenceDate }, exclusaoBloqueada: false },
    orderBy: { retentionUntil: 'asc' },
    take: MAX_POR_EXECUCAO,
  });

  let removidos = 0;
  let falhas = 0;

  for (const arquivo of vencidos) {
    try {
      // Bytes primeiro: se a remoção do registro falhar depois, o arquivo
      // volta na próxima varredura (delete de storage é idempotente). A
      // ordem inversa deixaria bytes órfãos que ninguém mais encontra.
      await storage.delete(arquivo.storagePath);
      await prismaUnscoped.arquivo.delete({ where: { id: arquivo.id } });
      removidos += 1;
    } catch (error) {
      // Um arquivo problemático não pode abortar a varredura inteira — os
      // outros vencidos precisam sair mesmo assim (LGPD não espera o
      // próximo deploy).
      falhas += 1;
      console.error(`Falha ao excluir arquivo ${arquivo.id} na varredura de retenção:`, error);
    }
  }

  return { removidos, falhas };
}
