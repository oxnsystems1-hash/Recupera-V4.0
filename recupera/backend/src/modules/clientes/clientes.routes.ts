import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { createCliente, getCliente, listClientes } from './clientes.controller';

export const clientesRouter = Router();

clientesRouter.use(authenticate);

clientesRouter.get('/', listClientes);
clientesRouter.get('/:id', getCliente);
clientesRouter.post('/', createCliente);
