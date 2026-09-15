import express, { Express } from 'express';
import helmet from 'helmet';
import { env } from './config/env';
import { stripSpoofedTenantId } from './middleware/stripSpoofedTenantId';
import { errorHandler } from './middleware/errorHandler';
import { authRouter } from './modules/auth/auth.routes';
import { clientesRouter } from './modules/clientes/clientes.routes';
import { usuariosRouter } from './modules/usuarios/usuarios.routes';
import { arquivosRouter } from './modules/arquivos/arquivos.routes';

export function createApp(): Express {
  const app = express();

  // req.ip é a chave do rate limiting por IP: sem isto, atrás de um proxy
  // todos os clientes viram o mesmo IP. Configurado por env, nunca "true"
  // cego (que deixaria o cliente forjar X-Forwarded-For).
  app.set('trust proxy', env.trustProxy);

  app.use(helmet());
  // Limite baixo para corpo JSON — reduz a superfície de payload de negação
  // de serviço. Upload de arquivo (multipart, Dia 4) não passa por aqui:
  // tem limite próprio em modules/arquivos/arquivos.controller.ts.
  app.use(express.json({ limit: '100kb' }));
  app.use(stripSpoofedTenantId);

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/auth', authRouter);
  app.use('/clientes', clientesRouter);
  app.use('/usuarios', usuariosRouter);
  app.use('/arquivos', arquivosRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: 'Rota não encontrada.' });
  });

  // Sempre por último: é o que faz o Express reconhecer como error handler.
  app.use(errorHandler);

  return app;
}
