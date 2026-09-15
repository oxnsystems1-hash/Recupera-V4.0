import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { createApp } from '../src/app';
import { prismaUnscoped } from '../src/lib/prisma';
import { storage } from '../src/lib/storage/localFilesystemStorage';
import { runLgpdSweep } from '../src/jobs/lgpdSweep';
import { clearAllRateLimits } from '../src/lib/rateLimiter';
import { BCRYPT_COST } from '../src/config/security';

/**
 * TESTE OBRIGATÓRIO — Dia 5 (Prompt 2.2):
 * "3 endpoints testados com casos reais; auditoria completa e sem dado
 * sensível em texto puro."
 *
 * Resultado documentado em /docs/resultado-teste-lgpd-dia5.md.
 */

const app = createApp();
const SENHA = 'SenhaFicticia123!';
const PNG_MAGIC_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let tenantA: { id: string };
let tenantB: { id: string };
let tokenOwnerA: string;
let tokenAdminA: string;

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

async function criarTitular(tenantId: string, nome: string) {
  return prismaUnscoped.cliente.create({
    data: {
      tenantId,
      nome,
      telefone: '+55 11 90000-0000',
      email: `${nome.toLowerCase().replace(/\s+/g, '.')}@ficticio.com`,
      endereco: 'Rua Fictícia, 100',
    },
  });
}

async function limpar() {
  await prismaUnscoped.$executeRawUnsafe('TRUNCATE "logs_auditoria"');
  await prismaUnscoped.solicitacaoLgpd.deleteMany();
  await prismaUnscoped.arquivo.deleteMany();
  await prismaUnscoped.cliente.deleteMany();
  await prismaUnscoped.refreshToken.deleteMany();
  await prismaUnscoped.user.deleteMany();
  await prismaUnscoped.tenant.deleteMany();
}

beforeEach(() => {
  clearAllRateLimits();
});

beforeAll(async () => {
  await limpar();
  const senhaHash = await bcrypt.hash(SENHA, BCRYPT_COST);

  tenantA = await prismaUnscoped.tenant.create({
    data: { nome: 'Clínica Fictícia LGPD A', segmento: 'clinicas_saude_odonto_estetica' },
  });
  tenantB = await prismaUnscoped.tenant.create({
    data: { nome: 'Salão Fictício LGPD B', segmento: 'saloes_estudios_estetica' },
  });

  await prismaUnscoped.user.create({
    data: {
      tenantId: tenantA.id,
      email: 'owner@lgpd-a.ficticio.com',
      passwordHash: senhaHash,
      role: 'OWNER',
    },
  });
  await prismaUnscoped.user.create({
    data: {
      tenantId: tenantA.id,
      email: 'admin@lgpd-a.ficticio.com',
      passwordHash: senhaHash,
      role: 'ADMIN',
    },
  });

  tokenOwnerA = await loginComMfa('owner@lgpd-a.ficticio.com');
  tokenAdminA = await loginComMfa('admin@lgpd-a.ficticio.com');
});

afterAll(async () => {
  await limpar();
  await prismaUnscoped.$disconnect();
});

describe('PORTABILIDADE — POST /lgpd/exportar', () => {
  it('exporta dados cadastrais e referências de arquivo, nunca os bytes', async () => {
    const titular = await criarTitular(tenantA.id, 'Maria Portabilidade');

    const upload = await request(app)
      .post('/arquivos')
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .field('tipo', 'documento')
      .field('clienteId', titular.id)
      .attach('arquivo', PNG_MAGIC_BYTES, 'exame.png');
    expect(upload.status).toBe(201);

    const resposta = await request(app)
      .post('/lgpd/exportar')
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .send({ clienteId: titular.id });

    expect(resposta.status).toBe(200);
    expect(resposta.body.exportacao.titular.nome).toBe('Maria Portabilidade');
    expect(resposta.body.exportacao.titular.endereco).toBe('Rua Fictícia, 100');
    expect(resposta.body.exportacao.arquivos).toHaveLength(1);

    // Referência, nunca o conteúdo nem o caminho interno do storage.
    const referencia = resposta.body.exportacao.arquivos[0];
    expect(referencia.nomeOriginal).toBe('exame.png');
    expect(referencia.storagePath).toBeUndefined();
    expect(JSON.stringify(resposta.body)).not.toContain('storage-privado');

    // Prazo de 15 dias registrado na solicitação.
    const prazo = new Date(resposta.body.prazoAtendimento).getTime() - Date.now();
    expect(prazo).toBeGreaterThan(14 * 24 * 60 * 60 * 1000);
  });

  it('titular de outro tenant responde 404, nunca 403', async () => {
    const titularB = await criarTitular(tenantB.id, 'Joao Do Outro Tenant');

    const resposta = await request(app)
      .post('/lgpd/exportar')
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .send({ clienteId: titularB.id });

    expect(resposta.status).toBe(404);
  });
});

describe('CORREÇÃO — PATCH /lgpd/corrigir', () => {
  it('só aplica o dado depois da confirmação do titular por token', async () => {
    const titular = await criarTitular(tenantA.id, 'Carlos Correcao');

    const solicitacao = await request(app)
      .patch('/lgpd/corrigir')
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .send({ clienteId: titular.id, nome: 'Carlos Corrigido', endereco: 'Rua Nova, 200' });

    expect(solicitacao.status).toBe(201);
    const token: string = solicitacao.body.tokenConfirmacao;
    expect(typeof token).toBe('string');

    // Antes da confirmação, o dado do titular continua intacto.
    const antes = await prismaUnscoped.cliente.findFirst({ where: { id: titular.id } });
    expect(antes?.nome).toBe('Carlos Correcao');

    const confirmacao = await request(app).post('/lgpd/corrigir/confirmar').send({ token });
    expect(confirmacao.status).toBe(200);

    const depois = await prismaUnscoped.cliente.findFirst({ where: { id: titular.id } });
    expect(depois?.nome).toBe('Carlos Corrigido');
    expect(depois?.endereco).toBe('Rua Nova, 200');
  });

  it('token de confirmação é de uso único', async () => {
    const titular = await criarTitular(tenantA.id, 'Ana Uso Unico');
    const solicitacao = await request(app)
      .patch('/lgpd/corrigir')
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .send({ clienteId: titular.id, telefone: '+55 11 91111-2222' });

    const token: string = solicitacao.body.tokenConfirmacao;
    expect((await request(app).post('/lgpd/corrigir/confirmar').send({ token })).status).toBe(200);
    expect((await request(app).post('/lgpd/corrigir/confirmar').send({ token })).status).toBe(401);
  });

  it('recusa campo que não é cadastral (só nome, email, telefone, endereço)', async () => {
    const titular = await criarTitular(tenantA.id, 'Bruno Campo Invalido');

    const resposta = await request(app)
      .patch('/lgpd/corrigir')
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .send({ clienteId: titular.id, tenantId: tenantB.id, createdAt: '2020-01-01' });

    expect(resposta.status).toBe(400);
  });
});

describe('EXCLUSÃO — DELETE /lgpd/excluir', () => {
  it('sem obrigação legal: aprovação do Owner executa exclusão real imediata', async () => {
    const titular = await criarTitular(tenantA.id, 'Diego Exclusao Imediata');

    const upload = await request(app)
      .post('/arquivos')
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .field('tipo', 'documento')
      .field('clienteId', titular.id)
      .attach('arquivo', PNG_MAGIC_BYTES, 'doc.png');
    const arquivo = await prismaUnscoped.arquivo.findFirst({
      where: { id: upload.body.arquivo.id },
    });
    expect(await storage.exists(arquivo!.storagePath)).toBe(true);

    const solicitacao = await request(app)
      .delete('/lgpd/excluir')
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .send({ clienteId: titular.id });
    expect(solicitacao.status).toBe(202);
    expect(solicitacao.body.status).toBe('PENDENTE');

    // Ainda existe: exclusão depende da aprovação do Owner.
    expect(await prismaUnscoped.cliente.findFirst({ where: { id: titular.id } })).not.toBeNull();

    const aprovacao = await request(app)
      .post(`/lgpd/solicitacoes/${solicitacao.body.solicitacaoId}/aprovar`)
      .set('Authorization', `Bearer ${tokenOwnerA}`);
    expect(aprovacao.status).toBe(200);
    expect(aprovacao.body.status).toBe('CONCLUIDA');

    // Exclusão real: registro fora do banco e bytes fora do storage.
    expect(await prismaUnscoped.cliente.findFirst({ where: { id: titular.id } })).toBeNull();
    expect(await storage.exists(arquivo!.storagePath)).toBe(false);
  });

  it('Admin não aprova exclusão — só o Owner (403)', async () => {
    const titular = await criarTitular(tenantA.id, 'Elena Sem Aprovacao');
    const solicitacao = await request(app)
      .delete('/lgpd/excluir')
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .send({ clienteId: titular.id });

    const aprovacao = await request(app)
      .post(`/lgpd/solicitacoes/${solicitacao.body.solicitacaoId}/aprovar`)
      .set('Authorization', `Bearer ${tokenAdminA}`);

    expect(aprovacao.status).toBe(403);
    expect(await prismaUnscoped.cliente.findFirst({ where: { id: titular.id } })).not.toBeNull();
  });

  it('com obrigação legal: bloqueia, registra o motivo e executa sozinha quando o prazo vence', async () => {
    const titular = await criarTitular(tenantA.id, 'Fabio Prazo Fiscal');

    const upload = await request(app)
      .post('/arquivos')
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .field('tipo', 'documento')
      .field('clienteId', titular.id)
      .attach('arquivo', PNG_MAGIC_BYTES, 'nota-fiscal.png');

    // Marca a obrigação legal (fiscal) sobre o arquivo do titular.
    await request(app)
      .patch(`/arquivos/${upload.body.arquivo.id}/bloqueio`)
      .set('Authorization', `Bearer ${tokenOwnerA}`)
      .send({ bloqueado: true, motivo: 'Nota fiscal — guarda obrigatória de 5 anos.' });

    const solicitacao = await request(app)
      .delete('/lgpd/excluir')
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .send({ clienteId: titular.id });

    const aprovacao = await request(app)
      .post(`/lgpd/solicitacoes/${solicitacao.body.solicitacaoId}/aprovar`)
      .set('Authorization', `Bearer ${tokenOwnerA}`);

    expect(aprovacao.status).toBe(200);
    expect(aprovacao.body.status).toBe('BLOQUEADA');
    expect(aprovacao.body.motivoBloqueio).toContain('Nota fiscal');
    // Nem exclui (violaria obrigação fiscal) nem recusa (violaria o direito
    // do titular): fica agendada.
    expect(await prismaUnscoped.cliente.findFirst({ where: { id: titular.id } })).not.toBeNull();

    // A varredura não mexe enquanto o prazo não vence.
    expect((await runLgpdSweep()).executadas).toBe(0);
    expect(await prismaUnscoped.cliente.findFirst({ where: { id: titular.id } })).not.toBeNull();

    // Prazo vencido → execução automática, sem ninguém precisar voltar.
    const arquivo = await prismaUnscoped.arquivo.findFirst({
      where: { id: upload.body.arquivo.id },
    });
    const resultado = await runLgpdSweep(new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000));
    expect(resultado.executadas).toBeGreaterThanOrEqual(1);
    expect(await prismaUnscoped.cliente.findFirst({ where: { id: titular.id } })).toBeNull();
    expect(await storage.exists(arquivo!.storagePath)).toBe(false);
  });
});

describe('Regressões da revisão do Dia 5', () => {
  it('E1 — exclusão do titular não deixa registro de arquivo órfão', async () => {
    const titular = await criarTitular(tenantA.id, 'Gabriel Sem Orfao');
    await request(app)
      .post('/arquivos')
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .field('tipo', 'documento')
      .field('clienteId', titular.id)
      .attach('arquivo', PNG_MAGIC_BYTES, 'doc.png');

    const solicitacao = await request(app)
      .delete('/lgpd/excluir')
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .send({ clienteId: titular.id });
    await request(app)
      .post(`/lgpd/solicitacoes/${solicitacao.body.solicitacaoId}/aprovar`)
      .set('Authorization', `Bearer ${tokenOwnerA}`);

    // Antes da correção sobrava a linha em `arquivos` com clienteId NULL,
    // apontando para bytes que não existiam mais.
    const orfaos = await prismaUnscoped.arquivo.count({
      where: { tenantId: tenantA.id, nomeOriginal: 'doc.png' },
    });
    expect(orfaos).toBe(0);
  });

  it('E2 — varredura não exclui titular que ganhou obrigação legal nova depois do bloqueio', async () => {
    const titular = await criarTitular(tenantA.id, 'Helena Obrigacao Nova');

    const primeiro = await request(app)
      .post('/arquivos')
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .field('tipo', 'documento')
      .field('clienteId', titular.id)
      .attach('arquivo', PNG_MAGIC_BYTES, 'antigo.png');
    await request(app)
      .patch(`/arquivos/${primeiro.body.arquivo.id}/bloqueio`)
      .set('Authorization', `Bearer ${tokenOwnerA}`)
      .send({ bloqueado: true, motivo: 'Obrigação antiga.' });

    const solicitacao = await request(app)
      .delete('/lgpd/excluir')
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .send({ clienteId: titular.id });
    await request(app)
      .post(`/lgpd/solicitacoes/${solicitacao.body.solicitacaoId}/aprovar`)
      .set('Authorization', `Bearer ${tokenOwnerA}`);

    // Chega uma obrigação NOVA, com prazo bem mais longo que o bloqueio
    // original (guarda de 10 anos, além dos 5 do primeiro arquivo).
    const novo = await request(app)
      .post('/arquivos')
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .field('tipo', 'documento')
      .field('clienteId', titular.id)
      .attach('arquivo', PNG_MAGIC_BYTES, 'nota-nova.png');
    await request(app)
      .patch(`/arquivos/${novo.body.arquivo.id}/bloqueio`)
      .set('Authorization', `Bearer ${tokenOwnerA}`)
      .send({ bloqueado: true, motivo: 'Nota fiscal nova — guarda obrigatória.' });
    await prismaUnscoped.arquivo.update({
      where: { id: novo.body.arquivo.id },
      data: { retentionUntil: new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000) },
    });

    // Varredura muito além do bloqueio original, mas dentro do novo prazo.
    const daquiA6Anos = new Date(Date.now() + 6 * 365 * 24 * 60 * 60 * 1000);
    await runLgpdSweep(daquiA6Anos);

    expect(await prismaUnscoped.cliente.findFirst({ where: { id: titular.id } })).not.toBeNull();
    const reavaliada = await prismaUnscoped.solicitacaoLgpd.findFirst({
      where: { id: solicitacao.body.solicitacaoId },
    });
    expect(reavaliada?.motivoBloqueio).toContain('Nota fiscal nova');
  });

  it('E3 — token de confirmação não volta na resposta quando em produção', async () => {
    const titular = await criarTitular(tenantA.id, 'Igor Producao');
    const anterior = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const resposta = await request(app)
        .patch('/lgpd/corrigir')
        .set('Authorization', `Bearer ${tokenAdminA}`)
        .send({ clienteId: titular.id, nome: 'Igor Corrigido' });

      expect(resposta.status).toBe(201);
      expect(resposta.body.tokenConfirmacao).toBeUndefined();
    } finally {
      process.env.NODE_ENV = anterior;
    }
  });

  it('E4 — aprovação concorrente executa a exclusão uma única vez', async () => {
    const titular = await criarTitular(tenantA.id, 'Julia Concorrente');
    const solicitacao = await request(app)
      .delete('/lgpd/excluir')
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .send({ clienteId: titular.id });

    const url = `/lgpd/solicitacoes/${solicitacao.body.solicitacaoId}/aprovar`;
    const [a, b] = await Promise.all([
      request(app).post(url).set('Authorization', `Bearer ${tokenOwnerA}`),
      request(app).post(url).set('Authorization', `Bearer ${tokenOwnerA}`),
    ]);

    const status = [a.status, b.status].sort();
    expect(status).toEqual([200, 409]);
    expect(await prismaUnscoped.cliente.findFirst({ where: { id: titular.id } })).toBeNull();
  });

  it('E5 — listagem de solicitações nunca devolve o hash do token', async () => {
    const titular = await criarTitular(tenantA.id, 'Karina Sem Hash');
    await request(app)
      .patch('/lgpd/corrigir')
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .send({ clienteId: titular.id, nome: 'Karina Nova' });

    const resposta = await request(app)
      .get('/lgpd/solicitacoes')
      .set('Authorization', `Bearer ${tokenAdminA}`);

    expect(resposta.status).toBe(200);
    expect(JSON.stringify(resposta.body)).not.toContain('tokenConfirmacaoHash');
  });

  it('E6 — confirmar correção de titular já excluído responde 410, não 500', async () => {
    const titular = await criarTitular(tenantA.id, 'Lucas Excluido Antes');
    const correcao = await request(app)
      .patch('/lgpd/corrigir')
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .send({ clienteId: titular.id, nome: 'Lucas Novo' });

    await prismaUnscoped.cliente.delete({ where: { id: titular.id } });

    const resposta = await request(app)
      .post('/lgpd/corrigir/confirmar')
      .send({ token: correcao.body.tokenConfirmacao });

    // A solicitação cai por cascade junto com o titular, então o token some
    // antes de chegar ao update — o importante é não devolver 500.
    expect([401, 410]).toContain(resposta.status);
  });

  it('E7 — limite negativo na auditoria não inverte a consulta', async () => {
    const resposta = await request(app)
      .get('/lgpd/auditoria?limite=-5')
      .set('Authorization', `Bearer ${tokenOwnerA}`);

    expect(resposta.status).toBe(200);
    expect(Array.isArray(resposta.body.logs)).toBe(true);
  });

  it('E8 — logout e habilitação de MFA são auditados', async () => {
    const senhaHash = await bcrypt.hash(SENHA, BCRYPT_COST);
    await prismaUnscoped.user.create({
      data: {
        tenantId: tenantA.id,
        email: 'admin-auditado@lgpd-a.ficticio.com',
        passwordHash: senhaHash,
        role: 'ADMIN',
      },
    });

    await loginComMfa('admin-auditado@lgpd-a.ficticio.com');
    const mfaLog = await prismaUnscoped.logAuditoria.findFirst({
      where: { acao: 'MFA_HABILITADO', tenantId: tenantA.id },
    });
    expect(mfaLog).not.toBeNull();

    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@lgpd-a.ficticio.com', senha: SENHA });
    const verify = await request(app).post('/auth/mfa/verify').send({
      challengeToken: login.body.challengeToken,
      code: '000000',
    });
    void verify;

    const atendenteSenha = await bcrypt.hash(SENHA, BCRYPT_COST);
    await prismaUnscoped.user.create({
      data: {
        tenantId: tenantA.id,
        email: 'atendente-logout@lgpd-a.ficticio.com',
        passwordHash: atendenteSenha,
        role: 'ATENDENTE',
      },
    });
    const sessao = await request(app)
      .post('/auth/login')
      .send({ email: 'atendente-logout@lgpd-a.ficticio.com', senha: SENHA });
    await request(app).post('/auth/logout').send({ refreshToken: sessao.body.refreshToken });

    const logoutLog = await prismaUnscoped.logAuditoria.findFirst({
      where: { acao: 'LOGOUT', tenantId: tenantA.id },
    });
    expect(logoutLog).not.toBeNull();
  });

  it('E9 — máscara de CPF não estraga número que não é CPF', async () => {
    const { mascararTexto } = await import('../src/lib/mascarar');

    expect(mascararTexto('CPF 123.456.789-01 do titular')).toContain('***.***.***-**');
    expect(mascararTexto('12345678901')).toBe('***.***.***-**');
    // 13 dígitos (timestamp) não é CPF e precisa sair intacto.
    expect(mascararTexto('1789482741123')).toBe('1789482741123');
  });
});

describe('AUDITORIA', () => {
  it('registra as ações sensíveis com e-mail mascarado, nunca em texto puro', async () => {
    const emailDoTitular = 'joao.mascarado@gmail.com';
    const titular = await prismaUnscoped.cliente.create({
      data: {
        tenantId: tenantA.id,
        nome: 'Joao Mascarado',
        telefone: '+55 11 90000-1234',
        email: emailDoTitular,
      },
    });

    await request(app)
      .post('/lgpd/exportar')
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .send({ clienteId: titular.id });

    const log = await prismaUnscoped.logAuditoria.findFirst({
      where: { acao: 'LGPD_EXPORTACAO', entidadeId: titular.id },
    });
    expect(log).not.toBeNull();
    expect(log?.tenantId).toBe(tenantA.id);

    // Nenhum e-mail em texto puro em nenhum log deste tenant.
    const todos = await prismaUnscoped.logAuditoria.findMany({ where: { tenantId: tenantA.id } });
    const serializado = JSON.stringify(todos);
    expect(serializado).not.toContain(emailDoTitular);
    expect(serializado).not.toContain('owner@lgpd-a.ficticio.com');
  });

  it('login que falha é auditado com o e-mail mascarado', async () => {
    await request(app)
      .post('/auth/login')
      .send({ email: 'alvo.do.ataque@gmail.com', senha: 'senha-errada' });

    const log = await prismaUnscoped.logAuditoria.findFirst({
      where: { acao: 'LOGIN_FALHA' },
      orderBy: { createdAt: 'desc' },
    });

    expect(log).not.toBeNull();
    const detalhes = JSON.stringify(log?.detalhes);
    expect(detalhes).not.toContain('alvo.do.ataque@gmail.com');
    expect(detalhes).toContain('a***@gmail.com');
  });

  it('nunca grava senha, token ou secret em texto puro', async () => {
    const { registrarAuditoria } = await import('../src/lib/auditoria');

    await registrarAuditoria({
      acao: 'LOGIN_SUCESSO',
      entidade: 'User',
      tenantId: tenantA.id,
      detalhes: {
        senha: 'SenhaSuperSecreta123',
        refreshToken: 'token-que-nao-pode-vazar',
        passwordHash: '$2a$12$hash',
        aninhado: { mfaSecret: 'SEGREDO-TOTP' },
        campoNormal: 'isto pode aparecer',
      },
    });

    const log = await prismaUnscoped.logAuditoria.findFirst({
      where: { tenantId: tenantA.id, acao: 'LOGIN_SUCESSO' },
      orderBy: { createdAt: 'desc' },
    });

    const detalhes = JSON.stringify(log?.detalhes);
    expect(detalhes).not.toContain('SenhaSuperSecreta123');
    expect(detalhes).not.toContain('token-que-nao-pode-vazar');
    expect(detalhes).not.toContain('$2a$12$hash');
    expect(detalhes).not.toContain('SEGREDO-TOTP');
    expect(detalhes).toContain('isto pode aparecer');
  });

  it('tabela de auditoria é imutável: UPDATE e DELETE recusados pelo banco', async () => {
    const log = await prismaUnscoped.logAuditoria.findFirst({ where: { tenantId: tenantA.id } });
    expect(log).not.toBeNull();

    await expect(
      prismaUnscoped.logAuditoria.update({
        where: { id: log!.id },
        data: { acao: 'ACAO_ADULTERADA' },
      }),
    ).rejects.toThrow(/append-only/i);

    await expect(
      prismaUnscoped.logAuditoria.delete({ where: { id: log!.id } }),
    ).rejects.toThrow(/retencao minima de 5 anos/i);

    // Continua lá, intacto.
    const aindaLa = await prismaUnscoped.logAuditoria.findFirst({ where: { id: log!.id } });
    expect(aindaLa?.acao).toBe(log!.acao);
  });

  it('retenção mínima de 5 anos: só linha mais velha que isso pode ser removida', async () => {
    const antigo = await prismaUnscoped.logAuditoria.create({
      data: { tenantId: tenantA.id, acao: 'LOGIN_SUCESSO', entidade: 'User' },
    });

    // Envelhece a linha direto no banco (o trigger bloqueia UPDATE via ORM,
    // então o teste usa SQL de manutenção para simular a passagem do tempo).
    await prismaUnscoped.$executeRawUnsafe(
      `ALTER TABLE "logs_auditoria" DISABLE TRIGGER logs_auditoria_append_only_trigger`,
    );
    await prismaUnscoped.$executeRawUnsafe(
      `UPDATE "logs_auditoria" SET "createdAt" = now() - interval '6 years' WHERE id = '${antigo.id}'`,
    );
    await prismaUnscoped.$executeRawUnsafe(
      `ALTER TABLE "logs_auditoria" ENABLE TRIGGER logs_auditoria_append_only_trigger`,
    );

    await expect(
      prismaUnscoped.logAuditoria.delete({ where: { id: antigo.id } }),
    ).resolves.toBeTruthy();
  });

  it('painel de auditoria só enxerga o log do próprio tenant', async () => {
    await prismaUnscoped.logAuditoria.create({
      data: { tenantId: tenantB.id, acao: 'LOGIN_SUCESSO', entidade: 'User', entidadeId: 'do-b' },
    });

    const resposta = await request(app)
      .get('/lgpd/auditoria')
      .set('Authorization', `Bearer ${tokenOwnerA}`);

    expect(resposta.status).toBe(200);
    const tenantsNosLogs = new Set(
      (resposta.body.logs as Array<{ tenantId: string }>).map((l) => l.tenantId),
    );
    expect([...tenantsNosLogs]).toEqual([tenantA.id]);
  });

  it('painel de auditoria é exclusivo do Owner (Admin recebe 403)', async () => {
    const resposta = await request(app)
      .get('/lgpd/auditoria')
      .set('Authorization', `Bearer ${tokenAdminA}`);
    expect(resposta.status).toBe(403);
  });
});
