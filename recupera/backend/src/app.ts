import express, { Express } from 'express';
import helmet from 'helmet';
import { stripSpoofedTenantId } from './middleware/stripSpoofedTenantId';
import { errorHandler } from './middleware/errorHandler';
import { authRouter } from './modules/auth/auth.routes';
import { clientesRouter } from './modules/clientes/clientes.routes';
import { usuariosRouter } from './modules/usuarios/usuarios.routes';

export function createApp(): Express {
  const app = express();

  app.use(helmet());
  // Sem upload de arquivo ainda (Dia 4): limite baixo é suficiente e reduz
  // a superfície para payload de negação de serviço.
  app.use(express.json({ limit: '100kb' }));
  app.use(stripSpoofedTenantId);

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/auth', authRouter);
  app.use('/clientes', clientesRouter);
  app.use('/usuarios', usuariosRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: 'Rota não encontrada.' });
  });

  // Sempre por último: é o que faz o Express reconhecer como error handler.
  app.use(errorHandler);

  return app;
}
