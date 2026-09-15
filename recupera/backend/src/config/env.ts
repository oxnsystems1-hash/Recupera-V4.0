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
  port: Number(process.env.PORT ?? 3000),
};
