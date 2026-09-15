import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/requireRole';
import { asyncHandler } from '../../lib/asyncHandler';
import {
  descartarSugestao,
  enviarMensagem,
  enviarSugestao,
  listarConversas,
  listarMensagens,
  marcarComoLida,
} from './inbox.controller';

export const inboxRouter = Router();

inboxRouter.use(authenticate);

// Read Only "visualiza conversas" — leitura aberta a todos os autenticados.
inboxRouter.get('/', asyncHandler(listarConversas));
inboxRouter.get('/:id/mensagens', asyncHandler(listarMensagens));

// Qualquer escrita (inclusive marcar como lida) é edição: fora para Read Only.
const PODE_ATENDER = ['OWNER', 'ADMIN', 'ATENDENTE'] as const;

inboxRouter.post('/:id/mensagens', requireRole(...PODE_ATENDER), asyncHandler(enviarMensagem));
inboxRouter.post(
  '/:id/sugestoes/:mensagemId/enviar',
  requireRole(...PODE_ATENDER),
  asyncHandler(enviarSugestao),
);
inboxRouter.post(
  '/:id/sugestoes/:mensagemId/descartar',
  requireRole(...PODE_ATENDER),
  asyncHandler(descartarSugestao),
);
inboxRouter.patch('/:id/lida', requireRole(...PODE_ATENDER), asyncHandler(marcarComoLida));
