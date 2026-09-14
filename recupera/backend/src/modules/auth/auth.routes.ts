import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prismaUnscoped } from '../../lib/prisma';
import { env } from '../../config/env';

export const authRouter = Router();

/**
 * Login mínimo, suficiente para o teste de isolamento de tenant do Dia 2
 * (autenticar e obter um JWT com tenant_id embutido). Autenticação/RBAC/MFA
 * completos são escopo do Dia 3 — ver /docs/especificacao-seguranca-lgpd.md.
 *
 * Este é o único lugar do backend autorizado a consultar `User` sem
 * tenant_id no contexto: é justamente aqui que o tenant_id é descoberto e
 * embutido no JWT pela primeira vez.
 */
authRouter.post('/login', async (req, res) => {
  const { email, senha } = req.body ?? {};
  if (typeof email !== 'string' || typeof senha !== 'string') {
    res.status(400).json({ error: 'email e senha são obrigatórios.' });
    return;
  }

  const user = await prismaUnscoped.user.findFirst({ where: { email } });
  const senhaValida = user ? await bcrypt.compare(senha, user.passwordHash) : false;

  if (!user || !senhaValida) {
    res.status(401).json({ error: 'Credenciais inválidas.' });
    return;
  }

  const token = jwt.sign(
    { tenantId: user.tenantId, userId: user.id, role: user.role },
    env.jwtSecret,
    { expiresIn: '8h' },
  );

  res.json({ token });
});
