import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';
import { createApp } from '../src/app';
import { prisma, prismaUnscoped } from '../src/lib/prisma';
import { runWithAuthContext } from '../src/lib/tenantContext';
import { clearAllRateLimits } from '../src/lib/rateLimiter';
import { signPurposeToken } from '../src/lib/tokens';
import { BCRYPT_COST } from '../src/config/security';
import { env } from '../src/config/env';

/**
 * Regressões da revisão completa pós-Dia 4. Cada teste aqui corresponde a
 * um defeito real encontrado lendo o código linha a linha — estão juntos
 * de propósito, para que uma futura mudança que reabra qualquer um deles
 * quebre a suíte em vez de passar despercebida.
 */

const app = createApp();
const SENHA = 'SenhaFicticia123!';
const PNG_MAGIC_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let tenantA: { id: string };
let tenantB: { id: string };
let tokenAtendenteA: string;
let tokenOwnerA: string;
let clienteB: { id: string };

async function loginComMfa(email: string): Promise<string> {
  const login = await request(app).post('/auth/login').send({ email, senha: SENHA });
  const setup = await request(app)
    .post('/auth/mfa/setup')
    .send({ setupToken: login.body.setupToken });
  const enable = await request(app).post('/auth/mfa/enable').send({
    setupToken: login.body.setupToken,
    code: authenticator.generate(setup.body.secret),
  });
  return enable.body.accessToken;
}

beforeEach(() => {
  clearAllRateLimits();
});

beforeAll(async () => {
  await prismaUnscoped.$executeRawUnsafe('TRUNCATE "logs_auditoria"');
  await prismaUnscoped.solicitacaoLgpd.deleteMany();
  await prismaUnscoped.arquivo.deleteMany();
  await prismaUnscoped.cliente.deleteMany();
  await prismaUnscoped.refreshToken.deleteMany();
  await prismaUnscoped.user.deleteMany();
  await prismaUnscoped.tenant.deleteMany();

  const senhaHash = await bcrypt.hash(SENHA, BCRYPT_COST);

  tenantA = await prismaUnscoped.tenant.create({
    data: { nome: 'Tenant Fictício A', segmento: 'autoescolas' },
  });
  tenantB = await prismaUnscoped.tenant.create({
    data: { nome: 'Tenant Fictício B', segmento: 'autoescolas' },
  });

  await prismaUnscoped.user.create({
    data: {
      tenantId: tenantA.id,
      email: 'atendente@regressao-a.ficticio.com',
      passwordHash: senhaHash,
      role: 'ATENDENTE',
    },
  });
  await prismaUnscoped.user.create({
    data: {
      tenantId: tenantA.id,
      email: 'owner@regressao-a.ficticio.com',
      passwordHash: senhaHash,
      role: 'OWNER',
    },
  });

  clienteB = await prismaUnscoped.cliente.create({
    data: { tenantId: tenantB.id, nome: 'Cliente do Tenant B', telefone: '+55 11 90000-0002' },
  });

  const login = await request(app)
    .post('/auth/login')
    .send({ email: 'atendente@regressao-a.ficticio.com', senha: SENHA });
  tokenAtendenteA = login.body.accessToken;
  tokenOwnerA = await loginComMfa('owner@regressao-a.ficticio.com');
});

afterAll(async () => {
  await prismaUnscoped.$executeRawUnsafe('TRUNCATE "logs_auditoria"');
  await prismaUnscoped.solicitacaoLgpd.deleteMany();
  await prismaUnscoped.arquivo.deleteMany();
  await prismaUnscoped.cliente.deleteMany();
  await prismaUnscoped.refreshToken.deleteMany();
  await prismaUnscoped.user.deleteMany();
  await prismaUnscoped.tenant.deleteMany();
  await prismaUnscoped.$disconnect();
});

describe('Isolamento de tenant — falhas que vazariam dados', () => {
  it('contexto com tenantId indefinido aborta a query em vez de rodar sem filtro', async () => {
    // Antes da correção, o Prisma descartava o `tenantId: undefined` do
    // where e devolvia os clientes de TODOS os tenants.
    await runWithAuthContext({ tenantId: undefined as unknown as string, userId: 'x', role: 'OWNER' }, async () => {
      await expect(prisma.cliente.findMany()).rejects.toThrow(/tenant_id válido/);
    });
  });

  it('contexto com tenantId vazio também aborta', async () => {
    await runWithAuthContext({ tenantId: '', userId: 'x', role: 'OWNER' }, async () => {
      await expect(prisma.cliente.findMany()).rejects.toThrow(/tenant_id válido/);
    });
  });

  it('query tenant-scoped fora de requisição autenticada aborta', async () => {
    await expect(prisma.cliente.findMany()).rejects.toThrow(/Nenhum tenant autenticado/);
  });

  it('delete cross-tenant não apaga o registro do outro tenant (404)', async () => {
    const resposta = await request(app)
      .delete(`/clientes/${clienteB.id}`)
      .set('Authorization', `Bearer ${tokenOwnerA}`);

    expect(resposta.status).toBe(404);
    const ainda = await prismaUnscoped.cliente.findFirst({ where: { id: clienteB.id } });
    expect(ainda?.nome).toBe('Cliente do Tenant B');
  });

  it('update cross-tenant via Prisma escopado é recusado pelo banco', async () => {
    await runWithAuthContext({ tenantId: tenantA.id, userId: 'x', role: 'OWNER' }, async () => {
      await expect(
        prisma.cliente.update({ where: { id: clienteB.id }, data: { nome: 'INVADIDO' } }),
      ).rejects.toMatchObject({ code: 'P2025' });
    });

    const ainda = await prismaUnscoped.cliente.findFirst({ where: { id: clienteB.id } });
    expect(ainda?.nome).toBe('Cliente do Tenant B');
  });
});

describe('Validação de token — payload malformado não vira contexto sem tenant', () => {
  it('token válido na assinatura, mas sem tenantId, é recusado com 401', async () => {
    const tokenSemTenant = jwt.sign({ type: 'access', userId: 'u', role: 'OWNER' }, env.jwtSecret, {
      expiresIn: '8h',
      algorithm: 'HS256',
    });

    const resposta = await request(app)
      .get('/clientes')
      .set('Authorization', `Bearer ${tokenSemTenant}`);
    expect(resposta.status).toBe(401);
  });

  it('token de MFA não pode ser reaproveitado como sessão', async () => {
    const challenge = signPurposeToken('algum-usuario', 'mfa_challenge', '5m');
    const resposta = await request(app).get('/clientes').set('Authorization', `Bearer ${challenge}`);
    expect(resposta.status).toBe(401);
  });
});

describe('MFA — replay de código TOTP', () => {
  it('o mesmo código TOTP não é aceito duas vezes (RFC 6238 §5.2)', async () => {
    const senhaHash = await bcrypt.hash(SENHA, BCRYPT_COST);
    const admin = await prismaUnscoped.user.create({
      data: {
        tenantId: tenantA.id,
        email: 'admin-replay@regressao-a.ficticio.com',
        passwordHash: senhaHash,
        role: 'ADMIN',
      },
    });

    // Configura o MFA e guarda o segredo para gerar códigos no teste.
    const login1 = await request(app)
      .post('/auth/login')
      .send({ email: admin.email, senha: SENHA });
    const setup = await request(app)
      .post('/auth/mfa/setup')
      .send({ setupToken: login1.body.setupToken });
    const secret: string = setup.body.secret;
    await request(app)
      .post('/auth/mfa/enable')
      .send({ setupToken: login1.body.setupToken, code: authenticator.generate(secret) });

    // Duas tentativas de verificar com o MESMO código, na mesma janela.
    const login2 = await request(app)
      .post('/auth/login')
      .send({ email: admin.email, senha: SENHA });
    const login3 = await request(app)
      .post('/auth/login')
      .send({ email: admin.email, senha: SENHA });

    const codigo = authenticator.generate(secret);
    const primeira = await request(app)
      .post('/auth/mfa/verify')
      .send({ challengeToken: login2.body.challengeToken, code: codigo });
    const segunda = await request(app)
      .post('/auth/mfa/verify')
      .send({ challengeToken: login3.body.challengeToken, code: codigo });

    // O código do /mfa/enable já queimou a janela atual, então a primeira
    // verificação pode falhar; o que não pode, em hipótese alguma, é o
    // mesmo código valer duas vezes.
    expect([primeira.status, segunda.status].filter((s) => s === 200).length).toBeLessThanOrEqual(1);
    expect(segunda.status).toBe(401);
  });
});

describe('Login — e-mail repetido entre tenants', () => {
  it('cada senha autentica no seu próprio tenant, sem escolher um arbitrariamente', async () => {
    const email = 'mesmo-email@regressao.ficticio.com';
    const senhaA = 'SenhaDoTenantA1!';
    const senhaB = 'SenhaDoTenantB2!';

    await prismaUnscoped.user.create({
      data: {
        tenantId: tenantA.id,
        email,
        passwordHash: await bcrypt.hash(senhaA, BCRYPT_COST),
        role: 'ATENDENTE',
      },
    });
    await prismaUnscoped.user.create({
      data: {
        tenantId: tenantB.id,
        email,
        passwordHash: await bcrypt.hash(senhaB, BCRYPT_COST),
        role: 'ATENDENTE',
      },
    });

    const loginA = await request(app).post('/auth/login').send({ email, senha: senhaA });
    expect(loginA.status).toBe(200);
    const payloadA = jwt.decode(loginA.body.accessToken) as { tenantId: string };
    expect(payloadA.tenantId).toBe(tenantA.id);

    clearAllRateLimits();

    const loginB = await request(app).post('/auth/login').send({ email, senha: senhaB });
    expect(loginB.status).toBe(200);
    const payloadB = jwt.decode(loginB.body.accessToken) as { tenantId: string };
    expect(payloadB.tenantId).toBe(tenantB.id);
  });

  it('login é case-insensitive no e-mail', async () => {
    const resposta = await request(app)
      .post('/auth/login')
      .send({ email: 'ATENDENTE@Regressao-A.Ficticio.Com', senha: SENHA });
    expect(resposta.status).toBe(200);
  });
});

describe('Refresh token — reuso de token roubado', () => {
  it('reusar um refresh token já rotacionado derruba todas as sessões do usuário', async () => {
    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'atendente@regressao-a.ficticio.com', senha: SENHA });
    const refreshOriginal: string = login.body.refreshToken;

    // Uso legítimo: rotaciona e gera um novo par.
    const rotacao = await request(app).post('/auth/refresh').send({ refreshToken: refreshOriginal });
    expect(rotacao.status).toBe(200);
    const refreshNovo: string = rotacao.body.refreshToken;

    // Atacante tenta usar a cópia antiga.
    const reuso = await request(app).post('/auth/refresh').send({ refreshToken: refreshOriginal });
    expect(reuso.status).toBe(401);

    // O token legítimo também cai: assumimos comprometimento da sessão.
    const aposDeteccao = await request(app).post('/auth/refresh').send({ refreshToken: refreshNovo });
    expect(aposDeteccao.status).toBe(401);
  });
});

describe('Entradas malformadas viram 400, não 500', () => {
  it('email de tipo errado ao criar cliente responde 400', async () => {
    const resposta = await request(app)
      .post('/clientes')
      .set('Authorization', `Bearer ${tokenAtendenteA}`)
      .send({ nome: 'Fulano Fictício', telefone: '+55 11 90000-0000', email: 12345 });
    expect(resposta.status).toBe(400);
  });

  it('nome absurdamente longo ao criar cliente responde 400', async () => {
    const resposta = await request(app)
      .post('/clientes')
      .set('Authorization', `Bearer ${tokenAtendenteA}`)
      .send({ nome: 'x'.repeat(5000), telefone: '+55 11 90000-0000' });
    expect(resposta.status).toBe(400);
  });

  it('email inválido ao criar usuário responde 400', async () => {
    const resposta = await request(app)
      .post('/usuarios')
      .set('Authorization', `Bearer ${tokenOwnerA}`)
      .send({ email: 'isto-nao-e-email', senha: 'SenhaValida123', role: 'ATENDENTE' });
    expect(resposta.status).toBe(400);
  });
});

describe('RBAC — proteções contra auto-sabotagem', () => {
  it('usuário não consegue desativar a própria conta', async () => {
    const owner = await prismaUnscoped.user.findFirst({
      where: { email: 'owner@regressao-a.ficticio.com' },
    });

    const resposta = await request(app)
      .delete(`/usuarios/${owner!.id}`)
      .set('Authorization', `Bearer ${tokenOwnerA}`);

    // Owner é protegido por regra própria; o importante é que não desative.
    expect([400, 403]).toContain(resposta.status);
    const aindaAtivo = await prismaUnscoped.user.findFirst({ where: { id: owner!.id } });
    expect(aindaAtivo?.active).toBe(true);
  });

  it('Admin não consegue desativar a si mesmo', async () => {
    const senhaHash = await bcrypt.hash(SENHA, BCRYPT_COST);
    const admin = await prismaUnscoped.user.create({
      data: {
        tenantId: tenantA.id,
        email: 'admin-auto@regressao-a.ficticio.com',
        passwordHash: senhaHash,
        role: 'ADMIN',
      },
    });
    const tokenAdmin = await loginComMfa('admin-auto@regressao-a.ficticio.com');

    const resposta = await request(app)
      .delete(`/usuarios/${admin.id}`)
      .set('Authorization', `Bearer ${tokenAdmin}`);

    expect(resposta.status).toBe(400);
    const aindaAtivo = await prismaUnscoped.user.findFirst({ where: { id: admin.id } });
    expect(aindaAtivo?.active).toBe(true);
  });
});

describe('Upload multipart — tenant_id forjado em campo de formulário', () => {
  it('campo tenantId no multipart é ignorado; o arquivo fica no tenant do token', async () => {
    const resposta = await request(app)
      .post('/arquivos')
      .set('Authorization', `Bearer ${tokenAtendenteA}`)
      .field('tipo', 'documento')
      .field('tenantId', tenantB.id)
      .attach('arquivo', PNG_MAGIC_BYTES, 'spoof.png');

    expect(resposta.status).toBe(201);
    const arquivo = await prismaUnscoped.arquivo.findFirst({
      where: { id: resposta.body.arquivo.id },
    });
    expect(arquivo?.tenantId).toBe(tenantA.id);
  });
});
