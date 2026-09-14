import { Request, Response } from 'express';
import { clientesRepository } from './clientes.repository';

export async function listClientes(req: Request, res: Response): Promise<void> {
  const q = typeof req.query.q === 'string' ? req.query.q : undefined;
  const clientes = await clientesRepository.list(q);
  res.json({ clientes });
}

export async function getCliente(req: Request, res: Response): Promise<void> {
  const cliente = await clientesRepository.getById(req.params.id);
  if (!cliente) {
    // Nunca 403: um 403 aqui revelaria que o ID existe (em outro tenant).
    res.status(404).json({ error: 'Cliente não encontrado.' });
    return;
  }
  res.json({ cliente });
}

export async function createCliente(req: Request, res: Response): Promise<void> {
  const { nome, telefone, email } = req.body ?? {};
  if (typeof nome !== 'string' || typeof telefone !== 'string') {
    res.status(400).json({ error: 'nome e telefone são obrigatórios.' });
    return;
  }
  const cliente = await clientesRepository.create({ nome, telefone, email });
  res.status(201).json({ cliente });
}
