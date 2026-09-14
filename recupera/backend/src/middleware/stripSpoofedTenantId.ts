import { NextFunction, Request, Response } from 'express';

const SPOOFABLE_KEYS = ['tenantId', 'tenant_id'];

function strip(target: unknown): void {
  if (!target || typeof target !== 'object') return;
  for (const key of SPOOFABLE_KEYS) {
    delete (target as Record<string, unknown>)[key];
  }
}

/**
 * tenant_id nunca é aceito vindo do cliente. Em vez de validar e rejeitar
 * (o que revelaria a um atacante que o campo existe e é significativo),
 * removemos silenciosamente qualquer tenant_id/tenantId enviado em body,
 * query ou params, em toda rota, antes de qualquer handler rodar. O único
 * tenant_id válido segue sendo o extraído do JWT em authenticate.ts.
 */
export function stripSpoofedTenantId(req: Request, _res: Response, next: NextFunction): void {
  strip(req.body);
  strip(req.query);
  strip(req.params);
  next();
}
