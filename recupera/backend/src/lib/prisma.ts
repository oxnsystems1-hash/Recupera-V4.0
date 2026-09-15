import { PrismaClient } from '@prisma/client';
import { requireTenantId } from './tenantContext';

/**
 * Allowlist explícita dos models com tenant_id. Usar allowlist (em vez de
 * introspectar o DMMF em runtime) deixa óbvio, em revisão de código, quais
 * tabelas são tenant-scoped sempre que o schema.prisma muda.
 */
const TENANT_SCOPED_MODELS = new Set(['Cliente', 'User', 'Arquivo', 'LogAcessoArquivo']);

const OPERATIONS_WITH_WHERE = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
]);

/**
 * Client Prisma "cru": sem isolamento automático de tenant. Uso restrito a
 * (1) login, antes de o tenant_id ser conhecido — ver modules/auth; e
 * (2) scripts de seed/administração, fora do ciclo de requisição HTTP.
 * Nenhuma rota de aplicação deve importar isto diretamente.
 */
export const prismaUnscoped = new PrismaClient();

/**
 * Client Prisma "escopado por tenant": para todo model tenant-scoped, injeta
 * automaticamente o tenant_id do contexto de autenticação (extraído do JWT
 * em middleware/authenticate.ts, nunca do body/URL) em toda query. É o
 * client que módulos de aplicação (clientes, agendamentos, etc.) devem usar
 * — assim o isolamento de tenant não depende de cada desenvolvedor lembrar
 * de filtrar manualmente em cada query.
 */
export const prisma = prismaUnscoped.$extends({
  name: 'tenant-isolation',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!model || !TENANT_SCOPED_MODELS.has(model)) {
          return query(args);
        }

        const tenantId = requireTenantId();
        const mutableArgs = args as Record<string, unknown>;

        if (operation === 'findUnique' || operation === 'findUniqueOrThrow') {
          // findUnique só aceita campos únicos no `where`: não dá para
          // injetar tenant_id ali sem risco de, por engano, ignorá-lo.
          // Em vez de arriscar um vazamento silencioso entre tenants,
          // bloqueamos aqui — buscas por ID em models tenant-scoped devem
          // usar findFirst com tenantId no where (ver clientes.repository.ts).
          throw new Error(
            `${operation} bloqueado para o model "${model}": use findFirst com tenantId no where.`,
          );
        }

        if (OPERATIONS_WITH_WHERE.has(operation)) {
          mutableArgs.where = { ...(mutableArgs.where as object | undefined), tenantId };
        }

        if (operation === 'upsert') {
          mutableArgs.where = { ...(mutableArgs.where as object | undefined), tenantId };
          mutableArgs.create = { ...(mutableArgs.create as object | undefined), tenantId };
          mutableArgs.update = { ...(mutableArgs.update as object | undefined), tenantId };
        }

        if (operation === 'create') {
          // tenantId por último no spread: sobrescreve qualquer valor que
          // eventualmente tenha vazado de input externo para `data`.
          mutableArgs.data = { ...(mutableArgs.data as object | undefined), tenantId };
        }

        if (operation === 'createMany' && Array.isArray(mutableArgs.data)) {
          mutableArgs.data = (mutableArgs.data as Record<string, unknown>[]).map((item) => ({
            ...item,
            tenantId,
          }));
        }

        return query(args);
      },
    },
  },
});
