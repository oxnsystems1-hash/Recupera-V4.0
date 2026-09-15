import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';

export const clientesRepository = {
  /**
   * `resumo` devolve só id + nome.
   *
   * Existe porque a tela de agenda precisa preencher um `<select>` de
   * clientes — e puxar o cadastro inteiro (telefone, e-mail, endereço de
   * todo mundo) para desenhar uma lista de nomes é expor dado pessoal sem
   * finalidade (LGPD art. 6º, III: necessidade). O dado que não sai do
   * banco não vaza no navegador, no cache nem no log de proxy.
   */
  list(q?: string, resumo = false) {
    return prisma.cliente.findMany({
      where: q
        ? {
            OR: [{ nome: { contains: q, mode: 'insensitive' } }, { telefone: { contains: q } }],
          }
        : undefined,
      select: resumo
        ? { id: true, nome: true }
        : {
            id: true,
            tenantId: true,
            nome: true,
            telefone: true,
            email: true,
            endereco: true,
            createdAt: true,
            updatedAt: true,
          },
      orderBy: resumo ? { nome: 'asc' } : { createdAt: 'desc' },
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

  // tenantId é injetado no where pela extensão; se o cliente pertencer a
  // outro tenant, o Prisma lança P2025 (ver lib/prismaErrors.ts) — tratado
  // como 404 no controller, nunca 403.
  remove(id: string) {
    return prisma.cliente.delete({ where: { id } });
  },
};
