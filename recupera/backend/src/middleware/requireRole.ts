import { NextFunction, Request, Response } from 'express';
import { Role } from '@prisma/client';

/**
 * RBAC (Dia 3 / Prompt 1.3): aplicado sempre no backend, nunca só escondido
 * no frontend. Ordem de verificação da rota: authenticate (autenticado +
 * tenant correto) → requireRole (papel autorizado) → controller (executa).
 */
export function requireRole(...allowed: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = req.auth?.role;
    if (!role || !allowed.includes(role as Role)) {
      res.status(403).json({ error: 'Papel não autorizado para esta ação.' });
      return;
    }
    next();
  };
}
