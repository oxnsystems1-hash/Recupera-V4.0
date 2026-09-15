import express, { Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { env } from './config/env';
import { stripSpoofedTenantId } from './middleware/stripSpoofedTenantId';
import { errorHandler } from './middleware/errorHandler';
import { authRouter } from './modules/auth/auth.routes';
import { clientesRouter } from './modules/clientes/clientes.routes';
import { usuariosRouter } from './modules/usuarios/usuarios.routes';
import { arquivosRouter } from './modules/arquivos/arquivos.routes';
import { lgpdRouter } from './modules/lgpd/lgpd.routes';
import { dashboardRouter } from './modules/dashboard/dashboard.routes';
import { agendaRouter } from './modules/agenda/agenda.routes';
import { inboxRouter } from './modules/inbox/inbox.routes';

export function createApp(): Express {
  const app = express();

  // req.ip é a chave do rate limiting por IP: sem isto, atrás de um proxy
  // todos os clientes viram o mesmo IP. Configurado por env, nunca "true"
  // cego (que deixaria o cliente forjar X-Forwarded-For).
  app.set('trust proxy', env.trustProxy);

  app.use(helmet());
  // CORS com allowlist: o frontend roda em outra origem (Vite, porta 5173).
  // `credentials` fica desligado de propósito — a sessão viaja no header
  // Authorization, não em cookie, então não há nada para o navegador anexar
  // automaticamente e, por tabela, não há superfície de CSRF.
  app.use(
    cors({
      origin: env.corsOrigens,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: false,
      maxAge: 600,
    }),
  );
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
  app.use('/lgpd', lgpdRouter);
  app.use('/dashboard', dashboardRouter);
  app.use('/agenda', agendaRouter);
  app.use('/conversas', inboxRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: 'Rota não encontrada.' });
  });

  // Sempre por último: é o que faz o Express reconhecer como error handler.
  app.use(errorHandler);

  return app;
}
