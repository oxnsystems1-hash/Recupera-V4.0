import { Request, Response } from 'express';
import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma, prismaUnscoped } from '../../lib/prisma';
import { requireAuthContext, requireTenantId } from '../../lib/tenantContext';
import { registrarAuditoria } from '../../lib/auditoria';
import { emailValido, textoObrigatorio } from '../../lib/validation';
import { isRecordNotFoundError } from '../../lib/prismaErrors';
import { isRateLimited, registerFailedAttempt } from '../../lib/rateLimiter';
import {
  apenasCamposCorrigiveis,
  executarExclusaoDoTitular,
  montarExportacao,
  obrigacaoLegalPendente,
  prazoAtendimento,
} from './lgpd.service';

/** Token de confirmação do titular: curto, opaco e guardado só como hash. */
const TOKEN_CONFIRMACAO_VALIDADE_MS = 48 * 60 * 60 * 1000;

function gerarTokenConfirmacao(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, hash: crypto.createHash('sha256').update(token).digest('hex') };
}

async function buscarClienteDoTenant(clienteId: unknown) {
  if (typeof clienteId !== 'string' || clienteId.length === 0) return null;
  // findFirst escopado: cliente de outro tenant volta null e vira 404,
  // nunca 403 (regra do Dia 2).
  return prisma.cliente.findFirst({ where: { id: clienteId } });
}

/** PORTABILIDADE — gera o pacote de dados do titular (Prompt 2.2). */
export async function exportarDadosTitular(req: Request, res: Response): Promise<void> {
  const cliente = await buscarClienteDoTenant(req.body?.clienteId);
  if (!cliente) {
    res.status(404).json({ error: 'Titular não encontrado.' });
    return;
  }

  const exportacao = await montarExportacao(cliente);
  const auth = requireAuthContext();

  const solicitacao = await prisma.solicitacaoLgpd.create({
    data: {
      clienteId: cliente.id,
      tipo: 'EXPORTACAO',
      status: 'CONCLUIDA',
      solicitadoPorId: auth.userId,
      prazoAtendimento: prazoAtendimento(),
      // tenantId é injetado em runtime pelo Prisma Client escopado
      // (lib/prisma.ts); o cast só satisfaz o tipo gerado pelo Prisma.
    } as Prisma.SolicitacaoLgpdUncheckedCreateInput,
  });

  await registrarAuditoria({
    acao: 'LGPD_EXPORTACAO',
    entidade: 'Cliente',
    entidadeId: cliente.id,
    detalhes: { solicitacaoId: solicitacao.id, arquivosReferenciados: exportacao.arquivos.length },
  });

  res.json({
    solicitacaoId: solicitacao.id,
    prazoAtendimento: solicitacao.prazoAtendimento,
    exportacao,
  });
}

/**
 * CORREÇÃO — registra a proposta e devolve o token de confirmação. O dado
 * só muda depois que o titular confirma: o pedido parte do tenant, mas a
 * palavra final é de quem é dono do dado (Prompt 2.2).
 */
export async function solicitarCorrecao(req: Request, res: Response): Promise<void> {
  const cliente = await buscarClienteDoTenant(req.body?.clienteId);
  if (!cliente) {
    res.status(404).json({ error: 'Titular não encontrado.' });
    return;
  }

  const propostos = apenasCamposCorrigiveis(req.body ?? {});
  if (Object.keys(propostos).length === 0) {
    res.status(400).json({
      error: 'Informe ao menos um campo cadastral corrigível: nome, email, telefone ou endereco.',
    });
    return;
  }
  if (propostos.nome && !textoObrigatorio(propostos.nome)) {
    res.status(400).json({ error: 'nome inválido.' });
    return;
  }
  if (propostos.telefone && !textoObrigatorio(propostos.telefone, 30)) {
    res.status(400).json({ error: 'telefone inválido.' });
    return;
  }
  if (propostos.email) {
    const normalizado = emailValido(propostos.email);
    if (!normalizado) {
      res.status(400).json({ error: 'email inválido.' });
      return;
    }
    propostos.email = normalizado;
  }

  const auth = requireAuthContext();
  const { token, hash } = gerarTokenConfirmacao();

  const solicitacao = await prisma.solicitacaoLgpd.create({
    data: {
      clienteId: cliente.id,
      tipo: 'CORRECAO',
      status: 'AGUARDANDO_CONFIRMACAO',
      solicitadoPorId: auth.userId,
      prazoAtendimento: prazoAtendimento(),
      correcaoProposta: propostos,
      tokenConfirmacaoHash: hash,
      tokenConfirmacaoAteEm: new Date(Date.now() + TOKEN_CONFIRMACAO_VALIDADE_MS),
    } as Prisma.SolicitacaoLgpdUncheckedCreateInput,
  });

  await registrarAuditoria({
    acao: 'LGPD_CORRECAO_SOLICITADA',
    entidade: 'Cliente',
    entidadeId: cliente.id,
    detalhes: { solicitacaoId: solicitacao.id, campos: Object.keys(propostos) },
  });

  // Em produção o token NUNCA volta para quem pediu a correção: se voltasse,
  // o próprio tenant confirmaria no lugar do titular e a confirmação viraria
  // formalidade. O envio ao titular depende da infraestrutura de mensageria
  // (Fase D/G) — até lá, produção responde sem token e o pedido fica
  // pendente. Fora de produção o token volta para viabilizar teste manual.
  const emProducao = process.env.NODE_ENV === 'production';

  res.status(201).json({
    solicitacaoId: solicitacao.id,
    expiraEm: solicitacao.tokenConfirmacaoAteEm,
    ...(emProducao
      ? { aviso: 'Token de confirmação enviado ao titular pelo canal cadastrado.' }
      : { tokenConfirmacao: token }),
  });
}

/**
 * Confirmação do titular. Endpoint público por natureza: o titular não é
 * usuário do sistema. A segurança é o token opaco de uso único, com prazo
 * curto e rate limiting por IP.
 */
export async function confirmarCorrecao(req: Request, res: Response): Promise<void> {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  const chaveLimite = `lgpd-confirmacao:ip:${req.ip}`;

  if (isRateLimited(chaveLimite)) {
    res.status(429).json({ error: 'Muitas tentativas. Tente novamente em alguns minutos.' });
    return;
  }
  if (token.length === 0) {
    res.status(400).json({ error: 'token é obrigatório.' });
    return;
  }

  const hash = crypto.createHash('sha256').update(token).digest('hex');
  // Sem contexto de tenant: quem confirma é o titular, que não tem sessão.
  // O token é a credencial, e ele já aponta para uma única solicitação.
  const solicitacao = await prismaUnscoped.solicitacaoLgpd.findUnique({
    where: { tokenConfirmacaoHash: hash },
  });

  const expirado =
    !solicitacao?.tokenConfirmacaoAteEm || solicitacao.tokenConfirmacaoAteEm < new Date();

  if (!solicitacao || solicitacao.status !== 'AGUARDANDO_CONFIRMACAO' || expirado) {
    registerFailedAttempt(chaveLimite);
    res.status(401).json({ error: 'Token inválido ou expirado.' });
    return;
  }

  const proposta = (solicitacao.correcaoProposta ?? {}) as Record<string, string>;

  try {
    await prismaUnscoped.cliente.update({
      where: { id: solicitacao.clienteId },
      data: {
        ...(proposta.nome ? { nome: proposta.nome } : {}),
        ...(proposta.email ? { email: proposta.email } : {}),
        ...(proposta.telefone ? { telefone: proposta.telefone } : {}),
        ...(proposta.endereco ? { endereco: proposta.endereco } : {}),
      },
    });
  } catch (error) {
    if (isRecordNotFoundError(error)) {
      // O titular foi excluído entre o pedido e a confirmação — não há o
      // que corrigir, e o pedido morre junto (cascade).
      res.status(410).json({ error: 'Titular não existe mais; correção não se aplica.' });
      return;
    }
    throw error;
  }

  // Token de uso único: some junto com a conclusão da solicitação.
  await prismaUnscoped.solicitacaoLgpd.update({
    where: { id: solicitacao.id },
    data: { status: 'CONCLUIDA', tokenConfirmacaoHash: null, tokenConfirmacaoAteEm: null },
  });

  await registrarAuditoria({
    acao: 'LGPD_CORRECAO_CONFIRMADA',
    entidade: 'Cliente',
    entidadeId: solicitacao.clienteId,
    tenantId: solicitacao.tenantId,
    detalhes: { solicitacaoId: solicitacao.id, campos: Object.keys(proposta) },
  });

  res.json({ status: 'CONCLUIDA' });
}

/** EXCLUSÃO — abre a solicitação; a execução depende da aprovação do Owner. */
export async function solicitarExclusao(req: Request, res: Response): Promise<void> {
  const cliente = await buscarClienteDoTenant(req.body?.clienteId);
  if (!cliente) {
    res.status(404).json({ error: 'Titular não encontrado.' });
    return;
  }

  const auth = requireAuthContext();
  const solicitacao = await prisma.solicitacaoLgpd.create({
    data: {
      clienteId: cliente.id,
      tipo: 'EXCLUSAO',
      status: 'PENDENTE',
      solicitadoPorId: auth.userId,
      prazoAtendimento: prazoAtendimento(),
      // tenantId é injetado em runtime pelo Prisma Client escopado
      // (lib/prisma.ts); o cast só satisfaz o tipo gerado pelo Prisma.
    } as Prisma.SolicitacaoLgpdUncheckedCreateInput,
  });

  await registrarAuditoria({
    acao: 'LGPD_EXCLUSAO_SOLICITADA',
    entidade: 'Cliente',
    entidadeId: cliente.id,
    detalhes: { solicitacaoId: solicitacao.id },
  });

  res.status(202).json({
    solicitacaoId: solicitacao.id,
    status: solicitacao.status,
    prazoAtendimento: solicitacao.prazoAtendimento,
    aviso: 'Exclusão requer aprovação do Owner.',
  });
}

/**
 * Aprovação do Owner. É aqui que o caso limítrofe do Prompt 2.2 é
 * decidido: sem obrigação legal, exclusão real imediata; com obrigação
 * legal, bloqueio com motivo registrado e execução automática quando o
 * prazo vencer (ver jobs/lgpdSweep.ts).
 */
export async function aprovarSolicitacao(req: Request, res: Response): Promise<void> {
  const solicitacao = await prisma.solicitacaoLgpd.findFirst({ where: { id: req.params.id } });
  if (!solicitacao) {
    res.status(404).json({ error: 'Solicitação não encontrada.' });
    return;
  }
  if (solicitacao.tipo !== 'EXCLUSAO') {
    res.status(400).json({ error: 'Só solicitações de exclusão passam por aprovação.' });
    return;
  }
  if (solicitacao.status !== 'PENDENTE') {
    res.status(409).json({ error: `Solicitação já está em ${solicitacao.status}.` });
    return;
  }

  const auth = requireAuthContext();

  // Trava otimista: duas aprovações simultâneas só podem resultar em uma
  // exclusão. A reserva exige `aprovadoEm: null` e grava a data no mesmo
  // UPDATE — é esse campo que muda de valor e faz a segunda requisição
  // perder a corrida (o `status` só é decidido depois, quando sabemos se há
  // obrigação legal, então ele não serve como trava aqui).
  const reservada = await prisma.solicitacaoLgpd.updateMany({
    where: { id: solicitacao.id, status: 'PENDENTE', aprovadoEm: null },
    data: { aprovadoPorId: auth.userId, aprovadoEm: new Date() },
  });
  if (reservada.count !== 1) {
    res.status(409).json({ error: 'Solicitação já está sendo processada.' });
    return;
  }

  const obrigacao = await obrigacaoLegalPendente(solicitacao.clienteId);

  if (obrigacao) {
    const bloqueada = await prisma.solicitacaoLgpd.update({
      where: { id: solicitacao.id },
      data: {
        status: 'BLOQUEADA',
        motivoBloqueio: obrigacao.motivo,
        bloqueadoAteEm: obrigacao.ateEm,
      },
    });

    await registrarAuditoria({
      acao: 'LGPD_EXCLUSAO_BLOQUEADA',
      entidade: 'Cliente',
      entidadeId: solicitacao.clienteId,
      detalhes: {
        solicitacaoId: solicitacao.id,
        motivo: obrigacao.motivo,
        bloqueadoAteEm: obrigacao.ateEm,
      },
    });

    res.json({
      status: bloqueada.status,
      motivoBloqueio: bloqueada.motivoBloqueio,
      bloqueadoAteEm: bloqueada.bloqueadoAteEm,
      aviso: 'Exclusão será executada automaticamente quando o prazo legal vencer.',
    });
    return;
  }

  await registrarAuditoria({
    acao: 'LGPD_EXCLUSAO_APROVADA',
    entidade: 'Cliente',
    entidadeId: solicitacao.clienteId,
    detalhes: { solicitacaoId: solicitacao.id },
  });

  const { arquivosRemovidos } = await executarExclusaoDoTitular(solicitacao.clienteId);

  // A solicitação cai junto com o cliente (cascade), então o registro do
  // que aconteceu vive na auditoria — que é imutável e não cascateia.
  await registrarAuditoria({
    acao: 'LGPD_EXCLUSAO_EXECUTADA',
    entidade: 'Cliente',
    entidadeId: solicitacao.clienteId,
    detalhes: { solicitacaoId: solicitacao.id, arquivosRemovidos, imediata: true },
  });

  res.json({ status: 'CONCLUIDA', arquivosRemovidos });
}

export async function listarSolicitacoes(_req: Request, res: Response): Promise<void> {
  const solicitacoes = await prisma.solicitacaoLgpd.findMany({
    // Campos explícitos: um findMany solto devolveria também o
    // tokenConfirmacaoHash, que não tem motivo nenhum para sair do servidor.
    select: {
      id: true,
      clienteId: true,
      tipo: true,
      status: true,
      solicitadoPorId: true,
      aprovadoPorId: true,
      aprovadoEm: true,
      prazoAtendimento: true,
      motivoBloqueio: true,
      bloqueadoAteEm: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json({ solicitacoes });
}

/** Painel de auditoria — Owner, conforme a matriz RBAC. */
export async function listarAuditoria(req: Request, res: Response): Promise<void> {
  const tenantId = requireTenantId();
  // Clamp nos dois lados: `take` negativo no Prisma inverte a leitura, e
  // um valor absurdo vira varredura de tabela.
  const limite = Math.min(Math.max(Number(req.query.limite) || 100, 1), 500);

  const logs = await prismaUnscoped.logAuditoria.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    take: limite,
  });

  res.json({ logs });
}
