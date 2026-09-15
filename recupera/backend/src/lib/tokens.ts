import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface AccessTokenPayload {
  type: 'access';
  tenantId: string;
  userId: string;
  role: string;
}

/**
 * Algoritmo fixado explicitamente na assinatura E na verificação: evita
 * qualquer chance de confusão de algoritmo (um token dizendo `alg` que não
 * seja o nosso é recusado antes de qualquer outra checagem).
 */
const JWT_ALGORITHM = 'HS256' as const;

/** JWT de sessão — 8h, conforme Prompt 1.3. Único token aceito por `authenticate`. */
export function signAccessToken(payload: {
  tenantId: string;
  userId: string;
  role: string;
}): string {
  const body: AccessTokenPayload = { ...payload, type: 'access' };
  return jwt.sign(body, env.jwtSecret, { expiresIn: '8h', algorithm: JWT_ALGORITHM });
}

function isNonEmptyString(valor: unknown): valor is string {
  return typeof valor === 'string' && valor.length > 0;
}

/**
 * Verifica o token de sessão e valida o formato do payload campo a campo.
 * A validação não é cosmética: um `tenantId` ausente viraria um contexto de
 * tenant indefinido e, como o Prisma descarta `undefined` no `where`, toda
 * query tenant-scoped rodaria sem filtro (ver lib/tenantContext.ts).
 */
export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, env.jwtSecret, { algorithms: [JWT_ALGORITHM] });

  if (typeof decoded !== 'object' || decoded === null) {
    throw new Error('Payload de token inválido.');
  }

  const { type, tenantId, userId, role } = decoded as Partial<AccessTokenPayload>;

  if (type !== 'access') {
    // Evita confusão de token: um token de setup/challenge de MFA não pode
    // ser reaproveitado como sessão autenticada.
    throw new Error('Tipo de token inesperado.');
  }
  if (!isNonEmptyString(tenantId) || !isNonEmptyString(userId) || !isNonEmptyString(role)) {
    throw new Error('Payload de token incompleto.');
  }

  return { type, tenantId, userId, role };
}

type PurposeTokenType = 'mfa_setup' | 'mfa_challenge';

interface PurposeTokenPayload {
  type: PurposeTokenType;
  userId: string;
}

/**
 * Tokens de propósito único e curta duração, usados só para amarrar as
 * etapas do handshake de MFA (setup/challenge) — nunca aceitos por
 * `authenticate` como sessão, e nunca aceitos um no lugar do outro (o
 * campo `type` é conferido em `verifyPurposeToken`, evitando confusão de
 * token entre fluxos diferentes).
 */
export function signPurposeToken(userId: string, type: PurposeTokenType, ttl: string): string {
  const body: PurposeTokenPayload = { userId, type };
  return jwt.sign(body, env.jwtSecret, { expiresIn: ttl, algorithm: JWT_ALGORITHM });
}

export function verifyPurposeToken(token: string, expected: PurposeTokenType): { userId: string } {
  const decoded = jwt.verify(token, env.jwtSecret, { algorithms: [JWT_ALGORITHM] });

  if (typeof decoded !== 'object' || decoded === null) {
    throw new Error('Payload de token inválido.');
  }

  const { type, userId } = decoded as Partial<PurposeTokenPayload>;
  if (type !== expected) {
    throw new Error('Token com finalidade inesperada.');
  }
  if (!isNonEmptyString(userId)) {
    throw new Error('Payload de token incompleto.');
  }

  return { userId };
}

/**
 * Refresh token: opaco (não-JWT), 30 dias. Só o hash SHA-256 é persistido
 * — mesma régua de "nunca secret em texto puro" aplicada a senhas — o que
 * também viabiliza invalidação real no logout (basta marcar revokedAt).
 */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(48).toString('hex');
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
