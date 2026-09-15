import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/requireRole';
import { asyncHandler } from '../../lib/asyncHandler';
import {
  atualizarAgendamento,
  cancelarAgendamento,
  criarAgendamento,
  listarAgendamentos,
  listarDisponibilidade,
  listarProfissionais,
  listarServicos,
} from './agenda.controller';

export const agendaRouter = Router();

agendaRouter.use(authenticate);

// Read Only "visualiza agendamentos" (Referência Rápida 2) — leitura aberta
// a todos os papéis autenticados.
agendaRouter.get('/agendamentos', asyncHandler(listarAgendamentos));
agendaRouter.get('/profissionais', asyncHandler(listarProfissionais));
agendaRouter.get('/servicos', asyncHandler(listarServicos));
// Disponibilidade é leitura derivada dos mesmos agendamentos que o Read Only
// já pode listar — exigir papel de edição aqui seria uma inconsistência de
// RBAC: esconderia da tela algo que a rota ao lado entrega mesmo assim.
agendaRouter.get('/disponibilidade', asyncHandler(listarDisponibilidade));

// Escrita: "Atendente pode criar/editar agendamentos"; Read Only não edita nada.
const PODE_EDITAR_AGENDA = ['OWNER', 'ADMIN', 'ATENDENTE'] as const;
agendaRouter.post('/agendamentos', requireRole(...PODE_EDITAR_AGENDA), asyncHandler(criarAgendamento));
agendaRouter.patch(
  '/agendamentos/:id',
  requireRole(...PODE_EDITAR_AGENDA),
  asyncHandler(atualizarAgendamento),
);
agendaRouter.post(
  '/agendamentos/:id/cancelar',
  requireRole(...PODE_EDITAR_AGENDA),
  asyncHandler(cancelarAgendamento),
);
