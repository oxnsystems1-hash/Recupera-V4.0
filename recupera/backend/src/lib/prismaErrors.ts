import { Prisma } from '@prisma/client';

/**
 * Verdadeiro para o erro que o Prisma lança quando um update/delete com
 * filtro extra no `where` (ex.: tenantId injetado por lib/prisma.ts, ou uma
 * checagem de papel protegido) não encontra nenhuma linha — o mesmo sinal
 * que usamos para responder 404 de forma uniforme.
 */
export function isRecordNotFoundError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}
