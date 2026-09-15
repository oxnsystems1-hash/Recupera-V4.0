import bcrypt from 'bcryptjs';
import { prismaUnscoped as prisma } from '../src/lib/prisma';
import { BCRYPT_COST } from '../src/config/security';

/**
 * Seed com dados 100% fictícios, para desenvolvimento manual local — nunca
 * inserir dado real de cliente/paciente/negócio (regra de ouro do Dia 1).
 * Owner e Admin ficam com MFA ainda não habilitado de propósito: o
 * handshake de setup (/auth/mfa/setup + /auth/mfa/enable) é parte do que
 * o Dia 3 exige testar.
 */
async function main(): Promise<void> {
  const senhaHash = await bcrypt.hash('SenhaFicticia123!', BCRYPT_COST);

  // Slugs canônicos de segmento — ver config/segmentos.ts (Dia 4): decidem
  // automaticamente a sensibilidade (padrão/reforçada) usada em retenção
  // de arquivo e TTL de URL assinada.
  const tenantA = await prisma.tenant.create({
    data: {
      nome: 'Clínica Estética Aurora (fictícia)',
      segmento: 'clinicas_saude_odonto_estetica', // reforçada
    },
  });
  const tenantB = await prisma.tenant.create({
    data: { nome: 'Salão Vidas Boas (fictício)', segmento: 'saloes_estudios_estetica' }, // padrão
  });

  for (const tenant of [tenantA, tenantB]) {
    await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `owner@${tenant.id.slice(0, 8)}.ficticio.com`,
        passwordHash: senhaHash,
        role: 'OWNER',
      },
    });
    await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `admin@${tenant.id.slice(0, 8)}.ficticio.com`,
        passwordHash: senhaHash,
        role: 'ADMIN',
      },
    });
    await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `atendente@${tenant.id.slice(0, 8)}.ficticio.com`,
        passwordHash: senhaHash,
        role: 'ATENDENTE',
      },
    });
    await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `readonly@${tenant.id.slice(0, 8)}.ficticio.com`,
        passwordHash: senhaHash,
        role: 'READ_ONLY',
      },
    });
  }

  const clienteA = await prisma.cliente.create({
    data: { tenantId: tenantA.id, nome: 'Maria Fictícia A', telefone: '+55 11 90000-0001' },
  });
  await prisma.cliente.create({
    data: { tenantId: tenantB.id, nome: 'João Fictício B', telefone: '+55 11 90000-0002' },
  });

  // --- Dados das telas do Dia 6 (Prompt 3.1), todos fictícios ---

  const profissional = await prisma.profissional.create({
    data: { tenantId: tenantA.id, nome: 'Dra. Fictícia Nogueira' },
  });
  const servico = await prisma.servico.create({
    data: {
      tenantId: tenantA.id,
      nome: 'Avaliação inicial',
      categoria: 'consulta',
      duracaoMinutos: 60,
    },
  });
  await prisma.servico.create({
    data: {
      tenantId: tenantA.id,
      nome: 'Sessão de acompanhamento',
      categoria: 'acompanhamento',
      duracaoMinutos: 30,
    },
  });

  // Um agendamento dentro da janela de 4h do dashboard, outro amanhã.
  const daquiA2Horas = new Date(Date.now() + 2 * 60 * 60 * 1000);
  daquiA2Horas.setMinutes(0, 0, 0);
  const amanha = new Date(daquiA2Horas.getTime() + 24 * 60 * 60 * 1000);

  for (const [inicio, status] of [
    [daquiA2Horas, 'CONFIRMADO'],
    [amanha, 'AGENDADO'],
  ] as const) {
    await prisma.agendamento.create({
      data: {
        tenantId: tenantA.id,
        clienteId: clienteA.id,
        profissionalId: profissional.id,
        servicoId: servico.id,
        inicioEm: inicio,
        fimEm: new Date(inicio.getTime() + 60 * 60 * 1000),
        status,
      },
    });
  }

  const conversa = await prisma.conversa.create({
    data: {
      tenantId: tenantA.id,
      clienteId: clienteA.id,
      canal: 'WHATSAPP',
      naoLidas: 1,
      ultimaMensagemEm: new Date(),
    },
  });
  await prisma.mensagem.create({
    data: {
      tenantId: tenantA.id,
      conversaId: conversa.id,
      autor: 'CLIENTE',
      conteudo: 'Oi! Consigo remarcar meu horário?',
      status: 'RECEBIDA',
    },
  });
  // Sugestão do agente: nasce SUGERIDA e fica assim. Só uma pessoa, clicando
  // em "Enviar ao cliente", muda isso — é a regra do Prompt 3.1 no dado.
  await prisma.mensagem.create({
    data: {
      tenantId: tenantA.id,
      conversaId: conversa.id,
      autor: 'AGENTE_IA',
      conteudo: 'Posso verificar os horários livres desta semana e te passar as opções.',
      status: 'SUGERIDA',
    },
  });

  console.log('Seed fictício concluído.', { tenantAId: tenantA.id, tenantBId: tenantB.id });
  console.log('Senha fictícia de todos os usuários: SenhaFicticia123!');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
