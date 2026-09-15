import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestAuthContext {
  tenantId: string;
  userId: string;
  role: string;
}

const storage = new AsyncLocalStorage<RequestAuthContext>();

/**
 * Roda `fn` com o tenant/usuário autenticado disponível para toda a árvore
 * de chamadas (incluindo o Prisma Client escopado — ver `lib/prisma.ts`).
 * É a ÚNICA porta de entrada do tenant_id: sempre chamada a partir do
 * middleware de autenticação, nunca com valor vindo de body/query/params.
 */
export function runWithAuthContext<T>(context: RequestAuthContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * Retorna o tenant_id do contexto atual ou lança erro. Usado pelo Prisma
 * Client escopado para garantir que nenhuma query tenant-scoped rode fora
 * de uma requisição autenticada.
 *
 * O `tenantId` precisa ser uma string não vazia, não só existir: o Prisma
 * **descarta silenciosamente** campos `undefined` no `where`, então um
 * contexto com tenantId indefinido faria toda query tenant-scoped rodar
 * SEM filtro nenhum, devolvendo dados de todos os tenants. Falhar aqui é a
 * diferença entre um erro 500 e um vazamento entre tenants.
 */
export function requireTenantId(): string {
  const context = storage.getStore();
  if (!context) {
    throw new Error(
      'Nenhum tenant autenticado no contexto atual — query tenant-scoped fora de uma requisição autenticada.',
    );
  }
  if (typeof context.tenantId !== 'string' || context.tenantId.length === 0) {
    throw new Error('Contexto de autenticação sem tenant_id válido — query tenant-scoped abortada.');
  }
  return context.tenantId;
}

/** Igual a getAuthContext(), mas lança em vez de devolver undefined. */
export function requireAuthContext(): RequestAuthContext {
  const context = storage.getStore();
  if (!context) {
    throw new Error('Nenhum usuário autenticado no contexto atual.');
  }
  return context;
}
