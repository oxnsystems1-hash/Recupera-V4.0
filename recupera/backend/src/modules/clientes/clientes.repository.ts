import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';

export const clientesRepository = {
  list(q?: string) {
    return prisma.cliente.findMany({
      where: q
        ? {
            OR: [{ nome: { contains: q, mode: 'insensitive' } }, { telefone: { contains: q } }],
          }
        : undefined,
      orderBy: { createdAt: 'desc' },
    });
  },

  /**
   * findUnique é bloqueado pelo Prisma Client escopado (ver lib/prisma.ts)
   * — por isso a busca por ID aqui usa findFirst, com tenantId injetado
   * automaticamente no where. Se o cliente existir mas pertencer a outro
   * tenant, o retorno é `null`, exatamente como "não existe" — o que faz o
   * controller responder 404, nunca 403.
   */
  getById(id: string) {
    return prisma.cliente.findFirst({ where: { id } });
  },

  create(data: { nome: string; telefone: string; email?: string }) {
    // tenantId é injetado em runtime pelo Prisma Client escopado
    // (lib/prisma.ts); o cast existe só para satisfazer o tipo gerado pelo
    // Prisma, que exige tenantId/tenant em tempo de compilação.
    return prisma.cliente.create({ data: data as Prisma.ClienteUncheckedCreateInput });
  },
};
