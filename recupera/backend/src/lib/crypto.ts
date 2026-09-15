import crypto from 'node:crypto';
import { env } from '../config/env';

const ALGORITHM = 'aes-256-gcm';

function getKey(): Buffer {
  const key = Buffer.from(env.mfaEncryptionKey, 'hex');
  if (key.length !== 32) {
    throw new Error('MFA_ENCRYPTION_KEY deve ter 32 bytes (64 caracteres hex).');
  }
  return key;
}

/**
 * Criptografia em repouso do segredo TOTP de MFA (regra 4 da especificação:
 * dados sensíveis nunca em texto puro no banco). Formato do payload:
 * `<iv>.<authTag>.<ciphertext>`, tudo em hex.
 */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, encrypted].map((buffer) => buffer.toString('hex')).join('.');
}

export function decryptSecret(payload: string): string {
  const partes = payload.split('.');
  if (partes.length !== 3) {
    throw new Error('Payload criptografado em formato inválido.');
  }
  const [ivHex, authTagHex, encryptedHex] = partes;

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
