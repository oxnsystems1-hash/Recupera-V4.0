import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { createApp } from '../src/app';
import { prismaUnscoped } from '../src/lib/prisma';
import { clearAllRateLimits } from '../src/lib/rateLimiter';
import { BCRYPT_COST } from '../src/config/security';

/**
 * Cobre os demais itens do Prompt 1.3 (Dia 3), além da escalação de
 * privilégio testada em rbac-privilege-escalation.test.ts:
 * - MFA/TOTP obrigatório para Owner/Admin (setup → enable → sessão).
 * - Login subsequente de quem já tem MFA habilitado exige /mfa/verify.
 * - Refresh token: rotação a cada uso e invalidação real no logout.
 * - Rate limiting: 5 tentativas/15min bloqueiam com 429.
 */

const app = createApp();
const SENHA = 'SenhaFicticia123!';

let tenant: { id: string };

beforeEach(() => {
  clearAllRateLimits();
});

beforeAll(async () => {
  await prismaUnscoped.refreshToken.deleteMany();
  await prismaUnscoped.cliente.deleteMany();
  await prismaUnscoped.user.deleteMany();
  await prismaUnscoped.tenant.deleteMany();

  tenant = await prismaUnscoped.tenant.create({
    data: { nome: 'Clínica Fictícia MFA', segmento: 'clinica_estetica' },
  });
});

afterAll(async () => {
  await prismaUnscoped.refreshToken.deleteMany();
  await prismaUnscoped.cliente.deleteMany();
  await prismaUnscoped.user.deleteMany();
  await prismaUnscoped.tenant.deleteMany();
  await prismaUnscoped.$disconnect();
});

describe('MFA obrigatório para Owner/Admin', () => {
  it('Owner sem MFA: login pede setup; enable com código válido concede sessão; login seguinte exige /mfa/verify', async () => {
    const senhaHash = await bcrypt.hash(SENHA, BCRYPT_COST);
    const owner = await prismaUnscoped.user.create({
      data: { tenantId: tenant.id, email: 'owner@mfa.ficticio.com', passwordHash: senhaHash, role: 'OWNER' },
    });

    const login1 = await request(app)
      .post('/auth/login')
      .send({ email: owner.email, senha: SENHA });
    expect(login1.status).toBe(200);
    expect(login1.body.mfaSetupRequired).toBe(true);
    const setupToken = login1.body.setupToken as string;

    const setup = await request(app).post('/auth/mfa/setup').send({ setupToken });
    expect(setup.status).toBe(200);
    const secret = setup.body.secret as string;
    expect(typeof secret).toBe('string');

    const codigoValido = authenticator.generate(secret);
    const codigoErrado = codigoValido === '000000' ? '111111' : '000000';

    const enableFalho = await request(app)
      .post('/auth/mfa/enable')
      .send({ setupToken, code: codigoErrado });
    expect(enableFalho.status).toBe(401);

    const enable = await request(app).post('/auth/mfa/enable').send({ setupToken, code: codigoValido });
    expect(enable.status).toBe(200);
    expect(typeof enable.body.accessToken).toBe('string');
    expect(typeof enable.body.refreshToken).toBe('string');

    const login2 = await request(app)
      .post('/auth/login')
      .send({ email: owner.email, senha: SENHA });
    expect(login2.status).toBe(200);
    expect(login2.body.mfaRequired).toBe(true);
    const challengeToken = login2.body.challengeToken as string;

    const verifyFalho = await request(app)
      .post('/auth/mfa/verify')
      .send({ challengeToken, code: '000001' });
    expect(verifyFalho.status).toBe(401);

    const verify = await request(app)
      .post('/auth/mfa/verify')
      .send({ challengeToken, code: authenticator.generate(secret) });
    expect(verify.status).toBe(200);
    expect(typeof verify.body.accessToken).toBe('string');
  });

  it('Atendente não precisa de MFA — login concede sessão direto', async () => {
    const senhaHash = await bcrypt.hash(SENHA, BCRYPT_COST);
    const atendente = await prismaUnscoped.user.create({
      data: {
        tenantId: tenant.id,
        email: 'atendente@mfa.ficticio.com',
        passwordHash: senhaHash,
        role: 'ATENDENTE',
      },
    });

    const login = await request(app)
      .post('/auth/login')
      .send({ email: atendente.email, senha: SENHA });
    expect(login.status).toBe(200);
    expect(login.body.mfaRequired).toBeUndefined();
    expect(login.body.mfaSetupRequired).toBeUndefined();
    expect(typeof login.body.accessToken).toBe('string');
  });
});

describe('Refresh token — rotação e invalidação real no logout', () => {
  it('refresh emite novo par e revoga o anterior; logout impede novos refreshes', async () => {
    const senhaHash = await bcrypt.hash(SENHA, BCRYPT_COST);
    const atendente = await prismaUnscoped.user.create({
      data: {
        tenantId: tenant.id,
        email: 'sessao@mfa.ficticio.com',
        passwordHash: senhaHash,
        role: 'ATENDENTE',
      },
    });

    const login = await request(app)
      .post('/auth/login')
      .send({ email: atendente.email, senha: SENHA });
    const refreshToken1: string = login.body.refreshToken;

    const refresh = await request(app).post('/auth/refresh').send({ refreshToken: refreshToken1 });
    expect(refresh.status).toBe(200);
    const refreshToken2: string = refresh.body.refreshToken;
    expect(refreshToken2).not.toBe(refreshToken1);

    // token antigo já foi rotacionado — não pode ser reaproveitado.
    const reuso = await request(app).post('/auth/refresh').send({ refreshToken: refreshToken1 });
    expect(reuso.status).toBe(401);

    const logout = await request(app).post('/auth/logout').send({ refreshToken: refreshToken2 });
    expect(logout.status).toBe(204);

    const refreshAposLogout = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: refreshToken2 });
    expect(refreshAposLogout.status).toBe(401);
  });
});

describe('Rate limiting de login — 5 tentativas / 15 min', () => {
  it('bloqueia com 429 após 5 tentativas falhas com a mesma conta', async () => {
    const senhaHash = await bcrypt.hash(SENHA, BCRYPT_COST);
    const usuario = await prismaUnscoped.user.create({
      data: {
        tenantId: tenant.id,
        email: 'ratelimit@mfa.ficticio.com',
        passwordHash: senhaHash,
        role: 'ATENDENTE',
      },
    });

    for (let tentativa = 0; tentativa < 5; tentativa += 1) {
      const response = await request(app)
        .post('/auth/login')
        .send({ email: usuario.email, senha: 'senha-errada' });
      expect(response.status).toBe(401);
    }

    const bloqueado = await request(app)
      .post('/auth/login')
      .send({ email: usuario.email, senha: 'senha-errada' });
    expect(bloqueado.status).toBe(429);

    // mesmo a senha correta é bloqueada enquanto a janela estiver ativa.
    const bloqueadoComSenhaCerta = await request(app)
      .post('/auth/login')
      .send({ email: usuario.email, senha: SENHA });
    expect(bloqueadoComSenhaCerta.status).toBe(429);
  });
});
