import express, { Express } from 'express';
import { stripSpoofedTenantId } from './middleware/stripSpoofedTenantId';
import { authRouter } from './modules/auth/auth.routes';
import { clientesRouter } from './modules/clientes/clientes.routes';

export function createApp(): Express {
  const app = express();

  app.use(express.json());
  app.use(stripSpoofedTenantId);

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/auth', authRouter);
  app.use('/clientes', clientesRouter);

  return app;
}
