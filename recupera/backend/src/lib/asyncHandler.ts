import { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Express 4 não encaminha sozinho uma Promise rejeitada de um handler
 * async para o middleware de erro — sem este wrapper, uma falha
 * inesperada (ex.: banco fora do ar) vira um unhandledRejection e pode
 * derrubar o processo Node inteiro, afetando todos os tenants. Todo
 * handler async é registrado através deste wrapper.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
