import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { BCRYPT_COST } from '../src/config/security';

/**
 * Regressão da ponta solta da trava de aprovação concorrente.
 *
 * A trava reserva a solicitação gravando `aprovadoEm`, e o CAS exige
 * `aprovadoEm: null`. Se a exclusão falhasse DEPOIS da reserva (banco fora
 * do ar, storage indisponível), a solicitação ficava reservada para sempre:
 * status ainda PENDENTE, `aprovadoEm` preenchido, e toda retentativa
 * devolvendo 409. O pedido de exclusão do titular travava em silêncio — uma
 * falha de compliance que ninguém veria.
 *
 * Este arquivo é separado porque força `executarExclusaoDoTitular` a falhar
 * para o módulo inteiro.
 */
vi.mock('../src/modules/lgpd/lgpd.service', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/modules/lgpd/lgpd.service')>();
  return {
    ...original,
    executarExclusaoDoTitular: vi.fn(async () => {
      throw new Error('falha simulada de infraestrutura durante a exclusão');
    }),
  };
});

const { createApp } = await import('../src/app');
const { prismaUnscoped } = await import('../src/lib/prisma');

const app = createApp();
const SENHA = 'SenhaFicticia123!';

let tenantId: string;
let tokenOwner: string;

async function limpar() {
  await prismaUnscoped.$executeRawUnsafe('TRUNCATE "logs_auditoria"');
  await prismaUnscoped.solicitacaoLgpd.deleteMany();
  await prismaUnscoped.arquivo.deleteMany();
  await prismaUnscoped.cliente.deleteMany();
  await prismaUnscoped.refreshToken.deleteMany();
  await prismaUnscoped.user.deleteMany();
  await prismaUnscoped.tenant.deleteMany();
}

beforeAll(async () => {
  await limpar();

  const tenant = await prismaUnscoped.tenant.create({
    data: { nome: 'Tenant Fictício Falha', segmento: 'autoescolas' },
  });
  tenantId = tenant.id;

  await prismaUnscoped.user.create({
    data: {
      tenantId,
      email: 'owner@falha.ficticio.com',
      passwordHash: await bcrypt.hash(SENHA, BCRYPT_COST),
      role: 'OWNER',
    },
  });

  const login = await request(app)
    .post('/auth/login')
    .send({ email: 'owner@falha.ficticio.com', senha: SENHA });
  const setup = await request(app)
    .post('/auth/mfa/setup')
    .send({ setupToken: login.body.setupToken });
  const enable = await request(app).post('/auth/mfa/enable').send({
    setupToken: login.body.setupToken,
    code: authenticator.generate(setup.body.secret),
  });
  tokenOwner = enable.body.accessToken;
});

afterAll(async () => {
  await limpar();
  await prismaUnscoped.$disconnect();
});

describe('Aprovação de exclusão que falha no meio', () => {
  it('libera a reserva para que o pedido possa ser retentado, em vez de travar em 409', async () => {
    const titular = await prismaUnscoped.cliente.create({
      data: { tenantId, nome: 'Titular Fictício', telefone: '+55 11 90000-0000' },
    });

    const solicitacao = await request(app)
      .delete('/lgpd/excluir')
      .set('Authorization', `Bearer ${tokenOwner}`)
      .send({ clienteId: titular.id });
    expect(solicitacao.status).toBe(202);

    const url = `/lgpd/solicitacoes/${solicitacao.body.solicitacaoId}/aprovar`;

    // A exclusão falha: o handler devolve 500 (errorHandler central).
    const primeira = await request(app).post(url).set('Authorization', `Bearer ${tokenOwner}`);
    expect(primeira.status).toBe(500);

    // A reserva precisa ter sido liberada: PENDENTE e sem aprovadoEm.
    const apos = await prismaUnscoped.solicitacaoLgpd.findFirst({
      where: { id: solicitacao.body.solicitacaoId },
    });
    expect(apos?.status).toBe('PENDENTE');
    expect(apos?.aprovadoEm).toBeNull();

    // E a retentativa precisa voltar a ser possível — antes da correção,
    // esta segunda chamada devolvia 409 para sempre.
    const segunda = await request(app).post(url).set('Authorization', `Bearer ${tokenOwner}`);
    expect(segunda.status).not.toBe(409);
  });
});
