import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface AccessTokenPayload {
  type: 'access';
  tenantId: string;
  userId: string;
  role: string;
}

/** JWT de sessão — 8h, conforme Prompt 1.3. Único token aceito por `authenticate`. */
export function signAccessToken(payload: {
  tenantId: string;
  userId: string;
  role: string;
}): string {
  const body: AccessTokenPayload = { ...payload, type: 'access' };
  return jwt.sign(body, env.jwtSecret, { expiresIn: '8h' });
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
  return jwt.sign(body, env.jwtSecret, { expiresIn: ttl });
}

export function verifyPurposeToken(token: string, expected: PurposeTokenType): { userId: string } {
  const decoded = jwt.verify(token, env.jwtSecret) as PurposeTokenPayload;
  if (decoded.type !== expected) {
    throw new Error('Token com finalidade inesperada.');
  }
  return { userId: decoded.userId };
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
