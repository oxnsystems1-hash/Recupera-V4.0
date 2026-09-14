import bcrypt from 'bcryptjs';
import { prismaUnscoped as prisma } from '../src/lib/prisma';

/**
 * Seed com dados 100% fictícios, para desenvolvimento manual local — nunca
 * inserir dado real de cliente/paciente/negócio (regra de ouro do Dia 1).
 */
async function main(): Promise<void> {
  const senhaHash = await bcrypt.hash('SenhaFicticia123!', 12);

  const tenantA = await prisma.tenant.create({
    data: { nome: 'Clínica Estética Aurora (fictícia)', segmento: 'clinica_estetica' },
  });
  const tenantB = await prisma.tenant.create({
    data: { nome: 'Salão Vidas Boas (fictício)', segmento: 'salao' },
  });

  await prisma.user.create({
    data: {
      tenantId: tenantA.id,
      email: 'atendente@tenant-a.ficticio.com',
      passwordHash: senhaHash,
      role: 'ATENDENTE',
    },
  });
  await prisma.user.create({
    data: {
      tenantId: tenantB.id,
      email: 'atendente@tenant-b.ficticio.com',
      passwordHash: senhaHash,
      role: 'ATENDENTE',
    },
  });

  await prisma.cliente.create({
    data: { tenantId: tenantA.id, nome: 'Maria Fictícia A', telefone: '+55 11 90000-0001' },
  });
  await prisma.cliente.create({
    data: { tenantId: tenantB.id, nome: 'João Fictício B', telefone: '+55 11 90000-0002' },
  });

  console.log('Seed fictício concluído.', { tenantAId: tenantA.id, tenantBId: tenantB.id });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
