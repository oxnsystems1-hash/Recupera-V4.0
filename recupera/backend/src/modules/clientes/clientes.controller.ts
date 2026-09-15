import { Request, Response } from 'express';
import { clientesRepository } from './clientes.repository';
import { isRecordNotFoundError } from '../../lib/prismaErrors';
import { emailValido, textoObrigatorio } from '../../lib/validation';

/** Teto do termo de busca: um `contains` gigante só serve para pesar no banco. */
const MAX_BUSCA = 100;

export async function listClientes(req: Request, res: Response): Promise<void> {
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, MAX_BUSCA).trim() : undefined;
  const clientes = await clientesRepository.list(q || undefined);
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
  const { nome: nomeBruto, telefone: telefoneBruto, email: emailBruto } = req.body ?? {};

  const nome = textoObrigatorio(nomeBruto);
  const telefone = textoObrigatorio(telefoneBruto, 30);
  if (!nome || !telefone) {
    res.status(400).json({ error: 'nome e telefone são obrigatórios (texto, dentro do limite).' });
    return;
  }

  const email = emailBruto === undefined || emailBruto === null || emailBruto === ''
    ? undefined
    : emailValido(emailBruto);
  if (email === null) {
    res.status(400).json({ error: 'email inválido.' });
    return;
  }

  const cliente = await clientesRepository.create({ nome, telefone, email });
  res.status(201).json({ cliente });
}

export async function deleteCliente(req: Request, res: Response): Promise<void> {
  try {
    await clientesRepository.remove(req.params.id);
    res.status(204).send();
  } catch (error) {
    if (isRecordNotFoundError(error)) {
      res.status(404).json({ error: 'Cliente não encontrado.' });
      return;
    }
    throw error;
  }
}
