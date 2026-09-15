import { Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { SELECAO_AGENDAMENTO } from '../agenda/agenda.service';

/** Janela de "próximos agendamentos" do Prompt 3.1. */
const JANELA_PROXIMOS_HORAS = 4;

export async function obterDashboard(_req: Request, res: Response): Promise<void> {
  const agora = new Date();
  const inicioDoDia = new Date(agora);
  inicioDoDia.setHours(0, 0, 0, 0);
  const fimDoDia = new Date(inicioDoDia);
  fimDoDia.setDate(fimDoDia.getDate() + 1);
  const limiteProximos = new Date(agora.getTime() + JANELA_PROXIMOS_HORAS * 60 * 60 * 1000);

  const [agendamentosHoje, confirmadosHoje, canceladosHoje, conversasNaoLidas, proximos, conversasRecentes] =
    await Promise.all([
      prisma.agendamento.count({ where: { inicioEm: { gte: inicioDoDia, lt: fimDoDia } } }),
      prisma.agendamento.count({
        where: { inicioEm: { gte: inicioDoDia, lt: fimDoDia }, status: 'CONFIRMADO' },
      }),
      prisma.agendamento.count({
        where: { inicioEm: { gte: inicioDoDia, lt: fimDoDia }, status: 'CANCELADO' },
      }),
      prisma.conversa.count({ where: { naoLidas: { gt: 0 } } }),
      prisma.agendamento.findMany({
        where: {
          inicioEm: { gte: agora, lte: limiteProximos },
          status: { not: 'CANCELADO' },
        },
        select: SELECAO_AGENDAMENTO,
        orderBy: { inicioEm: 'asc' },
        take: 20,
      }),
      prisma.conversa.findMany({
        select: {
          id: true,
          naoLidas: true,
          ultimaMensagemEm: true,
          cliente: { select: { id: true, nome: true } },
        },
        orderBy: { ultimaMensagemEm: 'desc' },
        take: 5,
      }),
    ]);

  res.json({
    metricas: {
      agendamentosHoje,
      confirmadosHoje,
      canceladosHoje,
      conversasNaoLidas,
    },
    janelaProximosHoras: JANELA_PROXIMOS_HORAS,
    proximosAgendamentos: proximos,
    conversasRecentes,
  });
}
