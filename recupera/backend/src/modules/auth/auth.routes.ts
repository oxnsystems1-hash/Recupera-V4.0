import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { User } from '@prisma/client';
import { prismaUnscoped } from '../../lib/prisma';
import { decryptSecret, encryptSecret } from '../../lib/crypto';
import {
  generateRefreshToken,
  hashRefreshToken,
  REFRESH_TOKEN_TTL_MS,
  signAccessToken,
  signPurposeToken,
  verifyPurposeToken,
} from '../../lib/tokens';
import { isRateLimited, registerFailedAttempt, resetAttempts } from '../../lib/rateLimiter';
import { asyncHandler } from '../../lib/asyncHandler';
import { BCRYPT_COST } from '../../config/security';
import { registrarAuditoria } from '../../lib/auditoria';

export const authRouter = Router();

/**
 * MFA/TOTP obrigatório para Owner e Admin (Prompt 1.3) — os únicos papéis
 * com acesso a ações sensíveis/administrativas na matriz RBAC.
 */
const MFA_REQUIRED_ROLES = new Set<User['role']>(['OWNER', 'ADMIN']);

/**
 * Hash descartável, de custo idêntico ao real, comparado quando o e-mail
 * não existe. Sem isso, "e-mail inexistente" responde muito mais rápido que
 * "senha errada" — um canal de enumeração de usuários por tempo de resposta.
 */
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('senha-inexistente-para-timing', BCRYPT_COST);

/**
 * O schema permite o mesmo e-mail em tenants diferentes (@@unique é
 * [tenantId, email]). Um `findFirst` simples escolheria um tenant
 * arbitrário — o usuário poderia cair no tenant errado. Aqui todas as
 * contas com aquele e-mail são consideradas e a senha é quem desempata;
 * o `take` limita o custo (cada comparação bcrypt é cara de propósito).
 */
async function autenticarPorEmailESenha(email: string, senha: string): Promise<User | null> {
  const candidatos = await prismaUnscoped.user.findMany({
    where: { email, active: true },
    orderBy: { createdAt: 'asc' },
    take: 5,
  });

  let autenticado: User | null = null;
  for (const candidato of candidatos) {
    if (await bcrypt.compare(senha, candidato.passwordHash)) {
      autenticado = candidato;
      break;
    }
  }

  if (candidatos.length === 0) {
    // Mantém o custo de tempo parecido com o de uma conta existente.
    await bcrypt.compare(senha, DUMMY_PASSWORD_HASH);
  }

  return autenticado;
}

const TOTP_STEP_SEGUNDOS = 30;

/**
 * Consome um código TOTP: valida e garante que aquela janela de 30s nunca
 * seja aceita de novo para o mesmo usuário (RFC 6238 §5.2). Sem isso, um
 * código interceptado continua válido pelo resto da janela.
 */
async function consumirCodigoTotp(user: User, code: string): Promise<boolean> {
  if (!user.mfaSecret || !authenticator.check(code, decryptSecret(user.mfaSecret))) {
    return false;
  }

  const janelaAtual = Math.floor(Date.now() / 1000 / TOTP_STEP_SEGUNDOS);
  if (user.mfaUltimaJanela !== null && janelaAtual <= user.mfaUltimaJanela) {
    return false;
  }

  // updateMany condicional: se duas requisições chegarem com o mesmo código
  // ao mesmo tempo, só a primeira encontra a janela anterior e passa.
  const consumido = await prismaUnscoped.user.updateMany({
    where: { id: user.id, mfaUltimaJanela: user.mfaUltimaJanela },
    data: { mfaUltimaJanela: janelaAtual },
  });

  return consumido.count === 1;
}

async function issueSession(user: Pick<User, 'id' | 'tenantId' | 'role'>) {
  await registrarAuditoria({
    acao: 'LOGIN_SUCESSO',
    entidade: 'User',
    entidadeId: user.id,
    tenantId: user.tenantId,
    userId: user.id,
    detalhes: { role: user.role },
  });

  const accessToken = signAccessToken({
    tenantId: user.tenantId,
    userId: user.id,
    role: user.role,
  });
  const { token: refreshToken, hash } = generateRefreshToken();

  await prismaUnscoped.refreshToken.create({
    data: {
      userId: user.id,
      tenantId: user.tenantId,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    },
  });

  return { accessToken, refreshToken };
}

/**
 * Login mínimo o bastante para autenticar (com MFA quando exigido) e
 * emitir sessão. É o único lugar do backend autorizado a consultar `User`
 * sem tenant_id no contexto — é aqui que o tenant_id é descoberto pela
 * primeira vez. Convite/onboarding completo de usuário é fora de escopo
 * do Dia 3 (ver Dia 7 — Telas administrativas).
 */
authRouter.post('/login', asyncHandler(async (req, res) => {
  const { email: emailBruto, senha } = req.body ?? {};
  if (typeof emailBruto !== 'string' || typeof senha !== 'string') {
    res.status(400).json({ error: 'email e senha são obrigatórios.' });
    return;
  }
  // E-mail é sempre gravado em minúsculas (ver usuarios.controller.ts e
  // prisma/seed.ts) — normalizar aqui também torna o login não sensível a
  // maiúsculas/minúsculas, em vez de falhar silenciosamente por diferença
  // de caixa entre o que o usuário digitou e o que está no banco.
  const email = emailBruto.toLowerCase();

  // Rate limiting 5 tentativas/15min, por IP e por conta (Prompt 1.3).
  const ipKey = `login:ip:${req.ip}`;
  const emailKey = `login:email:${email}`;
  if (isRateLimited(ipKey) || isRateLimited(emailKey)) {
    res.status(429).json({ error: 'Muitas tentativas. Tente novamente em alguns minutos.' });
    return;
  }

  const user = await autenticarPorEmailESenha(email, senha);

  if (!user) {
    registerFailedAttempt(ipKey);
    registerFailedAttempt(emailKey);
    // O e-mail entra mascarado no log (lib/mascarar.ts): a auditoria prova
    // que houve tentativa, sem virar uma lista de e-mails em texto puro.
    await registrarAuditoria({
      acao: 'LOGIN_FALHA',
      entidade: 'User',
      detalhes: { email },
      ip: req.ip,
    });
    res.status(401).json({ error: 'Credenciais inválidas.' });
    return;
  }

  // Só o contador da conta é zerado no sucesso. Zerar também o do IP
  // deixaria um atacante com uma conta válida limpar o próprio orçamento de
  // tentativas entre rodadas de força bruta contra outras contas.
  resetAttempts(emailKey);

  if (MFA_REQUIRED_ROLES.has(user.role)) {
    if (!user.mfaEnabled) {
      const setupToken = signPurposeToken(user.id, 'mfa_setup', '10m');
      res.json({ mfaSetupRequired: true, setupToken });
      return;
    }
    const challengeToken = signPurposeToken(user.id, 'mfa_challenge', '5m');
    res.json({ mfaRequired: true, challengeToken });
    return;
  }

  res.json(await issueSession(user));
}));

/**
 * Gera o segredo TOTP para um Owner/Admin ainda sem MFA habilitado. O
 * segredo só é confirmado (mfaEnabled = true) em /mfa/enable, após provar
 * posse de um código válido — assim ninguém fica "meio autenticado" com um
 * segredo que nunca chegou a validar no autenticador do usuário.
 */
authRouter.post('/mfa/setup', asyncHandler(async (req, res) => {
  const { setupToken } = req.body ?? {};
  if (typeof setupToken !== 'string') {
    res.status(400).json({ error: 'setupToken é obrigatório.' });
    return;
  }

  let userId: string;
  try {
    ({ userId } = verifyPurposeToken(setupToken, 'mfa_setup'));
  } catch {
    res.status(401).json({ error: 'setupToken inválido ou expirado.' });
    return;
  }

  const user = await prismaUnscoped.user.findFirst({ where: { id: userId, active: true } });
  if (!user || user.mfaEnabled) {
    res.status(400).json({ error: 'MFA já configurado ou usuário inválido.' });
    return;
  }

  const secret = authenticator.generateSecret();
  await prismaUnscoped.user.update({
    where: { id: user.id },
    data: { mfaSecret: encryptSecret(secret) },
  });

  res.json({ secret, otpauthUrl: authenticator.keyuri(user.email, 'Recupera', secret) });
}));

authRouter.post('/mfa/enable', asyncHandler(async (req, res) => {
  const { setupToken, code } = req.body ?? {};
  if (typeof setupToken !== 'string' || typeof code !== 'string') {
    res.status(400).json({ error: 'setupToken e code são obrigatórios.' });
    return;
  }

  let userId: string;
  try {
    ({ userId } = verifyPurposeToken(setupToken, 'mfa_setup'));
  } catch {
    res.status(401).json({ error: 'setupToken inválido ou expirado.' });
    return;
  }

  const rateKey = `mfa-enable:${userId}`;
  if (isRateLimited(rateKey)) {
    res.status(429).json({ error: 'Muitas tentativas. Tente novamente em alguns minutos.' });
    return;
  }

  const user = await prismaUnscoped.user.findFirst({ where: { id: userId, active: true } });
  if (!user?.mfaSecret) {
    res.status(400).json({ error: 'Configuração de MFA não iniciada.' });
    return;
  }

  if (!(await consumirCodigoTotp(user, code))) {
    registerFailedAttempt(rateKey);
    res.status(401).json({ error: 'Código inválido.' });
    return;
  }
  resetAttempts(rateKey);

  const atualizado = await prismaUnscoped.user.update({
    where: { id: user.id },
    data: { mfaEnabled: true },
  });

  await registrarAuditoria({
    acao: 'MFA_HABILITADO',
    entidade: 'User',
    entidadeId: atualizado.id,
    tenantId: atualizado.tenantId,
    userId: atualizado.id,
    detalhes: { role: atualizado.role },
  });

  res.json(await issueSession(atualizado));
}));

authRouter.post('/mfa/verify', asyncHandler(async (req, res) => {
  const { challengeToken, code } = req.body ?? {};
  if (typeof challengeToken !== 'string' || typeof code !== 'string') {
    res.status(400).json({ error: 'challengeToken e code são obrigatórios.' });
    return;
  }

  let userId: string;
  try {
    ({ userId } = verifyPurposeToken(challengeToken, 'mfa_challenge'));
  } catch {
    res.status(401).json({ error: 'challengeToken inválido ou expirado.' });
    return;
  }

  const rateKey = `mfa-verify:${userId}`;
  if (isRateLimited(rateKey)) {
    res.status(429).json({ error: 'Muitas tentativas. Tente novamente em alguns minutos.' });
    return;
  }

  const user = await prismaUnscoped.user.findFirst({ where: { id: userId, active: true } });
  if (!user?.mfaEnabled || !user.mfaSecret) {
    res.status(400).json({ error: 'MFA não habilitado para este usuário.' });
    return;
  }

  if (!(await consumirCodigoTotp(user, code))) {
    registerFailedAttempt(rateKey);
    res.status(401).json({ error: 'Código inválido.' });
    return;
  }
  resetAttempts(rateKey);

  res.json(await issueSession(user));
}));

/** Rotaciona o refresh token a cada uso: o antigo é revogado e um novo é emitido. */
authRouter.post('/refresh', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body ?? {};
  if (typeof refreshToken !== 'string') {
    res.status(400).json({ error: 'refreshToken é obrigatório.' });
    return;
  }

  const stored = await prismaUnscoped.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(refreshToken) },
  });

  if (!stored) {
    res.status(401).json({ error: 'Sessão inválida ou expirada.' });
    return;
  }

  if (stored.revokedAt) {
    // Reuso de um token já rotacionado: ou o token vazou, ou uma cópia
    // antiga está sendo replayada. Não dá para distinguir, então tratamos
    // como comprometimento e derrubamos todas as sessões do usuário.
    await prismaUnscoped.refreshToken.updateMany({
      where: { userId: stored.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await registrarAuditoria({
      acao: 'SESSAO_REUSO_DETECTADO',
      entidade: 'User',
      entidadeId: stored.userId,
      tenantId: stored.tenantId,
      userId: stored.userId,
      detalhes: { todasAsSessoesRevogadas: true },
      ip: req.ip,
    });
    res.status(401).json({ error: 'Sessão inválida ou expirada.' });
    return;
  }

  if (stored.expiresAt < new Date()) {
    res.status(401).json({ error: 'Sessão inválida ou expirada.' });
    return;
  }

  const user = await prismaUnscoped.user.findFirst({ where: { id: stored.userId } });
  if (!user || !user.active) {
    res.status(401).json({ error: 'Sessão inválida ou expirada.' });
    return;
  }

  // Revogação condicional (compare-and-swap): se duas requisições chegarem
  // com o mesmo refresh token ao mesmo tempo, só uma encontra revokedAt
  // null e emite sessão — a outra recebe 401 em vez de gerar uma segunda
  // sessão válida a partir do mesmo token.
  const rotacionado = await prismaUnscoped.refreshToken.updateMany({
    where: { id: stored.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (rotacionado.count !== 1) {
    res.status(401).json({ error: 'Sessão inválida ou expirada.' });
    return;
  }

  res.json(await issueSession(user));
}));

/**
 * Invalidação real de sessão no logout (Prompt 1.3): revoga o refresh
 * token no banco — a partir daqui ele nunca mais gera um novo access
 * token. O access token em uso continua válido até expirar (máx. 8h),
 * limitação aceita de JWT stateless; a sessão de longa duração (30d) é
 * quem é de fato encerrada.
 */
authRouter.post('/logout', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body ?? {};
  if (typeof refreshToken !== 'string') {
    res.status(400).json({ error: 'refreshToken é obrigatório.' });
    return;
  }

  const revogados = await prismaUnscoped.refreshToken.updateMany({
    where: { tokenHash: hashRefreshToken(refreshToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });

  if (revogados.count > 0) {
    const sessao = await prismaUnscoped.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(refreshToken) },
      select: { userId: true, tenantId: true },
    });
    await registrarAuditoria({
      acao: 'LOGOUT',
      entidade: 'User',
      entidadeId: sessao?.userId,
      tenantId: sessao?.tenantId,
      userId: sessao?.userId,
      ip: req.ip,
    });
  }

  res.status(204).send();
}));
