import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app';
import { prismaUnscoped } from '../src/lib/prisma';

/**
 * TESTE OBRIGATÓRIO — Dia 2 (Prompt 1.2):
 * 1. Cria Tenant A e Tenant B com dados fictícios.
 * 2. Autentica como usuária do Tenant A.
 * 3. Tenta acessar dado do Tenant B via ID, listagem e busca.
 * 4. Confirma resposta sempre 404 (nunca 403).
 *
 * Resultado documentado em /docs/resultado-teste-isolamento-dia2.md.
 */

const app = createApp();
const SENHA = 'SenhaFicticia123!';

let tenantA: { id: string };
let tenantB: { id: string };
let clienteTenantB: { id: string };
let tokenTenantA: string;

describe('Isolamento de tenant', () => {
  beforeAll(async () => {
    await prismaUnscoped.cliente.deleteMany();
    await prismaUnscoped.user.deleteMany();
    await prismaUnscoped.tenant.deleteMany();

    const senhaHash = await bcrypt.hash(SENHA, 12);

    tenantA = await prismaUnscoped.tenant.create({
      data: { nome: 'Clínica Fictícia A', segmento: 'clinica_estetica' },
    });
    tenantB = await prismaUnscoped.tenant.create({
      data: { nome: 'Salão Fictício B', segmento: 'salao' },
    });

    await prismaUnscoped.user.create({
      data: {
        tenantId: tenantA.id,
        email: 'usuaria@tenant-a.ficticio.com',
        passwordHash: senhaHash,
        role: 'ATENDENTE',
      },
    });

    await prismaUnscoped.cliente.create({
      data: { tenantId: tenantA.id, nome: 'Cliente Fictício A1', telefone: '+55 11 90000-0001' },
    });

    clienteTenantB = await prismaUnscoped.cliente.create({
      data: {
        tenantId: tenantB.id,
        nome: 'Cliente Fictício B1 - Segredo',
        telefone: '+55 11 90000-0002',
      },
    });

    const loginResponse = await request(app)
      .post('/auth/login')
      .send({ email: 'usuaria@tenant-a.ficticio.com', senha: SENHA });

    expect(loginResponse.status).toBe(200);
    tokenTenantA = loginResponse.body.accessToken;
  });

  afterAll(async () => {
    await prismaUnscoped.cliente.deleteMany();
    await prismaUnscoped.user.deleteMany();
    await prismaUnscoped.tenant.deleteMany();
    await prismaUnscoped.$disconnect();
  });

  it('sem token, acesso é negado (401) antes mesmo do isolamento de tenant', async () => {
    const response = await request(app).get('/clientes');
    expect(response.status).toBe(401);
  });

  it('busca por ID de cliente de outro tenant → 404 (nunca 403)', async () => {
    const response = await request(app)
      .get(`/clientes/${clienteTenantB.id}`)
      .set('Authorization', `Bearer ${tokenTenantA}`);

    expect(response.status).toBe(404);
    expect(response.status).not.toBe(403);
  });

  it('listagem nunca inclui dados de outro tenant', async () => {
    const response = await request(app)
      .get('/clientes')
      .set('Authorization', `Bearer ${tokenTenantA}`);

    expect(response.status).toBe(200);
    const ids = (response.body.clientes as Array<{ id: string }>).map((c) => c.id);
    expect(ids).not.toContain(clienteTenantB.id);
  });

  it('busca textual nunca retorna resultado de outro tenant', async () => {
    const response = await request(app)
      .get('/clientes')
      .query({ q: 'Segredo' })
      .set('Authorization', `Bearer ${tokenTenantA}`);

    expect(response.status).toBe(200);
    expect(response.body.clientes).toHaveLength(0);
  });

  it('tenant_id enviado no body é ignorado silenciosamente ao criar', async () => {
    const response = await request(app)
      .post('/clientes')
      .set('Authorization', `Bearer ${tokenTenantA}`)
      .send({ nome: 'Novo Cliente', telefone: '+55 11 90000-0003', tenantId: tenantB.id });

    expect(response.status).toBe(201);
    expect(response.body.cliente.tenantId).toBe(tenantA.id);
  });

  it('tenant_id enviado na query string é ignorado — ainda 404 para dado de outro tenant', async () => {
    const response = await request(app)
      .get(`/clientes/${clienteTenantB.id}`)
      .query({ tenantId: tenantA.id })
      .set('Authorization', `Bearer ${tokenTenantA}`);

    expect(response.status).toBe(404);
  });

  it('busca por ID de cliente do próprio tenant funciona normalmente', async () => {
    const propria = await prismaUnscoped.cliente.findFirst({ where: { tenantId: tenantA.id } });
    const response = await request(app)
      .get(`/clientes/${propria!.id}`)
      .set('Authorization', `Bearer ${tokenTenantA}`);

    expect(response.status).toBe(200);
    expect(response.body.cliente.id).toBe(propria!.id);
  });
});
