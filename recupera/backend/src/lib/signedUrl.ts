import crypto from 'node:crypto';
import { env } from '../config/env';

/** Teto absoluto do Prompt 2.1 — nenhum segmento/tenant pode ultrapassar. */
export const ABSOLUTE_MAX_TTL_SECONDS = 15 * 60;

/**
 * URL assinada tipo "capability": quem tem o token pode baixar o arquivo,
 * sem precisar de um JWT de sessão no momento do download (o mesmo padrão
 * de URLs pré-assinadas do S3). A segurança vem inteira da assinatura HMAC
 * + expiração curta — por isso a geração (aqui) só acontece dentro de uma
 * rota autenticada e autorizada no tenant (ver modules/arquivos).
 */
export function signFileToken(
  arquivoId: string,
  ttlSeconds: number,
): { token: string; expiresAt: number } {
  const ttl = Math.min(ttlSeconds, ABSOLUTE_MAX_TTL_SECONDS);
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  const payload = `${arquivoId}.${expiresAt}`;
  const signature = crypto.createHmac('sha256', env.fileUrlSecret).update(payload).digest('hex');
  const token = Buffer.from(`${payload}.${signature}`).toString('base64url');
  return { token, expiresAt };
}

export function verifyFileToken(token: string): { arquivoId: string } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const partes = decoded.split('.');
  if (partes.length !== 3) return null;
  const [arquivoId, expiresAtStr, signature] = partes;

  const payload = `${arquivoId}.${expiresAtStr}`;
  const esperada = crypto.createHmac('sha256', env.fileUrlSecret).update(payload).digest('hex');

  const assinaturaValida =
    signature.length === esperada.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(esperada));
  if (!assinaturaValida) return null;

  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return null;

  return { arquivoId };
}
