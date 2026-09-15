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

  await prisma.cliente.create({
    data: { tenantId: tenantA.id, nome: 'Maria Fictícia A', telefone: '+55 11 90000-0001' },
  });
  await prisma.cliente.create({
    data: { tenantId: tenantB.id, nome: 'João Fictício B', telefone: '+55 11 90000-0002' },
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
