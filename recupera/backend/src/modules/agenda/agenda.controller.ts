import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { registrarAuditoria } from '../../lib/auditoria';
import { isRecordNotFoundError } from '../../lib/prismaErrors';
import { textoObrigatorio } from '../../lib/validation';
import {
  ehConflitoDeHorario,
  ehIntervaloInvalido,
  ocupacaoDoProfissional,
  SELECAO_AGENDAMENTO,
  SELECAO_AGENDAMENTO_DETALHE,
} from './agenda.service';

/** Janela máxima que a agenda devolve de uma vez (mês cheio + folga). */
const JANELA_MAXIMA_DIAS = 62;

/**
 * Teto de registros por listagem. A janela de 62 dias sozinha não limita
 * nada: um tenant grande com agenda cheia devolveria dezenas de milhares de
 * linhas numa requisição — peso no banco, no servidor e no navegador. Com
 * teto, a resposta avisa que truncou em vez de mentir por omissão.
 */
const MAX_AGENDAMENTOS = 1000;

/** Observação é texto livre do atendente: opcional, mas com tipo e teto. */
const MAX_OBSERVACAO = 500;

function observacaoValida(valor: unknown): string | null | undefined {
  if (valor === undefined || valor === null || valor === '') return null;
  if (typeof valor !== 'string') return undefined;
  const limpo = valor.trim();
  return limpo.length > MAX_OBSERVACAO ? undefined : limpo;
}

function dataValida(valor: unknown): Date | null {
  if (typeof valor !== 'string') return null;
  const data = new Date(valor);
  return Number.isNaN(data.getTime()) ? null : data;
}

export async function listarAgendamentos(req: Request, res: Response): Promise<void> {
  const de = dataValida(req.query.de);
  const ate = dataValida(req.query.ate);
  if (!de || !ate || ate <= de) {
    res.status(400).json({ error: 'Informe um intervalo válido em `de` e `ate` (ISO 8601).' });
    return;
  }
  if (ate.getTime() - de.getTime() > JANELA_MAXIMA_DIAS * 24 * 60 * 60 * 1000) {
    res.status(400).json({ error: `Intervalo máximo de ${JANELA_MAXIMA_DIAS} dias.` });
    return;
  }

  const profissionalId =
    typeof req.query.profissionalId === 'string' ? req.query.profissionalId : undefined;
  const categoria = typeof req.query.categoria === 'string' ? req.query.categoria : undefined;

  const agendamentos = await prisma.agendamento.findMany({
    where: {
      inicioEm: { gte: de, lt: ate },
      ...(profissionalId ? { profissionalId } : {}),
      // Filtro por "segmento de serviço" da tela: categoria do próprio tenant.
      ...(categoria ? { servico: { categoria } } : {}),
    },
    select: SELECAO_AGENDAMENTO,
    orderBy: { inicioEm: 'asc' },
    take: MAX_AGENDAMENTOS + 1,
  });

  const truncado = agendamentos.length > MAX_AGENDAMENTOS;
  res.json({ agendamentos: truncado ? agendamentos.slice(0, MAX_AGENDAMENTOS) : agendamentos, truncado });
}

export async function criarAgendamento(req: Request, res: Response): Promise<void> {
  const { clienteId, profissionalId, servicoId } = req.body ?? {};
  const inicioEm = dataValida(req.body?.inicioEm);

  if (
    typeof clienteId !== 'string' ||
    typeof profissionalId !== 'string' ||
    typeof servicoId !== 'string' ||
    !inicioEm
  ) {
    res.status(400).json({ error: 'clienteId, profissionalId, servicoId e inicioEm são obrigatórios.' });
    return;
  }

  // Sem esta checagem, `observacao: { $ne: null }` (ou qualquer não-string)
  // atravessa até o Prisma e volta como 500 genérico — erro de entrada tem
  // que morrer na borda, como 400.
  const observacao = observacaoValida(req.body?.observacao);
  if (observacao === undefined) {
    res.status(400).json({ error: `observacao deve ser texto de até ${MAX_OBSERVACAO} caracteres.` });
    return;
  }

  // Todas as buscas passam pelo client escopado: um id de outro tenant
  // simplesmente não é encontrado e vira 404 — nunca 403, que confirmaria a
  // existência do registro (regra do Dia 2).
  const [cliente, profissional, servico] = await Promise.all([
    prisma.cliente.findFirst({ where: { id: clienteId }, select: { id: true } }),
    prisma.profissional.findFirst({ where: { id: profissionalId, ativo: true }, select: { id: true } }),
    prisma.servico.findFirst({
      where: { id: servicoId, ativo: true },
      select: { id: true, duracaoMinutos: true },
    }),
  ]);

  if (!cliente || !profissional || !servico) {
    res.status(404).json({ error: 'Cliente, profissional ou serviço não encontrado.' });
    return;
  }

  const fimEm = new Date(inicioEm.getTime() + servico.duracaoMinutos * 60 * 1000);

  try {
    const agendamento = await prisma.agendamento.create({
      data: { clienteId, profissionalId, servicoId, inicioEm, fimEm, observacao } as Prisma.AgendamentoUncheckedCreateInput,
      select: SELECAO_AGENDAMENTO_DETALHE,
    });

    await registrarAuditoria({
      acao: 'AGENDAMENTO_CRIADO',
      entidade: 'Agendamento',
      entidadeId: agendamento.id,
      detalhes: { profissionalId, servicoId, inicioEm: inicioEm.toISOString() },
    });

    res.status(201).json({ agendamento });
  } catch (error) {
    if (ehConflitoDeHorario(error)) {
      res.status(409).json({ error: 'Horário indisponível para este profissional.' });
      return;
    }
    if (ehIntervaloInvalido(error)) {
      res.status(400).json({ error: 'Intervalo de agendamento inválido.' });
      return;
    }
    throw error;
  }
}

export async function atualizarAgendamento(req: Request, res: Response): Promise<void> {
  const atual = await prisma.agendamento.findFirst({
    where: { id: req.params.id },
    select: { id: true, status: true, servicoId: true },
  });
  if (!atual) {
    res.status(404).json({ error: 'Agendamento não encontrado.' });
    return;
  }
  if (atual.status === 'CANCELADO') {
    res.status(409).json({ error: 'Agendamento cancelado não pode ser editado.' });
    return;
  }

  const dados: Prisma.AgendamentoUncheckedUpdateInput = {};

  if (req.body?.inicioEm !== undefined) {
    const inicioEm = dataValida(req.body.inicioEm);
    if (!inicioEm) {
      res.status(400).json({ error: 'inicioEm inválido.' });
      return;
    }
    const servico = await prisma.servico.findFirst({
      where: { id: atual.servicoId },
      select: { duracaoMinutos: true },
    });
    if (!servico) {
      // Um `?? 30` aqui remarcaria o horário com duração inventada e
      // ninguém perceberia. Se o serviço sumiu, a remarcação para.
      res.status(409).json({ error: 'Serviço do agendamento não está mais disponível.' });
      return;
    }
    dados.inicioEm = inicioEm;
    dados.fimEm = new Date(inicioEm.getTime() + servico.duracaoMinutos * 60 * 1000);
  }

  if (req.body?.status !== undefined) {
    if (!['AGENDADO', 'CONFIRMADO', 'CONCLUIDO'].includes(req.body.status)) {
      // Cancelamento tem rota própria: exige motivo e audita diferente.
      res.status(400).json({ error: 'status inválido para esta rota.' });
      return;
    }
    dados.status = req.body.status;
  }

  if (req.body?.observacao !== undefined) {
    const observacao = observacaoValida(req.body.observacao);
    if (observacao === undefined) {
      res.status(400).json({ error: `observacao deve ser texto de até ${MAX_OBSERVACAO} caracteres.` });
      return;
    }
    dados.observacao = observacao;
  }

  if (Object.keys(dados).length === 0) {
    res.status(400).json({ error: 'Nada para atualizar.' });
    return;
  }

  try {
    const agendamento = await prisma.agendamento.update({
      where: { id: req.params.id },
      data: dados,
      select: SELECAO_AGENDAMENTO_DETALHE,
    });

    await registrarAuditoria({
      acao: 'AGENDAMENTO_ATUALIZADO',
      entidade: 'Agendamento',
      entidadeId: agendamento.id,
      detalhes: { campos: Object.keys(dados) },
    });

    res.json({ agendamento });
  } catch (error) {
    if (ehConflitoDeHorario(error)) {
      res.status(409).json({ error: 'Horário indisponível para este profissional.' });
      return;
    }
    if (isRecordNotFoundError(error)) {
      res.status(404).json({ error: 'Agendamento não encontrado.' });
      return;
    }
    throw error;
  }
}

export async function cancelarAgendamento(req: Request, res: Response): Promise<void> {
  const motivo = textoObrigatorio(req.body?.motivo, 300);
  if (!motivo) {
    // Cancelamento sem motivo é o tipo de buraco que aparece meses depois,
    // quando ninguém lembra por que o horário caiu.
    res.status(400).json({ error: 'motivo do cancelamento é obrigatório.' });
    return;
  }

  // Cancela condicionalmente: se outra requisição já cancelou, esta não
  // sobrescreve o motivo nem audita duas vezes.
  const cancelado = await prisma.agendamento.updateMany({
    where: { id: req.params.id, status: { not: 'CANCELADO' } },
    data: { status: 'CANCELADO', motivoCancelamento: motivo },
  });

  if (cancelado.count !== 1) {
    const existe = await prisma.agendamento.findFirst({
      where: { id: req.params.id },
      select: { status: true },
    });
    if (!existe) {
      res.status(404).json({ error: 'Agendamento não encontrado.' });
      return;
    }
    res.status(409).json({ error: 'Agendamento já está cancelado.' });
    return;
  }

  await registrarAuditoria({
    acao: 'AGENDAMENTO_CANCELADO',
    entidade: 'Agendamento',
    entidadeId: req.params.id,
    detalhes: { motivo },
  });

  res.json({ status: 'CANCELADO' });
}

export async function listarDisponibilidade(req: Request, res: Response): Promise<void> {
  const profissionalId =
    typeof req.query.profissionalId === 'string' ? req.query.profissionalId : '';
  const de = dataValida(req.query.de);
  const ate = dataValida(req.query.ate);

  if (!profissionalId || !de || !ate || ate <= de) {
    res.status(400).json({ error: 'Informe profissionalId, de e ate (ISO 8601).' });
    return;
  }

  const profissional = await prisma.profissional.findFirst({
    where: { id: profissionalId },
    select: { id: true },
  });
  if (!profissional) {
    res.status(404).json({ error: 'Profissional não encontrado.' });
    return;
  }

  res.json({ ocupado: await ocupacaoDoProfissional(profissionalId, de, ate) });
}

export async function listarProfissionais(_req: Request, res: Response): Promise<void> {
  const profissionais = await prisma.profissional.findMany({
    where: { ativo: true },
    select: { id: true, nome: true },
    orderBy: { nome: 'asc' },
  });
  res.json({ profissionais });
}

export async function listarServicos(_req: Request, res: Response): Promise<void> {
  const servicos = await prisma.servico.findMany({
    where: { ativo: true },
    select: { id: true, nome: true, categoria: true, duracaoMinutos: true },
    orderBy: { nome: 'asc' },
  });
  res.json({ servicos });
}
