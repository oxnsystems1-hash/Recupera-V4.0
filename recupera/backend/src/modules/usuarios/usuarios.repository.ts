import { Prisma, Role } from '@prisma/client';
import { prisma } from '../../lib/prisma';

export const usuariosRepository = {
  list() {
    return prisma.user.findMany({
      select: {
        id: true,
        email: true,
        role: true,
        active: true,
        mfaEnabled: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  },

  // findUnique é bloqueado pelo Prisma Client escopado (ver lib/prisma.ts)
  // — mesmo padrão usado em clientes.repository.ts.
  getById(id: string) {
    return prisma.user.findFirst({ where: { id } });
  },

  create(data: { email: string; passwordHash: string; role: string }) {
    // tenantId é injetado em runtime pelo Prisma Client escopado; o cast
    // só satisfaz o tipo gerado pelo Prisma (ver clientes.repository.ts).
    return prisma.user.create({ data: data as Prisma.UserUncheckedCreateInput });
  },

  updateRole(id: string, role: string) {
    return prisma.user.update({ where: { id }, data: { role: role as Role } });
  },

  deactivate(id: string) {
    return prisma.user.update({ where: { id }, data: { active: false } });
  },
};
