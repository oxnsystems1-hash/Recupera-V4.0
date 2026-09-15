import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app';
import { prismaUnscoped } from '../src/lib/prisma';
import { clearAllRateLimits } from '../src/lib/rateLimiter';
import { BCRYPT_COST } from '../src/config/security';

/**
 * TESTE OBRIGATÓRIO — Dia 3 (Prompt 1.3):
 * Autenticar como Atendente e tentar (1) gerenciar usuários, (2) excluir
 * cliente, (3) alterar permissão de outro usuário — via API direta.
 * Esperado: 403 em todos os casos (RBAC negado — diferente do Dia 2, aqui
 * o dado existe no mesmo tenant, então não há motivo para mascarar com 404).
 *
 * Resultado documentado em /docs/resultado-teste-rbac-dia3.md.
 */

const app = createApp();
const SENHA = 'SenhaFicticia123!';

let tenant: { id: string };
let admin: { id: string };
let atendente: { id: string };
let cliente: { id: string };
let tokenAtendente: string;

describe('RBAC — escalação de privilégio (Atendente tentando agir como Admin/Owner)', () => {
  beforeAll(async () => {
    clearAllRateLimits();
    await prismaUnscoped.cliente.deleteMany();
    await prismaUnscoped.refreshToken.deleteMany();
    await prismaUnscoped.user.deleteMany();
    await prismaUnscoped.tenant.deleteMany();

    const senhaHash = await bcrypt.hash(SENHA, BCRYPT_COST);

    tenant = await prismaUnscoped.tenant.create({
      data: { nome: 'Clínica Fictícia RBAC', segmento: 'clinica_estetica' },
    });

    admin = await prismaUnscoped.user.create({
      data: {
        tenantId: tenant.id,
        email: 'admin@rbac.ficticio.com',
        passwordHash: senhaHash,
        role: 'ADMIN',
      },
    });

    atendente = await prismaUnscoped.user.create({
      data: {
        tenantId: tenant.id,
        email: 'atendente@rbac.ficticio.com',
        passwordHash: senhaHash,
        role: 'ATENDENTE',
      },
    });

    cliente = await prismaUnscoped.cliente.create({
      data: { tenantId: tenant.id, nome: 'Cliente Fictício RBAC', telefone: '+55 11 90000-0009' },
    });

    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'atendente@rbac.ficticio.com', senha: SENHA });

    expect(login.status).toBe(200);
    tokenAtendente = login.body.accessToken;
  });

  afterAll(async () => {
    await prismaUnscoped.cliente.deleteMany();
    await prismaUnscoped.refreshToken.deleteMany();
    await prismaUnscoped.user.deleteMany();
    await prismaUnscoped.tenant.deleteMany();
    await prismaUnscoped.$disconnect();
  });

  it('(1) Atendente tentando gerenciar usuários (listar) → 403', async () => {
    const response = await request(app)
      .get('/usuarios')
      .set('Authorization', `Bearer ${tokenAtendente}`);
    expect(response.status).toBe(403);
  });

  it('(1) Atendente tentando gerenciar usuários (criar) → 403', async () => {
    const response = await request(app)
      .post('/usuarios')
      .set('Authorization', `Bearer ${tokenAtendente}`)
      .send({ email: 'novo@rbac.ficticio.com', senha: SENHA, role: 'ATENDENTE' });
    expect(response.status).toBe(403);
  });

  it('(2) Atendente tentando excluir cliente → 403', async () => {
    const response = await request(app)
      .delete(`/clientes/${cliente.id}`)
      .set('Authorization', `Bearer ${tokenAtendente}`);
    expect(response.status).toBe(403);
  });

  it('(3) Atendente tentando alterar permissão de outro usuário (Atendente→Admin) → 403', async () => {
    const response = await request(app)
      .patch(`/usuarios/${admin.id}/role`)
      .set('Authorization', `Bearer ${tokenAtendente}`)
      .send({ role: 'ADMIN' });
    expect(response.status).toBe(403);
  });

  it('sanidade: Admin sem MFA configurado não recebe sessão direto no login', async () => {
    const loginAdmin = await request(app)
      .post('/auth/login')
      .send({ email: 'admin@rbac.ficticio.com', senha: SENHA });

    // Admin exige MFA (Prompt 1.3) — login deve pedir setup, não conceder sessão direto.
    expect(loginAdmin.status).toBe(200);
    expect(loginAdmin.body.mfaSetupRequired).toBe(true);
  });

  it('cliente da própria RBAC permanece intacto (Atendente não conseguiu excluir)', async () => {
    const ainda = await prismaUnscoped.cliente.findFirst({ where: { id: cliente.id } });
    expect(ainda).not.toBeNull();
  });
});
