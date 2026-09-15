import path from 'node:path';
import dotenv from 'dotenv';

/**
 * Carrega o .env de forma explícita e determinística, antes de qualquer
 * leitura de process.env deste módulo.
 *
 * Antes daqui, o projeto dependia de um efeito colateral acidental: o
 * construtor do PrismaClient também carrega o .env, e o app só funcionava
 * porque `lib/prisma` era importado antes deste arquivo na cadeia de
 * imports. Bastava reordenar um import para o boot quebrar com
 * "DATABASE_URL ausente". `dotenv.config()` não sobrescreve variáveis já
 * definidas, então ambiente real (produção) e os testes (que injetam as
 * variáveis pelo vitest.config.ts) continuam tendo precedência.
 */
dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return value;
}

/**
 * Segredos que acompanham o .env.example. São úteis para subir o projeto em
 * um minuto no ambiente local, e catastróficos se chegarem em produção —
 * por isso o boot falha se algum deles aparecer com NODE_ENV=production.
 */
const SEGREDOS_DE_EXEMPLO = new Set([
  'troque-este-segredo-em-producao',
  '1a6f49197e0764045c95cbbf9dae60dcc1081a5b78ca0dd56433e2ce67a4744f',
  '6a5255d5115607038974dc8ce214664d098fc1bb6325a0319cd02ee2dc621ac5',
]);

function segredoDeProducao(name: string): string {
  const value = required(name);
  if (process.env.NODE_ENV === 'production' && SEGREDOS_DE_EXEMPLO.has(value)) {
    throw new Error(
      `${name} está usando o valor de exemplo do .env.example — gere um segredo próprio antes de subir em produção.`,
    );
  }
  return value;
}

export const env = {
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: segredoDeProducao('JWT_SECRET'),
  mfaEncryptionKey: segredoDeProducao('MFA_ENCRYPTION_KEY'),
  // Assina as URLs de download de arquivo (lib/signedUrl.ts) — chave
  // separada da de JWT/MFA por princípio de separação de segredos.
  fileUrlSecret: segredoDeProducao('FILE_URL_SECRET'),
  // Raiz do storage privado local (lib/storage). Nunca dentro de uma pasta
  // servida estaticamente pelo Express.
  storageRoot: process.env.STORAGE_ROOT ?? path.join(process.cwd(), 'storage-privado'),
  /**
   * Quantos proxies confiáveis existem na frente da aplicação. Precisa ser
   * configurado de propósito: com 0 (padrão), atrás de um load balancer
   * todos os clientes compartilham o IP do proxy e o rate limiting vira um
   * balde só; com um valor alto demais, o cliente forja X-Forwarded-For e
   * escapa do rate limiting. Ver README do backend.
   */
  trustProxy: Number(process.env.TRUST_PROXY ?? 0),
  /**
   * Origens autorizadas a chamar a API pelo navegador (Fase C). Allowlist
   * explícita, nunca `*`: com credenciais em jogo, `*` transformaria
   * qualquer site aberto pelo usuário em cliente da API.
   */
  corsOrigens: (process.env.CORS_ORIGENS ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  port: Number(process.env.PORT ?? 3000),
};
