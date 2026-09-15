import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { usuariosRepository } from './usuarios.repository';
import { isRecordNotFoundError, isUniqueConstraintError } from '../../lib/prismaErrors';
import { BCRYPT_COST } from '../../config/security';
import { emailValido } from '../../lib/validation';

/**
 * OWNER nunca é criado/alterado por estas rotas: só existe um por tenant, e
 * transferi-lo é uma ação própria do Owner, fora de escopo do Dia 3.
 */
const ASSIGNABLE_ROLES = new Set(['ADMIN', 'ATENDENTE', 'READ_ONLY']);
const MIN_PASSWORD_LENGTH = 8;
/** bcrypt ignora bytes além de 72 — aceitar mais dá falsa sensação de força. */
const MAX_PASSWORD_LENGTH = 72;

export async function listUsuarios(_req: Request, res: Response): Promise<void> {
  const usuarios = await usuariosRepository.list();
  res.json({ usuarios });
}

export async function createUsuario(req: Request, res: Response): Promise<void> {
  const { email: emailBruto, senha, role } = req.body ?? {};
  if (typeof senha !== 'string' || typeof role !== 'string') {
    res.status(400).json({ error: 'email, senha e role são obrigatórios.' });
    return;
  }
  // emailValido já normaliza para minúsculas: mantém o login não sensível a
  // maiúsculas/minúsculas e evita duplicidade tipo "a@x.com" / "A@x.com".
  const email = emailValido(emailBruto);
  if (!email) {
    res.status(400).json({ error: 'email inválido.' });
    return;
  }
  if (senha.length < MIN_PASSWORD_LENGTH || senha.length > MAX_PASSWORD_LENGTH) {
    res.status(400).json({
      error: `senha deve ter entre ${MIN_PASSWORD_LENGTH} e ${MAX_PASSWORD_LENGTH} caracteres.`,
    });
    return;
  }
  if (!ASSIGNABLE_ROLES.has(role)) {
    res.status(400).json({ error: 'role inválida.' });
    return;
  }

  const passwordHash = await bcrypt.hash(senha, BCRYPT_COST);
  try {
    const usuario = await usuariosRepository.create({ email, passwordHash, role });
    res.status(201).json({
      usuario: { id: usuario.id, email: usuario.email, role: usuario.role, active: usuario.active },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      res.status(409).json({ error: 'E-mail já cadastrado neste tenant.' });
      return;
    }
    throw error;
  }
}

export async function updateUsuarioRole(req: Request, res: Response): Promise<void> {
  const { role } = req.body ?? {};
  if (typeof role !== 'string' || !ASSIGNABLE_ROLES.has(role)) {
    res.status(400).json({ error: 'role inválida.' });
    return;
  }

  const alvo = await usuariosRepository.getById(req.params.id);
  if (!alvo) {
    // Cross-tenant: nunca revelar existência (mesma regra do Dia 2).
    res.status(404).json({ error: 'Usuário não encontrado.' });
    return;
  }
  if (alvo.role === 'OWNER') {
    // Mesmo tenant, ação de RBAC negada: 403, não 404 — a existência do
    // Owner já é visível na listagem, não há o que esconder aqui.
    res.status(403).json({ error: 'Não é possível alterar o papel do Owner por esta rota.' });
    return;
  }

  const usuario = await usuariosRepository.updateRole(req.params.id, role);
  res.json({ usuario: { id: usuario.id, email: usuario.email, role: usuario.role } });
}

export async function deactivateUsuario(req: Request, res: Response): Promise<void> {
  const alvo = await usuariosRepository.getById(req.params.id);
  if (!alvo) {
    res.status(404).json({ error: 'Usuário não encontrado.' });
    return;
  }
  if (alvo.role === 'OWNER') {
    res.status(403).json({ error: 'Não é possível desativar o Owner por esta rota.' });
    return;
  }
  if (alvo.id === req.auth?.userId) {
    // Um Admin se desativando se tranca para fora sem ninguém para
    // reverter — se a intenção for sair, o caminho é o logout.
    res.status(400).json({ error: 'Não é possível desativar a própria conta.' });
    return;
  }

  try {
    const usuario = await usuariosRepository.deactivate(req.params.id);
    res.json({ usuario: { id: usuario.id, active: usuario.active } });
  } catch (error) {
    if (isRecordNotFoundError(error)) {
      res.status(404).json({ error: 'Usuário não encontrado.' });
      return;
    }
    throw error;
  }
}
