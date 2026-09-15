import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/requireRole';
import { asyncHandler } from '../../lib/asyncHandler';
import {
  createUsuario,
  deactivateUsuario,
  listUsuarios,
  updateUsuarioRole,
} from './usuarios.controller';

export const usuariosRouter = Router();

usuariosRouter.use(authenticate);

usuariosRouter.get('/', requireRole('OWNER', 'ADMIN'), asyncHandler(listUsuarios));
usuariosRouter.post('/', requireRole('OWNER', 'ADMIN'), asyncHandler(createUsuario));
// Alterar papel de outro usuário é ação sensível de escalação de
// privilégio — só o Owner aprova (ver Referência Rápida 2 do Guia Mestre).
usuariosRouter.patch('/:id/role', requireRole('OWNER'), asyncHandler(updateUsuarioRole));
usuariosRouter.delete('/:id', requireRole('OWNER', 'ADMIN'), asyncHandler(deactivateUsuario));
