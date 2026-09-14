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

export function getAuthContext(): RequestAuthContext | undefined {
  return storage.getStore();
}

/**
 * Retorna o tenant_id do contexto atual ou lança erro. Usado pelo Prisma
 * Client escopado para garantir que nenhuma query tenant-scoped rode fora
 * de uma requisição autenticada.
 */
export function requireTenantId(): string {
  const context = storage.getStore();
  if (!context) {
    throw new Error(
      'Nenhum tenant autenticado no contexto atual — query tenant-scoped fora de uma requisição autenticada.',
    );
  }
  return context.tenantId;
}
