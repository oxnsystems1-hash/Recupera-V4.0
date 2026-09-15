import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';

export const arquivosRepository = {
  list() {
    return prisma.arquivo.findMany({
      select: {
        id: true,
        tipo: true,
        nomeOriginal: true,
        mimeType: true,
        tamanhoBytes: true,
        retentionUntil: true,
        exclusaoBloqueada: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  },

  // findUnique é bloqueado pelo Prisma Client escopado (ver lib/prisma.ts)
  // — mesmo padrão de clientes.repository.ts e usuarios.repository.ts.
  getById(id: string) {
    return prisma.arquivo.findFirst({ where: { id } });
  },

  create(data: Prisma.ArquivoUncheckedCreateInput) {
    return prisma.arquivo.create({ data });
  },

  setBloqueioExclusao(id: string, bloqueado: boolean, motivo: string | null) {
    return prisma.arquivo.update({
      where: { id },
      data: { exclusaoBloqueada: bloqueado, motivoBloqueioExclusao: motivo },
    });
  },

  remove(id: string) {
    return prisma.arquivo.delete({ where: { id } });
  },

  registrarAcesso(arquivoId: string, userId: string, expiresAt: Date) {
    return prisma.logAcessoArquivo.create({
      data: { arquivoId, userId, expiresAt } as Prisma.LogAcessoArquivoUncheckedCreateInput,
    });
  },
};
