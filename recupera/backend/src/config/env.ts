import path from 'node:path';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return value;
}

export const env = {
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  mfaEncryptionKey: required('MFA_ENCRYPTION_KEY'),
  // Assina as URLs de download de arquivo (lib/signedUrl.ts) — chave
  // separada da de JWT/MFA por princípio de separação de segredos.
  fileUrlSecret: required('FILE_URL_SECRET'),
  // Raiz do storage privado local (lib/storage). Nunca dentro de uma pasta
  // servida estaticamente pelo Express.
  storageRoot: process.env.STORAGE_ROOT ?? path.join(process.cwd(), 'storage-privado'),
  port: Number(process.env.PORT ?? 3000),
};
