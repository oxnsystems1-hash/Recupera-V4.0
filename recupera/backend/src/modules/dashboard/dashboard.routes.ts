import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/requireRole';
import { asyncHandler } from '../../lib/asyncHandler';
import { obterDashboard } from './dashboard.controller';

export const dashboardRouter = Router();

dashboardRouter.use(authenticate);
// Dashboard é tela de Owner/Admin (Prompt 3.1): consolida métrica do tenant
// inteiro, que é justamente o que Atendente e Read Only não acessam.
dashboardRouter.get('/', requireRole('OWNER', 'ADMIN'), asyncHandler(obterDashboard));
