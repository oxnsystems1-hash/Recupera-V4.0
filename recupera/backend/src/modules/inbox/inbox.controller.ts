import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { registrarAuditoria } from '../../lib/auditoria';
import { requireAuthContext } from '../../lib/tenantContext';
import { textoObrigatorio } from '../../lib/validation';

const MAX_MENSAGEM = 4000;

export async function listarConversas(req: Request, res: Response): Promise<void> {
  const limite = Math.min(Math.max(Number(req.query.limite) || 50, 1), 200);

  const conversas = await prisma.conversa.findMany({
    select: {
      id: true,
      canal: true,
      naoLidas: true,
      ultimaMensagemEm: true,
      cliente: { select: { id: true, nome: true } },
      mensagens: {
        select: { conteudo: true, autor: true, createdAt: true },
        where: { status: { in: ['RECEBIDA', 'ENVIADA'] } },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
    orderBy: { ultimaMensagemEm: 'desc' },
    take: limite,
  });

  res.json({
    conversas: conversas.map(({ mensagens, ...conversa }) => ({
      ...conversa,
      ultimaMensagem: mensagens[0] ?? null,
    })),
  });
}

export async function listarMensagens(req: Request, res: Response): Promise<void> {
  const conversa = await prisma.conversa.findFirst({
    where: { id: req.params.id },
    select: { id: true, cliente: { select: { id: true, nome: true } } },
  });
  if (!conversa) {
    res.status(404).json({ error: 'Conversa não encontrada.' });
    return;
  }

  const mensagens = await prisma.mensagem.findMany({
    where: { conversaId: conversa.id },
    select: {
      id: true,
      autor: true,
      conteudo: true,
      status: true,
      enviadaPorId: true,
      enviadaEm: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });

  res.json({ conversa, mensagens });
}

export async function enviarMensagem(req: Request, res: Response): Promise<void> {
  const conteudo = textoObrigatorio(req.body?.conteudo, MAX_MENSAGEM);
  if (!conteudo) {
    res.status(400).json({ error: 'conteudo é obrigatório.' });
    return;
  }

  const conversa = await prisma.conversa.findFirst({
    where: { id: req.params.id },
    select: { id: true },
  });
  if (!conversa) {
    res.status(404).json({ error: 'Conversa não encontrada.' });
    return;
  }

  const auth = requireAuthContext();
  const agora = new Date();

  const mensagem = await prisma.mensagem.create({
    data: {
      conversaId: conversa.id,
      autor: 'ATENDENTE',
      conteudo,
      status: 'ENVIADA',
      enviadaPorId: auth.userId,
      enviadaEm: agora,
    } as Prisma.MensagemUncheckedCreateInput,
    select: { id: true, autor: true, conteudo: true, status: true, createdAt: true },
  });

  await prisma.conversa.update({
    where: { id: conversa.id },
    data: { ultimaMensagemEm: agora },
  });

  await registrarAuditoria({
    acao: 'MENSAGEM_ENVIADA',
    entidade: 'Conversa',
    entidadeId: conversa.id,
    detalhes: { mensagemId: mensagem.id, autor: 'ATENDENTE' },
  });

  res.status(201).json({ mensagem });
}

/**
 * Envia uma sugestão do agente de IA — e este é o ÚNICO caminho para isso.
 *
 * O Prompt 3.1 é explícito: sugestão do agente é exibida, nunca enviada
 * automaticamente. Por isso a sugestão nasce com status SUGERIDA e só muda
 * para ENVIADA aqui, carimbando quem aprovou (`enviadaPorId`). A transição
 * é condicional: se a sugestão já foi enviada ou descartada, esta chamada
 * não faz nada — nem reenvia, nem ressuscita uma sugestão recusada.
 */
export async function enviarSugestao(req: Request, res: Response): Promise<void> {
  const auth = requireAuthContext();
  const agora = new Date();

  const sugestao = await prisma.mensagem.findFirst({
    where: { id: req.params.mensagemId, conversaId: req.params.id },
    select: { id: true, autor: true, status: true, conversaId: true },
  });

  if (!sugestao) {
    res.status(404).json({ error: 'Sugestão não encontrada.' });
    return;
  }
  if (sugestao.autor !== 'AGENTE_IA') {
    res.status(400).json({ error: 'Esta rota só envia sugestões do agente de IA.' });
    return;
  }

  const enviada = await prisma.mensagem.updateMany({
    where: { id: sugestao.id, status: 'SUGERIDA' },
    data: { status: 'ENVIADA', enviadaPorId: auth.userId, enviadaEm: agora },
  });

  if (enviada.count !== 1) {
    res.status(409).json({ error: `Sugestão já está em ${sugestao.status}.` });
    return;
  }

  await prisma.conversa.update({
    where: { id: sugestao.conversaId },
    data: { ultimaMensagemEm: agora },
  });

  await registrarAuditoria({
    acao: 'SUGESTAO_IA_ENVIADA',
    entidade: 'Conversa',
    entidadeId: sugestao.conversaId,
    detalhes: { mensagemId: sugestao.id, aprovadaPor: auth.userId },
  });

  res.json({ status: 'ENVIADA' });
}

export async function descartarSugestao(req: Request, res: Response): Promise<void> {
  const sugestao = await prisma.mensagem.findFirst({
    where: { id: req.params.mensagemId, conversaId: req.params.id },
    select: { id: true, autor: true, status: true },
  });

  if (!sugestao) {
    res.status(404).json({ error: 'Sugestão não encontrada.' });
    return;
  }
  if (sugestao.autor !== 'AGENTE_IA') {
    res.status(400).json({ error: 'Esta rota só descarta sugestões do agente de IA.' });
    return;
  }

  const descartada = await prisma.mensagem.updateMany({
    where: { id: sugestao.id, status: 'SUGERIDA' },
    data: { status: 'DESCARTADA' },
  });

  // 409, não 404: o mesmo par "existe, mas já foi decidida" que o envio
  // responde. Duas respostas diferentes para o mesmo estado só confundem
  // quem integra — e mandam a tela tratar o caso de dois jeitos.
  if (descartada.count !== 1) {
    res.status(409).json({ error: `Sugestão já está em ${sugestao.status}.` });
    return;
  }

  await registrarAuditoria({
    acao: 'SUGESTAO_IA_DESCARTADA',
    entidade: 'Conversa',
    entidadeId: req.params.id,
    detalhes: { mensagemId: req.params.mensagemId },
  });

  res.json({ status: 'DESCARTADA' });
}

export async function marcarComoLida(req: Request, res: Response): Promise<void> {
  const atualizada = await prisma.conversa.updateMany({
    where: { id: req.params.id },
    data: { naoLidas: 0 },
  });

  if (atualizada.count !== 1) {
    res.status(404).json({ error: 'Conversa não encontrada.' });
    return;
  }

  res.json({ naoLidas: 0 });
}
