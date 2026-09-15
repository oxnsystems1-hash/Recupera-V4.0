import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { runWithAuthContext } from '../lib/tenantContext';
import { AccessTokenPayload } from '../lib/tokens';

export type JwtPayload = AccessTokenPayload;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: JwtPayload;
    }
  }
}

/**
 * Único ponto do backend que extrai tenant_id de uma fonte confiável (o
 * JWT assinado). A partir daqui, req.auth.tenantId — nunca req.body,
 * req.query ou req.params — é a fonte da verdade para o resto da
 * requisição (ver lib/tenantContext.ts e lib/prisma.ts).
 */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Token de autenticação ausente.' });
    return;
  }

  const token = header.slice('Bearer '.length);

  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, env.jwtSecret) as JwtPayload;
    if (payload.type !== 'access') {
      // Evita confusão de token: um token de setup/challenge de MFA não
      // pode ser reaproveitado como sessão autenticada.
      throw new Error('Tipo de token inesperado.');
    }
  } catch {
    res.status(401).json({ error: 'Token de autenticação inválido ou expirado.' });
    return;
  }

  req.auth = payload;

  runWithAuthContext(
    { tenantId: payload.tenantId, userId: payload.userId, role: payload.role },
    next,
  );
}
