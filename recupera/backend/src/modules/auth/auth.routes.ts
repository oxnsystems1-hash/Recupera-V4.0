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

export const authRouter = Router();

/**
 * MFA/TOTP obrigatório para Owner e Admin (Prompt 1.3) — os únicos papéis
 * com acesso a ações sensíveis/administrativas na matriz RBAC.
 */
const MFA_REQUIRED_ROLES = new Set<User['role']>(['OWNER', 'ADMIN']);

async function issueSession(user: Pick<User, 'id' | 'tenantId' | 'role'>) {
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
authRouter.post('/login', async (req, res) => {
  const { email, senha } = req.body ?? {};
  if (typeof email !== 'string' || typeof senha !== 'string') {
    res.status(400).json({ error: 'email e senha são obrigatórios.' });
    return;
  }

  // Rate limiting 5 tentativas/15min, por IP e por conta (Prompt 1.3).
  const ipKey = `login:ip:${req.ip}`;
  const emailKey = `login:email:${email.toLowerCase()}`;
  if (isRateLimited(ipKey) || isRateLimited(emailKey)) {
    res.status(429).json({ error: 'Muitas tentativas. Tente novamente em alguns minutos.' });
    return;
  }

  const user = await prismaUnscoped.user.findFirst({ where: { email } });
  const senhaValida = user ? await bcrypt.compare(senha, user.passwordHash) : false;

  if (!user || !user.active || !senhaValida) {
    registerFailedAttempt(ipKey);
    registerFailedAttempt(emailKey);
    res.status(401).json({ error: 'Credenciais inválidas.' });
    return;
  }

  resetAttempts(ipKey);
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
});

/**
 * Gera o segredo TOTP para um Owner/Admin ainda sem MFA habilitado. O
 * segredo só é confirmado (mfaEnabled = true) em /mfa/enable, após provar
 * posse de um código válido — assim ninguém fica "meio autenticado" com um
 * segredo que nunca chegou a validar no autenticador do usuário.
 */
authRouter.post('/mfa/setup', async (req, res) => {
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

  const user = await prismaUnscoped.user.findFirst({ where: { id: userId } });
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
});

authRouter.post('/mfa/enable', async (req, res) => {
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

  const user = await prismaUnscoped.user.findFirst({ where: { id: userId } });
  if (!user?.mfaSecret) {
    res.status(400).json({ error: 'Configuração de MFA não iniciada.' });
    return;
  }

  const valido = authenticator.check(code, decryptSecret(user.mfaSecret));
  if (!valido) {
    registerFailedAttempt(rateKey);
    res.status(401).json({ error: 'Código inválido.' });
    return;
  }
  resetAttempts(rateKey);

  const atualizado = await prismaUnscoped.user.update({
    where: { id: user.id },
    data: { mfaEnabled: true },
  });

  res.json(await issueSession(atualizado));
});

authRouter.post('/mfa/verify', async (req, res) => {
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

  const user = await prismaUnscoped.user.findFirst({ where: { id: userId } });
  if (!user?.mfaEnabled || !user.mfaSecret) {
    res.status(400).json({ error: 'MFA não habilitado para este usuário.' });
    return;
  }

  const valido = authenticator.check(code, decryptSecret(user.mfaSecret));
  if (!valido) {
    registerFailedAttempt(rateKey);
    res.status(401).json({ error: 'Código inválido.' });
    return;
  }
  resetAttempts(rateKey);

  res.json(await issueSession(user));
});

/** Rotaciona o refresh token a cada uso: o antigo é revogado e um novo é emitido. */
authRouter.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body ?? {};
  if (typeof refreshToken !== 'string') {
    res.status(400).json({ error: 'refreshToken é obrigatório.' });
    return;
  }

  const stored = await prismaUnscoped.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(refreshToken) },
  });

  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    res.status(401).json({ error: 'Sessão inválida ou expirada.' });
    return;
  }

  const user = await prismaUnscoped.user.findFirst({ where: { id: stored.userId } });
  if (!user || !user.active) {
    res.status(401).json({ error: 'Sessão inválida ou expirada.' });
    return;
  }

  await prismaUnscoped.refreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: new Date() },
  });

  res.json(await issueSession(user));
});

/**
 * Invalidação real de sessão no logout (Prompt 1.3): revoga o refresh
 * token no banco — a partir daqui ele nunca mais gera um novo access
 * token. O access token em uso continua válido até expirar (máx. 8h),
 * limitação aceita de JWT stateless; a sessão de longa duração (30d) é
 * quem é de fato encerrada.
 */
authRouter.post('/logout', async (req, res) => {
  const { refreshToken } = req.body ?? {};
  if (typeof refreshToken !== 'string') {
    res.status(400).json({ error: 'refreshToken é obrigatório.' });
    return;
  }

  await prismaUnscoped.refreshToken.updateMany({
    where: { tokenHash: hashRefreshToken(refreshToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });

  res.status(204).send();
});
