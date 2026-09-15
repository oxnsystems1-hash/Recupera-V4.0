import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/requireRole';
import { asyncHandler } from '../../lib/asyncHandler';
import {
  aprovarSolicitacao,
  confirmarCorrecao,
  exportarDadosTitular,
  listarAuditoria,
  listarSolicitacoes,
  solicitarCorrecao,
  solicitarExclusao,
} from './lgpd.controller';

export const lgpdRouter = Router();

// Confirmação do titular é pública por natureza: quem confirma não tem
// sessão no sistema. A credencial é o token opaco de uso único — precisa
// vir antes do `authenticate`.
lgpdRouter.post('/corrigir/confirmar', asyncHandler(confirmarCorrecao));

lgpdRouter.use(authenticate);

// Direitos do titular são operados por quem atende (Owner/Admin), nunca
// por Read Only, que não pode editar nada (Referência Rápida 2).
lgpdRouter.post('/exportar', requireRole('OWNER', 'ADMIN'), asyncHandler(exportarDadosTitular));
lgpdRouter.patch('/corrigir', requireRole('OWNER', 'ADMIN'), asyncHandler(solicitarCorrecao));
lgpdRouter.delete('/excluir', requireRole('OWNER', 'ADMIN'), asyncHandler(solicitarExclusao));

lgpdRouter.get('/solicitacoes', requireRole('OWNER', 'ADMIN'), asyncHandler(listarSolicitacoes));
// Aprovar ação sensível é exclusividade do Owner (Referência Rápida 2:
// Admin "não pode aprovar as próprias solicitações sensíveis").
lgpdRouter.post('/solicitacoes/:id/aprovar', requireRole('OWNER'), asyncHandler(aprovarSolicitacao));

// Painel de auditoria completo: Owner.
lgpdRouter.get('/auditoria', requireRole('OWNER'), asyncHandler(listarAuditoria));
