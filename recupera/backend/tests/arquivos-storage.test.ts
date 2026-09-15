import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { createApp } from '../src/app';
import { prismaUnscoped } from '../src/lib/prisma';
import { storage } from '../src/lib/storage/localFilesystemStorage';
import { signFileToken } from '../src/lib/signedUrl';
import { runRetentionSweep } from '../src/jobs/retentionSweep';
import { BCRYPT_COST } from '../src/config/security';

/**
 * TESTE OBRIGATÓRIO — Dia 4 (Prompt 2.1):
 * "Upload inválido rejeitado · URL expirada negada · exclusão real
 * verificada no storage."
 *
 * Resultado documentado em /docs/resultado-teste-storage-dia4.md.
 */

const app = createApp();
const SENHA = 'SenhaFicticia123!';
const PNG_MAGIC_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let tenantA: { id: string };
let tenantB: { id: string };
let tokenTenantA: string;
/** Exclusão e bloqueio de exclusão são restritos a Owner/Admin (mesma
 * régua de "exclusão de clientes" do Dia 3) — precisa de um token com um
 * desses papéis, o que exige completar o handshake de MFA. */
let tokenOwnerTenantA: string;

describe('Storage privado e retenção', () => {
  beforeAll(async () => {
    await prismaUnscoped.$executeRawUnsafe('TRUNCATE "logs_auditoria"');
  await prismaUnscoped.solicitacaoLgpd.deleteMany();
    await prismaUnscoped.arquivo.deleteMany();
    await prismaUnscoped.refreshToken.deleteMany();
    await prismaUnscoped.user.deleteMany();
    await prismaUnscoped.tenant.deleteMany();

    const senhaHash = await bcrypt.hash(SENHA, BCRYPT_COST);

    tenantA = await prismaUnscoped.tenant.create({
      data: { nome: 'Clínica Fictícia Storage A', segmento: 'clinicas_saude_odonto_estetica' },
    });
    tenantB = await prismaUnscoped.tenant.create({
      data: { nome: 'Salão Fictício Storage B', segmento: 'saloes_estudios_estetica' },
    });

    await prismaUnscoped.user.create({
      data: {
        tenantId: tenantA.id,
        email: 'atendente@storage-a.ficticio.com',
        passwordHash: senhaHash,
        role: 'ATENDENTE',
      },
    });
    await prismaUnscoped.user.create({
      data: {
        tenantId: tenantA.id,
        email: 'owner@storage-a.ficticio.com',
        passwordHash: senhaHash,
        role: 'OWNER',
      },
    });

    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'atendente@storage-a.ficticio.com', senha: SENHA });
    expect(login.status).toBe(200);
    tokenTenantA = login.body.accessToken;

    const loginOwner = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@storage-a.ficticio.com', senha: SENHA });
    expect(loginOwner.body.mfaSetupRequired).toBe(true);
    const setup = await request(app)
      .post('/auth/mfa/setup')
      .send({ setupToken: loginOwner.body.setupToken });
    const enable = await request(app).post('/auth/mfa/enable').send({
      setupToken: loginOwner.body.setupToken,
      code: authenticator.generate(setup.body.secret),
    });
    expect(enable.status).toBe(200);
    tokenOwnerTenantA = enable.body.accessToken;
  });

  afterAll(async () => {
    await prismaUnscoped.$executeRawUnsafe('TRUNCATE "logs_auditoria"');
  await prismaUnscoped.solicitacaoLgpd.deleteMany();
    await prismaUnscoped.arquivo.deleteMany();
    await prismaUnscoped.refreshToken.deleteMany();
    await prismaUnscoped.user.deleteMany();
    await prismaUnscoped.tenant.deleteMany();
    await prismaUnscoped.$disconnect();
  });

  it('upload inválido (bytes que não batem com nenhum tipo permitido) é rejeitado, mesmo com extensão de imagem', async () => {
    const antesCount = await prismaUnscoped.arquivo.count();

    const response = await request(app)
      .post('/arquivos')
      .set('Authorization', `Bearer ${tokenTenantA}`)
      .field('tipo', 'documento')
      .attach('arquivo', Buffer.from('isto nao e uma imagem de verdade'), 'malware.png');

    expect(response.status).toBe(415);
    // Nenhum registro órfão criado.
    expect(await prismaUnscoped.arquivo.count()).toBe(antesCount);
  });

  it('tipo de categoria inválido (path traversal) é rejeitado antes de tocar o storage', async () => {
    const response = await request(app)
      .post('/arquivos')
      .set('Authorization', `Bearer ${tokenTenantA}`)
      .field('tipo', '../../etc')
      .attach('arquivo', PNG_MAGIC_BYTES, 'foto.png');

    expect(response.status).toBe(400);
  });

  it('upload válido é aceito, com MIME detectado pelos bytes reais', async () => {
    const response = await request(app)
      .post('/arquivos')
      .set('Authorization', `Bearer ${tokenTenantA}`)
      .field('tipo', 'documento')
      .attach('arquivo', PNG_MAGIC_BYTES, 'foto-perfil.png');

    expect(response.status).toBe(201);
    expect(response.body.arquivo.mimeType).toBe('image/png');
  });

  describe('URL assinada e download', () => {
    let arquivoId: string;

    beforeAll(async () => {
      const upload = await request(app)
        .post('/arquivos')
        .set('Authorization', `Bearer ${tokenTenantA}`)
        .field('tipo', 'documento')
        .attach('arquivo', PNG_MAGIC_BYTES, 'para-url.png');
      arquivoId = upload.body.arquivo.id;
    });

    it('URL assinada válida permite baixar o arquivo dentro do prazo', async () => {
      const geracao = await request(app)
        .get(`/arquivos/${arquivoId}/url`)
        .set('Authorization', `Bearer ${tokenTenantA}`);
      expect(geracao.status).toBe(200);

      const url = new URL(geracao.body.url, 'http://localhost');
      const download = await request(app).get(url.pathname + url.search);
      expect(download.status).toBe(200);
      expect(download.headers['content-type']).toContain('image/png');

      // Log de geração de URL foi registrado (bullet ACESSO do Prompt 2.1);
      // desde o Dia 5 ele vive no log de auditoria geral e imutável.
      const log = await prismaUnscoped.logAuditoria.findFirst({
        where: { acao: 'ARQUIVO_URL_GERADA', entidadeId: arquivoId },
      });
      expect(log).not.toBeNull();
    });

    it('URL expirada é negada (nunca serve o arquivo)', async () => {
      const { token } = signFileToken(arquivoId, -10); // já nasce expirado
      const response = await request(app).get('/arquivos/download').query({ token });
      expect(response.status).toBe(401);
    });

    it('token adulterado (assinatura não bate) é negado', async () => {
      const { token } = signFileToken(arquivoId, 900);
      const tokenAdulterado = token.slice(0, -2) + (token.slice(-2) === 'aa' ? 'bb' : 'aa');
      const response = await request(app).get('/arquivos/download').query({ token: tokenAdulterado });
      expect(response.status).toBe(401);
    });

    it('acessar URL de arquivo de outro tenant é negado com 404 (nunca 403)', async () => {
      const arquivoTenantB = await prismaUnscoped.arquivo.create({
        data: {
          tenantId: tenantB.id,
          tipo: 'documento',
          nomeOriginal: 'segredo-b.png',
          mimeType: 'image/png',
          tamanhoBytes: PNG_MAGIC_BYTES.length,
          storagePath: `${tenantB.id}/documento/arquivo-tenant-b.png`,
          retentionUntil: new Date(Date.now() + 86_400_000),
        },
      });
      await storage.save(arquivoTenantB.storagePath, PNG_MAGIC_BYTES);

      const response = await request(app)
        .get(`/arquivos/${arquivoTenantB.id}/url`)
        .set('Authorization', `Bearer ${tokenTenantA}`);
      expect(response.status).toBe(404);
    });
  });

  describe('Exclusão real e bloqueio legal', () => {
    it('exclusão remove o registro e os bytes de verdade do storage', async () => {
      const upload = await request(app)
        .post('/arquivos')
        .set('Authorization', `Bearer ${tokenTenantA}`)
        .field('tipo', 'documento')
        .attach('arquivo', PNG_MAGIC_BYTES, 'para-excluir.png');
      const arquivoId = upload.body.arquivo.id;

      const registro = await prismaUnscoped.arquivo.findFirst({ where: { id: arquivoId } });
      expect(await storage.exists(registro!.storagePath)).toBe(true);

      const exclusao = await request(app)
        .delete(`/arquivos/${arquivoId}`)
        .set('Authorization', `Bearer ${tokenOwnerTenantA}`);
      expect(exclusao.status).toBe(204);

      // Exclusão real, verificada no storage — não é soft delete cosmético.
      expect(await storage.exists(registro!.storagePath)).toBe(false);
      expect(await prismaUnscoped.arquivo.findFirst({ where: { id: arquivoId } })).toBeNull();
    });

    it('arquivo com exclusão bloqueada (prazo legal) não pode ser excluído manualmente', async () => {
      const upload = await request(app)
        .post('/arquivos')
        .set('Authorization', `Bearer ${tokenTenantA}`)
        .field('tipo', 'documento')
        .attach('arquivo', PNG_MAGIC_BYTES, 'nota-fiscal.png');
      const arquivoId = upload.body.arquivo.id;

      const bloqueio = await request(app)
        .patch(`/arquivos/${arquivoId}/bloqueio`)
        .set('Authorization', `Bearer ${tokenOwnerTenantA}`)
        .send({ bloqueado: true, motivo: 'Nota fiscal — guarda obrigatória de 5 anos.' });
      expect(bloqueio.status).toBe(200);

      const exclusao = await request(app)
        .delete(`/arquivos/${arquivoId}`)
        .set('Authorization', `Bearer ${tokenOwnerTenantA}`);
      expect(exclusao.status).toBe(409);

      const registro = await prismaUnscoped.arquivo.findFirst({ where: { id: arquivoId } });
      expect(registro).not.toBeNull();
      expect(await storage.exists(registro!.storagePath)).toBe(true);
    });
  });

  describe('Varredura automática de retenção', () => {
    it('remove (bytes + registro) arquivo com retenção vencida', async () => {
      const storagePath = `${tenantA.id}/documento/vencido-${Date.now()}.png`;
      await storage.save(storagePath, PNG_MAGIC_BYTES);
      const arquivo = await prismaUnscoped.arquivo.create({
        data: {
          tenantId: tenantA.id,
          tipo: 'documento',
          nomeOriginal: 'vencido.png',
          mimeType: 'image/png',
          tamanhoBytes: PNG_MAGIC_BYTES.length,
          storagePath,
          retentionUntil: new Date(Date.now() - 1000),
        },
      });

      const resultado = await runRetentionSweep();
      expect(resultado.removidos).toBeGreaterThanOrEqual(1);
      expect(await storage.exists(storagePath)).toBe(false);
      expect(await prismaUnscoped.arquivo.findFirst({ where: { id: arquivo.id } })).toBeNull();
    });

    it('respeita bloqueio legal: não remove arquivo vencido marcado como exclusaoBloqueada', async () => {
      const storagePath = `${tenantA.id}/documento/vencido-bloqueado-${Date.now()}.png`;
      await storage.save(storagePath, PNG_MAGIC_BYTES);
      const arquivo = await prismaUnscoped.arquivo.create({
        data: {
          tenantId: tenantA.id,
          tipo: 'documento',
          nomeOriginal: 'vencido-bloqueado.png',
          mimeType: 'image/png',
          tamanhoBytes: PNG_MAGIC_BYTES.length,
          storagePath,
          retentionUntil: new Date(Date.now() - 1000),
          exclusaoBloqueada: true,
          motivoBloqueioExclusao: 'Obrigação fiscal.',
        },
      });

      await runRetentionSweep();

      expect(await storage.exists(storagePath)).toBe(true);
      expect(await prismaUnscoped.arquivo.findFirst({ where: { id: arquivo.id } })).not.toBeNull();

      // limpeza manual (este arquivo não deve sobreviver ao afterAll normal
      // porque está bloqueado)
      await prismaUnscoped.arquivo.delete({ where: { id: arquivo.id } });
      await storage.delete(storagePath);
    });
  });
});
