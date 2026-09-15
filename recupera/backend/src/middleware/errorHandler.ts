import { NextFunction, Request, Response } from 'express';

interface BodyParserSyntaxError extends SyntaxError {
  status?: number;
  body?: unknown;
}

function isMalformedJsonError(err: unknown): err is BodyParserSyntaxError {
  return (
    err instanceof SyntaxError &&
    'status' in err &&
    (err as BodyParserSyntaxError).status === 400 &&
    'body' in err
  );
}

/**
 * Middleware de erro central (a assinatura de 4 parâmetros é o que faz o
 * Express reconhecer como error handler — precisa ficar por último,
 * depois de todas as rotas). Nunca vaza stack trace ou mensagem interna
 * ao cliente: só loga no servidor e responde algo genérico.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  if (isMalformedJsonError(err)) {
    res.status(400).json({ error: 'Corpo da requisição inválido.' });
    return;
  }

  console.error('Erro não tratado:', err);
  res.status(500).json({ error: 'Erro interno.' });
}
