import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/requireRole';
import { asyncHandler } from '../../lib/asyncHandler';
import {
  deleteArquivo,
  downloadArquivo,
  gerarUrlArquivo,
  listArquivos,
  updateBloqueioExclusao,
  uploadArquivo,
  uploadMiddleware,
} from './arquivos.controller';

export const arquivosRouter = Router();

// Único endpoint público do módulo: a segurança é a assinatura HMAC de
// curta duração do token, não um JWT de sessão — precisa vir antes do
// `authenticate` abaixo.
arquivosRouter.get('/download', asyncHandler(downloadArquivo));

arquivosRouter.use(authenticate);

arquivosRouter.get('/', asyncHandler(listArquivos));
// Read Only não pode editar nada (mesma regra de clientes.routes.ts).
arquivosRouter.post('/', requireRole('OWNER', 'ADMIN', 'ATENDENTE'), uploadMiddleware, asyncHandler(uploadArquivo));
arquivosRouter.get('/:id/url', asyncHandler(gerarUrlArquivo));
arquivosRouter.patch('/:id/bloqueio', requireRole('OWNER', 'ADMIN'), asyncHandler(updateBloqueioExclusao));
arquivosRouter.delete('/:id', requireRole('OWNER', 'ADMIN'), asyncHandler(deleteArquivo));
