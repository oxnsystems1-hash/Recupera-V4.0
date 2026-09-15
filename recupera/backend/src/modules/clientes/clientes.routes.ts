import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/requireRole';
import { asyncHandler } from '../../lib/asyncHandler';
import { createCliente, deleteCliente, getCliente, listClientes } from './clientes.controller';

export const clientesRouter = Router();

clientesRouter.use(authenticate);

// Leitura: todos os papéis autenticados (Read Only inclusive) podem
// visualizar clientes — ver Referência Rápida 2 do Guia Mestre.
clientesRouter.get('/', asyncHandler(listClientes));
clientesRouter.get('/:id', asyncHandler(getCliente));
// Read Only não pode editar nada.
clientesRouter.post('/', requireRole('OWNER', 'ADMIN', 'ATENDENTE'), asyncHandler(createCliente));
// Exclusão de clientes: Atendente e Read Only não podem.
clientesRouter.delete('/:id', requireRole('OWNER', 'ADMIN'), asyncHandler(deleteCliente));
