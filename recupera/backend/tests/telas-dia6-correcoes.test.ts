import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { createApp } from '../src/app';
import { prismaUnscoped } from '../src/lib/prisma';
import { clearAllRateLimits } from '../src/lib/rateLimiter';
import { BCRYPT_COST } from '../src/config/security';

/**
 * FASE 2 do Dia 6 — revalidação das correções da auditoria.
 *
 * Cada teste aqui existe para provar UMA falha corrigida, e foi escrito para
 * FALHAR se a correção for revertida (foi assim que foram validados: rodados
 * contra o código antigo antes de entrar). Nada aqui usa mock do próprio
 * backend: é o app real, o banco real e o token de quem realmente não pode.
 *
 * Dados 100% fictícios.
 */

const app = createApp();
const SENHA = 'SenhaFicticia123!';

let tenantA: { id: string };
let tokenOwnerA = '';
let tokenAtendenteA = '';
let tokenReadOnlyA = '';
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
    data: {
      tenantId,
      email,
      passwordHash: await bcrypt.hash(SENHA, BCRYPT_COST),
      role: role as never,
    },
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

function horarioFuturo(offsetHoras: number): Date {
  const data = new Date();
  data.setMinutes(0, 0, 0);
  data.setHours(data.getHours() + offsetHoras);
  return data;
}

const JANELA = () => ({
  de: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  ate: new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString(),
});

beforeEach(() => clearAllRateLimits());

beforeAll(async () => {
  await limpar();

  tenantA = await prismaUnscoped.tenant.create({
    data: { nome: 'Clínica Fictícia Correções', segmento: 'clinicas_saude_odonto_estetica' },
  });

  await criarUsuario(tenantA.id, 'owner@correcoes.ficticio.com', 'OWNER');
  await criarUsuario(tenantA.id, 'atendente@correcoes.ficticio.com', 'ATENDENTE');
  await criarUsuario(tenantA.id, 'readonly@correcoes.ficticio.com', 'READ_ONLY');

  tokenOwnerA = await loginComMfa('owner@correcoes.ficticio.com');
  tokenAtendenteA = await loginSemMfa('atendente@correcoes.ficticio.com');
  tokenReadOnlyA = await loginSemMfa('readonly@correcoes.ficticio.com');

  clienteA = await prismaUnscoped.cliente.create({
    data: {
      tenantId: tenantA.id,
      nome: 'Cliente Fictício Correções',
      telefone: '+55 11 90000-7777',
      email: 'cliente.ficticio@exemplo.invalido',
      endereco: 'Rua Fictícia, 123',
    },
  });
  profissionalA = await prismaUnscoped.profissional.create({
    data: { tenantId: tenantA.id, nome: 'Profissional Fictício Correções' },
  });
  servicoA = await prismaUnscoped.servico.create({
    data: { tenantId: tenantA.id, nome: 'Avaliação', categoria: 'consulta', duracaoMinutos: 30 },
  });
});

afterAll(async () => {
  await limpar();
  await prismaUnscoped.$disconnect();
});

describe('F-06 — minimização de dados no seletor de clientes', () => {
  it('?resumo=1 devolve só id e nome — nem telefone, nem e-mail, nem endereço', async () => {
    const resposta = await request(app)
      .get('/clientes')
      .query({ resumo: '1' })
      .set('Authorization', `Bearer ${tokenAtendenteA}`);

    expect(resposta.status).toBe(200);
    const [cliente] = resposta.body.clientes as Array<Record<string, unknown>>;
    expect(Object.keys(cliente).sort()).toEqual(['id', 'nome']);
    // O texto do dado precisa estar ausente do corpo inteiro, não só da chave.
    expect(JSON.stringify(resposta.body)).not.toContain('90000-7777');
    expect(JSON.stringify(resposta.body)).not.toContain('Rua Fictícia');
  });

  it('a listagem completa continua entregando o cadastro a quem pede por ele', async () => {
    const resposta = await request(app)
      .get('/clientes')
      .set('Authorization', `Bearer ${tokenAtendenteA}`);

    expect(resposta.status).toBe(200);
    expect(resposta.body.clientes[0]).toHaveProperty('telefone');
  });
});

describe('F-07 — observação não trafega em listagem', () => {
  it('a listagem da agenda não devolve observacao nem motivoCancelamento', async () => {
    const criado = await request(app)
      .post('/agenda/agendamentos')
      .set('Authorization', `Bearer ${tokenAtendenteA}`)
      .send({
        clienteId: clienteA.id,
        profissionalId: profissionalA.id,
        servicoId: servicoA.id,
        inicioEm: horarioFuturo(100).toISOString(),
        observacao: 'anotação fictícia sensível do atendimento',
      });
    expect(criado.status).toBe(201);
    // Quem acabou de escrever recebe o registro completo de volta.
    expect(criado.body.agendamento.observacao).toBe('anotação fictícia sensível do atendimento');

    const lista = await request(app)
      .get('/agenda/agendamentos')
      .query(JANELA())
      .set('Authorization', `Bearer ${tokenReadOnlyA}`);

    expect(lista.status).toBe(200);
    expect(JSON.stringify(lista.body)).not.toContain('anotação fictícia sensível');
    const alvo = (lista.body.agendamentos as Array<Record<string, unknown>>).find(
      (a) => a.id === criado.body.agendamento.id,
    );
    expect(alvo).toBeDefined();
    expect(alvo).not.toHaveProperty('observacao');
    expect(alvo).not.toHaveProperty('motivoCancelamento');
  });

  it('o dashboard também não carrega observação para a tela', async () => {
    const resposta = await request(app)
      .get('/dashboard')
      .set('Authorization', `Bearer ${tokenOwnerA}`);

    expect(resposta.status).toBe(200);
    expect(JSON.stringify(resposta.body)).not.toContain('anotação fictícia sensível');
  });
});

describe('F-10 — observação inválida é 400, nunca 500', () => {
  it('observacao não-texto vira 400 com mensagem, não erro interno', async () => {
    const resposta = await request(app)
      .post('/agenda/agendamentos')
      .set('Authorization', `Bearer ${tokenAtendenteA}`)
      .send({
        clienteId: clienteA.id,
        profissionalId: profissionalA.id,
        servicoId: servicoA.id,
        inicioEm: horarioFuturo(200).toISOString(),
        observacao: { injecao: true },
      });

    expect(resposta.status).toBe(400);
    expect(resposta.status).not.toBe(500);
  });

  it('observacao acima do teto vira 400 (e nada é gravado)', async () => {
    const inicioEm = horarioFuturo(201).toISOString();
    const resposta = await request(app)
      .post('/agenda/agendamentos')
      .set('Authorization', `Bearer ${tokenAtendenteA}`)
      .send({
        clienteId: clienteA.id,
        profissionalId: profissionalA.id,
        servicoId: servicoA.id,
        inicioEm,
        observacao: 'x'.repeat(501),
      });

    expect(resposta.status).toBe(400);
    const gravado = await prismaUnscoped.agendamento.count({
      where: { tenantId: tenantA.id, inicioEm: new Date(inicioEm) },
    });
    expect(gravado).toBe(0);
  });

  it('o mesmo vale para a edição', async () => {
    const criado = await request(app)
      .post('/agenda/agendamentos')
      .set('Authorization', `Bearer ${tokenAtendenteA}`)
      .send({
        clienteId: clienteA.id,
        profissionalId: profissionalA.id,
        servicoId: servicoA.id,
        inicioEm: horarioFuturo(202).toISOString(),
      });

    const resposta = await request(app)
      .patch(`/agenda/agendamentos/${criado.body.agendamento.id}`)
      .set('Authorization', `Bearer ${tokenAtendenteA}`)
      .send({ observacao: 42 });

    expect(resposta.status).toBe(400);
    expect(resposta.status).not.toBe(500);
  });
});

describe('F-11 — listagem da agenda tem teto', () => {
  it('não devolve mais que o teto e avisa que truncou', async () => {
    const base = horarioFuturo(24);
    // Profissional próprio: a restrição EXCLUDE é por profissional, e os
    // agendamentos dos outros testes cairiam dentro desta faixa.
    const profissionalLotado = await prismaUnscoped.profissional.create({
      data: { tenantId: tenantA.id, nome: 'Profissional Fictício Lotado' },
    });
    // 1001 registros de 30 min, sem sobreposição entre si.
    const linhas = Array.from({ length: 1001 }, (_, i) => ({
      tenantId: tenantA.id,
      clienteId: clienteA.id,
      profissionalId: profissionalLotado.id,
      servicoId: servicoA.id,
      inicioEm: new Date(base.getTime() + i * 30 * 60 * 1000),
      fimEm: new Date(base.getTime() + i * 30 * 60 * 1000 + 29 * 60 * 1000),
    }));
    await prismaUnscoped.agendamento.createMany({ data: linhas });

    const resposta = await request(app)
      .get('/agenda/agendamentos')
      .query(JANELA())
      .set('Authorization', `Bearer ${tokenReadOnlyA}`);

    expect(resposta.status).toBe(200);
    expect(resposta.body.agendamentos.length).toBeLessThanOrEqual(1000);
    expect(resposta.body.truncado).toBe(true);

    await prismaUnscoped.agendamento.deleteMany({
      where: { profissionalId: profissionalLotado.id },
    });
    await prismaUnscoped.profissional.delete({ where: { id: profissionalLotado.id } });
  }, 60_000);
});

describe('F-12 — disponibilidade é leitura, coerente com o resto da agenda', () => {
  it('Read Only, que já pode listar agendamentos, também pode ler disponibilidade', async () => {
    const resposta = await request(app)
      .get('/agenda/disponibilidade')
      .query({ profissionalId: profissionalA.id, ...JANELA() })
      .set('Authorization', `Bearer ${tokenReadOnlyA}`);

    expect(resposta.status).toBe(200);
    expect(Array.isArray(resposta.body.ocupado)).toBe(true);
  });

  it('e continua fechada para quem não está autenticado', async () => {
    const resposta = await request(app)
      .get('/agenda/disponibilidade')
      .query({ profissionalId: profissionalA.id, ...JANELA() });

    expect(resposta.status).toBe(401);
  });

  it('a faixa ocupada não carrega dado de cliente algum', async () => {
    const resposta = await request(app)
      .get('/agenda/disponibilidade')
      .query({ profissionalId: profissionalA.id, ...JANELA() })
      .set('Authorization', `Bearer ${tokenReadOnlyA}`);

    expect(JSON.stringify(resposta.body)).not.toContain('Cliente Fictício');
    for (const faixa of resposta.body.ocupado as Array<Record<string, unknown>>) {
      expect(Object.keys(faixa).sort()).toEqual(['fimEm', 'inicioEm']);
    }
  });
});

describe('F-13 — remarcação nunca recalcula com duração inventada', () => {
  /**
   * A auditoria apontou um `?? 30` na remarcação: se o serviço não fosse
   * encontrado, o agendamento seria remarcado com 30 minutos arbitrários.
   * Ao tentar reproduzir, o próprio banco mostrou que o cenário não
   * acontece — a FK impede apagar um serviço que ainda tem agendamento.
   * O teste então prova a garantia que existe de verdade (e que sustenta a
   * correção): a duração vem sempre do serviço, e o serviço não some.
   */
  it('o banco recusa apagar um serviço que ainda tem agendamento', async () => {
    const servicoTemporario = await prismaUnscoped.servico.create({
      data: {
        tenantId: tenantA.id,
        nome: 'Serviço Fictício Temporário',
        categoria: 'consulta',
        duracaoMinutos: 90,
      },
    });
    await prismaUnscoped.agendamento.create({
      data: {
        tenantId: tenantA.id,
        clienteId: clienteA.id,
        profissionalId: profissionalA.id,
        servicoId: servicoTemporario.id,
        inicioEm: horarioFuturo(300),
        fimEm: new Date(horarioFuturo(300).getTime() + 90 * 60 * 1000),
      },
    });

    await expect(
      prismaUnscoped.servico.delete({ where: { id: servicoTemporario.id } }),
    ).rejects.toThrow();
  });

  it('remarcar recalcula o fim pela duração do serviço, não por um padrão', async () => {
    const servico90 = await prismaUnscoped.servico.create({
      data: {
        tenantId: tenantA.id,
        nome: 'Serviço Fictício de 90 min',
        categoria: 'consulta',
        duracaoMinutos: 90,
      },
    });
    const criado = await request(app)
      .post('/agenda/agendamentos')
      .set('Authorization', `Bearer ${tokenAtendenteA}`)
      .send({
        clienteId: clienteA.id,
        profissionalId: profissionalA.id,
        servicoId: servico90.id,
        inicioEm: horarioFuturo(400).toISOString(),
      });
    expect(criado.status).toBe(201);

    const novoInicio = horarioFuturo(410);
    const remarcado = await request(app)
      .patch(`/agenda/agendamentos/${criado.body.agendamento.id}`)
      .set('Authorization', `Bearer ${tokenAtendenteA}`)
      .send({ inicioEm: novoInicio.toISOString() });

    expect(remarcado.status).toBe(200);
    const duracaoMin =
      (new Date(remarcado.body.agendamento.fimEm).getTime() -
        new Date(remarcado.body.agendamento.inicioEm).getTime()) /
      60000;
    expect(duracaoMin).toBe(90);
  });
});

describe('F-23 — decidir duas vezes a mesma sugestão responde igual nos dois caminhos', () => {
  it('descartar sugestão já enviada devolve 409 (mesmo código de "já decidida" do envio)', async () => {
    const conversa = await prismaUnscoped.conversa.create({
      data: { tenantId: tenantA.id, clienteId: clienteA.id, canal: 'WHATSAPP', naoLidas: 1 },
    });
    const sugestao = await prismaUnscoped.mensagem.create({
      data: {
        tenantId: tenantA.id,
        conversaId: conversa.id,
        autor: 'AGENTE_IA',
        conteudo: 'Sugestão fictícia do agente.',
        status: 'SUGERIDA',
      },
    });

    const envio = await request(app)
      .post(`/conversas/${conversa.id}/sugestoes/${sugestao.id}/enviar`)
      .set('Authorization', `Bearer ${tokenAtendenteA}`);
    expect(envio.status).toBe(200);

    const descarte = await request(app)
      .post(`/conversas/${conversa.id}/sugestoes/${sugestao.id}/descartar`)
      .set('Authorization', `Bearer ${tokenAtendenteA}`);

    expect(descarte.status).toBe(409);

    // Regra do Prompt 3.1: a decisão humana registrada não é desfeita.
    const depois = await prismaUnscoped.mensagem.findUniqueOrThrow({ where: { id: sugestao.id } });
    expect(depois.status).toBe('ENVIADA');
    expect(depois.enviadaPorId).not.toBeNull();
  });

  it('sugestão inexistente continua 404, e Read Only continua 403 nos dois caminhos', async () => {
    const conversa = await prismaUnscoped.conversa.create({
      data: { tenantId: tenantA.id, clienteId: clienteA.id, canal: 'WHATSAPP' },
    });
    const sugestao = await prismaUnscoped.mensagem.create({
      data: {
        tenantId: tenantA.id,
        conversaId: conversa.id,
        autor: 'AGENTE_IA',
        conteudo: 'Outra sugestão fictícia.',
        status: 'SUGERIDA',
      },
    });

    const inexistente = await request(app)
      .post(`/conversas/${conversa.id}/sugestoes/00000000-0000-0000-0000-000000000000/descartar`)
      .set('Authorization', `Bearer ${tokenAtendenteA}`);
    expect(inexistente.status).toBe(404);

    // Via API direta, com o token de quem não pode — o botão some na tela E
    // o backend recusa.
    const readOnly = await request(app)
      .post(`/conversas/${conversa.id}/sugestoes/${sugestao.id}/descartar`)
      .set('Authorization', `Bearer ${tokenReadOnlyA}`);
    expect(readOnly.status).toBe(403);

    const depois = await prismaUnscoped.mensagem.findUniqueOrThrow({ where: { id: sugestao.id } });
    expect(depois.status).toBe('SUGERIDA');
  });
});
