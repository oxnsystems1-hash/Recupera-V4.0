import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { createApp } from '../src/app';
import { prismaUnscoped } from '../src/lib/prisma';
import { clearAllRateLimits } from '../src/lib/rateLimiter';
import { BCRYPT_COST } from '../src/config/security';

/**
 * Backend das telas principais (Dia 6 / Prompt 3.1).
 *
 * A regra inegociável do prompt — "todo botão ou ação visível corresponde a
 * uma checagem real de permissão no backend, nunca apenas escondida no
 * frontend" — só é demonstrável de um jeito: chamando a API DIRETO com o
 * token de quem não pode, como um atacante faria depois de abrir o DevTools.
 * É o que os blocos "via API direta" abaixo fazem.
 */

const app = createApp();
const SENHA = 'SenhaFicticia123!';

let tenantA: { id: string };
let tenantB: { id: string };
let tokenOwnerA = '';
let tokenAtendenteA = '';
let tokenReadOnlyA = '';
let tokenOwnerB = '';
let clienteA: { id: string };
let profissionalA: { id: string };
let servicoA: { id: string };

async function loginSemMfa(email: string): Promise<string> {
  const login = await request(app).post('/auth/login').send({ email, senha: SENHA });
  return login.body.accessToken;
}

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

async function criarUsuario(tenantId: string, email: string, role: string) {
  return prismaUnscoped.user.create({
    data: { tenantId, email, passwordHash: await bcrypt.hash(SENHA, BCRYPT_COST), role: role as never },
  });
}

async function limpar() {
  await prismaUnscoped.$executeRawUnsafe('TRUNCATE "logs_auditoria"');
  await prismaUnscoped.mensagem.deleteMany();
  await prismaUnscoped.conversa.deleteMany();
  await prismaUnscoped.agendamento.deleteMany();
  await prismaUnscoped.profissional.deleteMany();
  await prismaUnscoped.servico.deleteMany();
  await prismaUnscoped.solicitacaoLgpd.deleteMany();
  await prismaUnscoped.arquivo.deleteMany();
  await prismaUnscoped.cliente.deleteMany();
  await prismaUnscoped.refreshToken.deleteMany();
  await prismaUnscoped.user.deleteMany();
  await prismaUnscoped.tenant.deleteMany();
}

/** Próxima hora cheia futura — evita colidir com agendamentos já criados. */
function horarioFuturo(offsetHoras: number): Date {
  const data = new Date();
  data.setMinutes(0, 0, 0);
  data.setHours(data.getHours() + offsetHoras);
  return data;
}

beforeEach(() => clearAllRateLimits());

beforeAll(async () => {
  await limpar();

  tenantA = await prismaUnscoped.tenant.create({
    data: { nome: 'Clínica Fictícia Telas A', segmento: 'clinicas_saude_odonto_estetica' },
  });
  tenantB = await prismaUnscoped.tenant.create({
    data: { nome: 'Salão Fictício Telas B', segmento: 'saloes_estudios_estetica' },
  });

  await criarUsuario(tenantA.id, 'owner@telas-a.ficticio.com', 'OWNER');
  await criarUsuario(tenantA.id, 'atendente@telas-a.ficticio.com', 'ATENDENTE');
  await criarUsuario(tenantA.id, 'readonly@telas-a.ficticio.com', 'READ_ONLY');
  await criarUsuario(tenantB.id, 'owner@telas-b.ficticio.com', 'OWNER');

  tokenOwnerA = await loginComMfa('owner@telas-a.ficticio.com');
  tokenAtendenteA = await loginSemMfa('atendente@telas-a.ficticio.com');
  tokenReadOnlyA = await loginSemMfa('readonly@telas-a.ficticio.com');
  tokenOwnerB = await loginComMfa('owner@telas-b.ficticio.com');

  clienteA = await prismaUnscoped.cliente.create({
    data: { tenantId: tenantA.id, nome: 'Cliente Fictício A', telefone: '+55 11 90000-0001' },
  });
  profissionalA = await prismaUnscoped.profissional.create({
    data: { tenantId: tenantA.id, nome: 'Profissional Fictício A' },
  });
  servicoA = await prismaUnscoped.servico.create({
    data: { tenantId: tenantA.id, nome: 'Avaliação', categoria: 'consulta', duracaoMinutos: 60 },
  });
});

afterAll(async () => {
  await limpar();
  await prismaUnscoped.$disconnect();
});

describe('TELA 1 — Dashboard', () => {
  it('Owner vê métricas, próximos 4h e conversas recentes', async () => {
    const resposta = await request(app)
      .get('/dashboard')
      .set('Authorization', `Bearer ${tokenOwnerA}`);

    expect(resposta.status).toBe(200);
    expect(resposta.body.metricas).toMatchObject({
      agendamentosHoje: expect.any(Number),
      conversasNaoLidas: expect.any(Number),
    });
    expect(resposta.body.janelaProximosHoras).toBe(4);
    expect(Array.isArray(resposta.body.proximosAgendamentos)).toBe(true);
  });

  it('via API direta: Atendente não acessa o dashboard (403)', async () => {
    const resposta = await request(app)
      .get('/dashboard')
      .set('Authorization', `Bearer ${tokenAtendenteA}`);
    expect(resposta.status).toBe(403);
  });

  it('via API direta: Read Only não acessa o dashboard (403)', async () => {
    const resposta = await request(app)
      .get('/dashboard')
      .set('Authorization', `Bearer ${tokenReadOnlyA}`);
    expect(resposta.status).toBe(403);
  });

  it('sem token, dashboard responde 401', async () => {
    expect((await request(app).get('/dashboard')).status).toBe(401);
  });
});

describe('TELA 2 — Agenda', () => {
  it('Atendente cria agendamento; o fim é calculado pela duração do serviço', async () => {
    const inicioEm = horarioFuturo(30);
    const resposta = await request(app)
      .post('/agenda/agendamentos')
      .set('Authorization', `Bearer ${tokenAtendenteA}`)
      .send({
        clienteId: clienteA.id,
        profissionalId: profissionalA.id,
        servicoId: servicoA.id,
        inicioEm: inicioEm.toISOString(),
      });

    expect(resposta.status).toBe(201);
    const duracao =
      new Date(resposta.body.agendamento.fimEm).getTime() -
      new Date(resposta.body.agendamento.inicioEm).getTime();
    expect(duracao).toBe(60 * 60 * 1000);
  });

  it('via API direta: Read Only não cria agendamento (403)', async () => {
    const resposta = await request(app)
      .post('/agenda/agendamentos')
      .set('Authorization', `Bearer ${tokenReadOnlyA}`)
      .send({
        clienteId: clienteA.id,
        profissionalId: profissionalA.id,
        servicoId: servicoA.id,
        inicioEm: horarioFuturo(50).toISOString(),
      });

    expect(resposta.status).toBe(403);
  });

  it('Read Only consegue VISUALIZAR a agenda (matriz RBAC permite)', async () => {
    const de = new Date();
    const ate = new Date(de.getTime() + 7 * 24 * 60 * 60 * 1000);
    const resposta = await request(app)
      .get('/agenda/agendamentos')
      .query({ de: de.toISOString(), ate: ate.toISOString() })
      .set('Authorization', `Bearer ${tokenReadOnlyA}`);

    expect(resposta.status).toBe(200);
    expect(Array.isArray(resposta.body.agendamentos)).toBe(true);
  });

  it('double-booking do mesmo profissional é recusado (409)', async () => {
    const inicioEm = horarioFuturo(60);
    const criar = () =>
      request(app)
        .post('/agenda/agendamentos')
        .set('Authorization', `Bearer ${tokenAtendenteA}`)
        .send({
          clienteId: clienteA.id,
          profissionalId: profissionalA.id,
          servicoId: servicoA.id,
          inicioEm: inicioEm.toISOString(),
        });

    expect((await criar()).status).toBe(201);
    expect((await criar()).status).toBe(409);
  });

  it('CORRIDA: duas criações simultâneas no mesmo horário — só uma entra', async () => {
    const inicioEm = horarioFuturo(70);
    const payload = {
      clienteId: clienteA.id,
      profissionalId: profissionalA.id,
      servicoId: servicoA.id,
      inicioEm: inicioEm.toISOString(),
    };

    // É aqui que uma checagem de aplicação ("está livre?") falharia: entre o
    // SELECT e o INSERT cabe a outra requisição. Quem recusa é a restrição
    // EXCLUDE do Postgres.
    const [a, b] = await Promise.all([
      request(app)
        .post('/agenda/agendamentos')
        .set('Authorization', `Bearer ${tokenAtendenteA}`)
        .send(payload),
      request(app)
        .post('/agenda/agendamentos')
        .set('Authorization', `Bearer ${tokenAtendenteA}`)
        .send(payload),
    ]);

    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const total = await prismaUnscoped.agendamento.count({
      where: { profissionalId: profissionalA.id, inicioEm, status: { not: 'CANCELADO' } },
    });
    expect(total).toBe(1);
  });

  it('horário liberado após cancelamento pode ser reagendado', async () => {
    const inicioEm = horarioFuturo(80);
    const primeiro = await request(app)
      .post('/agenda/agendamentos')
      .set('Authorization', `Bearer ${tokenAtendenteA}`)
      .send({
        clienteId: clienteA.id,
        profissionalId: profissionalA.id,
        servicoId: servicoA.id,
        inicioEm: inicioEm.toISOString(),
      });

    const cancelamento = await request(app)
      .post(`/agenda/agendamentos/${primeiro.body.agendamento.id}/cancelar`)
      .set('Authorization', `Bearer ${tokenAtendenteA}`)
      .send({ motivo: 'Cliente fictício remarcou.' });
    expect(cancelamento.status).toBe(200);

    const segundo = await request(app)
      .post('/agenda/agendamentos')
      .set('Authorization', `Bearer ${tokenAtendenteA}`)
      .send({
        clienteId: clienteA.id,
        profissionalId: profissionalA.id,
        servicoId: servicoA.id,
        inicioEm: inicioEm.toISOString(),
      });
    expect(segundo.status).toBe(201);
  });

  it('cancelamento exige motivo', async () => {
    const criado = await request(app)
      .post('/agenda/agendamentos')
      .set('Authorization', `Bearer ${tokenAtendenteA}`)
      .send({
        clienteId: clienteA.id,
        profissionalId: profissionalA.id,
        servicoId: servicoA.id,
        inicioEm: horarioFuturo(90).toISOString(),
      });

    const semMotivo = await request(app)
      .post(`/agenda/agendamentos/${criado.body.agendamento.id}/cancelar`)
      .set('Authorization', `Bearer ${tokenAtendenteA}`)
      .send({});

    expect(semMotivo.status).toBe(400);
  });

  it('IDOR: agendar para cliente de OUTRO tenant responde 404, nunca cria', async () => {
    const clienteB = await prismaUnscoped.cliente.create({
      data: { tenantId: tenantB.id, nome: 'Cliente Fictício B', telefone: '+55 11 90000-0002' },
    });

    const resposta = await request(app)
      .post('/agenda/agendamentos')
      .set('Authorization', `Bearer ${tokenAtendenteA}`)
      .send({
        clienteId: clienteB.id,
        profissionalId: profissionalA.id,
        servicoId: servicoA.id,
        inicioEm: horarioFuturo(100).toISOString(),
      });

    expect(resposta.status).toBe(404);
    expect(await prismaUnscoped.agendamento.count({ where: { clienteId: clienteB.id } })).toBe(0);
  });

  it('agenda de um tenant nunca mostra agendamento do outro', async () => {
    const de = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const ate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const respostaB = await request(app)
      .get('/agenda/agendamentos')
      .query({ de: de.toISOString(), ate: ate.toISOString() })
      .set('Authorization', `Bearer ${tokenOwnerB}`);

    expect(respostaB.status).toBe(200);
    expect(respostaB.body.agendamentos).toHaveLength(0);
  });

  it('intervalo inválido ou grande demais é recusado', async () => {
    const de = new Date();
    expect(
      (
        await request(app)
          .get('/agenda/agendamentos')
          .query({ de: de.toISOString(), ate: de.toISOString() })
          .set('Authorization', `Bearer ${tokenOwnerA}`)
      ).status,
    ).toBe(400);

    expect(
      (
        await request(app)
          .get('/agenda/agendamentos')
          .query({
            de: de.toISOString(),
            ate: new Date(de.getTime() + 200 * 24 * 60 * 60 * 1000).toISOString(),
          })
          .set('Authorization', `Bearer ${tokenOwnerA}`)
      ).status,
    ).toBe(400);
  });
});

describe('TELA 3 — Inbox', () => {
  let conversaId = '';
  let sugestaoId = '';

  beforeAll(async () => {
    const conversa = await prismaUnscoped.conversa.create({
      data: { tenantId: tenantA.id, clienteId: clienteA.id, naoLidas: 2 },
    });
    conversaId = conversa.id;

    await prismaUnscoped.mensagem.create({
      data: {
        tenantId: tenantA.id,
        conversaId,
        autor: 'CLIENTE',
        conteudo: 'Olá, gostaria de remarcar.',
        status: 'RECEBIDA',
      },
    });
    const sugestao = await prismaUnscoped.mensagem.create({
      data: {
        tenantId: tenantA.id,
        conversaId,
        autor: 'AGENTE_IA',
        conteudo: 'Posso verificar os horários livres para você.',
        status: 'SUGERIDA',
      },
    });
    sugestaoId = sugestao.id;
  });

  it('lista conversas com contador de não-lidas', async () => {
    const resposta = await request(app)
      .get('/conversas')
      .set('Authorization', `Bearer ${tokenAtendenteA}`);

    expect(resposta.status).toBe(200);
    const conversa = resposta.body.conversas.find((c: { id: string }) => c.id === conversaId);
    expect(conversa.naoLidas).toBe(2);
  });

  it('sugestão do agente aparece como SUGERIDA — nunca enviada sozinha', async () => {
    const resposta = await request(app)
      .get(`/conversas/${conversaId}/mensagens`)
      .set('Authorization', `Bearer ${tokenAtendenteA}`);

    const sugestao = resposta.body.mensagens.find((m: { id: string }) => m.id === sugestaoId);
    expect(sugestao.status).toBe('SUGERIDA');
    expect(sugestao.enviadaPorId).toBeNull();
    expect(sugestao.enviadaEm).toBeNull();
  });

  it('enviar a sugestão exige ação humana e carimba quem aprovou', async () => {
    const resposta = await request(app)
      .post(`/conversas/${conversaId}/sugestoes/${sugestaoId}/enviar`)
      .set('Authorization', `Bearer ${tokenAtendenteA}`);

    expect(resposta.status).toBe(200);
    const mensagem = await prismaUnscoped.mensagem.findFirst({ where: { id: sugestaoId } });
    expect(mensagem?.status).toBe('ENVIADA');
    expect(mensagem?.enviadaPorId).not.toBeNull();

    const log = await prismaUnscoped.logAuditoria.findFirst({
      where: { acao: 'SUGESTAO_IA_ENVIADA', entidadeId: conversaId },
    });
    expect(log).not.toBeNull();
  });

  it('sugestão já enviada não é reenviada (409)', async () => {
    const resposta = await request(app)
      .post(`/conversas/${conversaId}/sugestoes/${sugestaoId}/enviar`)
      .set('Authorization', `Bearer ${tokenAtendenteA}`);
    expect(resposta.status).toBe(409);
  });

  it('via API direta: Read Only não envia mensagem (403)', async () => {
    const resposta = await request(app)
      .post(`/conversas/${conversaId}/mensagens`)
      .set('Authorization', `Bearer ${tokenReadOnlyA}`)
      .send({ conteudo: 'tentativa de envio' });

    expect(resposta.status).toBe(403);
  });

  it('via API direta: Read Only não envia sugestão de IA nem marca como lida (403)', async () => {
    const sugestao = await prismaUnscoped.mensagem.create({
      data: {
        tenantId: tenantA.id,
        conversaId,
        autor: 'AGENTE_IA',
        conteudo: 'Outra sugestão fictícia.',
        status: 'SUGERIDA',
      },
    });

    expect(
      (
        await request(app)
          .post(`/conversas/${conversaId}/sugestoes/${sugestao.id}/enviar`)
          .set('Authorization', `Bearer ${tokenReadOnlyA}`)
      ).status,
    ).toBe(403);

    expect(
      (
        await request(app)
          .patch(`/conversas/${conversaId}/lida`)
          .set('Authorization', `Bearer ${tokenReadOnlyA}`)
      ).status,
    ).toBe(403);

    // A sugestão continua intocada.
    const aindaSugerida = await prismaUnscoped.mensagem.findFirst({ where: { id: sugestao.id } });
    expect(aindaSugerida?.status).toBe('SUGERIDA');
  });

  it('IDOR: conversa de outro tenant responde 404, nunca o conteúdo', async () => {
    const resposta = await request(app)
      .get(`/conversas/${conversaId}/mensagens`)
      .set('Authorization', `Bearer ${tokenOwnerB}`);

    expect(resposta.status).toBe(404);
  });
});

describe('LGPD segue íntegra com as entidades novas', () => {
  it('portabilidade passa a incluir agendamentos e conversas do titular', async () => {
    const resposta = await request(app)
      .post('/lgpd/exportar')
      .set('Authorization', `Bearer ${tokenOwnerA}`)
      .send({ clienteId: clienteA.id });

    expect(resposta.status).toBe(200);
    expect(resposta.body.exportacao.agendamentos.length).toBeGreaterThan(0);
    expect(resposta.body.exportacao.conversas.length).toBeGreaterThan(0);

    // Sugestão não decidida nunca foi comunicada ao titular: fora do pacote.
    const conteudos = JSON.stringify(resposta.body.exportacao.conversas);
    expect(conteudos).not.toContain('Outra sugestão fictícia');
  });

  it('exclusão do titular leva agendamentos, conversas e mensagens junto', async () => {
    const titular = await prismaUnscoped.cliente.create({
      data: { tenantId: tenantA.id, nome: 'Titular Fictício Exclusão', telefone: '+55 11 90000-7777' },
    });
    await prismaUnscoped.agendamento.create({
      data: {
        tenantId: tenantA.id,
        clienteId: titular.id,
        profissionalId: profissionalA.id,
        servicoId: servicoA.id,
        inicioEm: horarioFuturo(200),
        fimEm: horarioFuturo(201),
      },
    });
    const conversa = await prismaUnscoped.conversa.create({
      data: { tenantId: tenantA.id, clienteId: titular.id },
    });
    await prismaUnscoped.mensagem.create({
      data: {
        tenantId: tenantA.id,
        conversaId: conversa.id,
        autor: 'CLIENTE',
        conteudo: 'mensagem fictícia',
        status: 'RECEBIDA',
      },
    });

    const solicitacao = await request(app)
      .delete('/lgpd/excluir')
      .set('Authorization', `Bearer ${tokenOwnerA}`)
      .send({ clienteId: titular.id });
    await request(app)
      .post(`/lgpd/solicitacoes/${solicitacao.body.solicitacaoId}/aprovar`)
      .set('Authorization', `Bearer ${tokenOwnerA}`);

    expect(await prismaUnscoped.agendamento.count({ where: { clienteId: titular.id } })).toBe(0);
    expect(await prismaUnscoped.conversa.count({ where: { clienteId: titular.id } })).toBe(0);
    expect(await prismaUnscoped.mensagem.count({ where: { conversaId: conversa.id } })).toBe(0);
  });
});
