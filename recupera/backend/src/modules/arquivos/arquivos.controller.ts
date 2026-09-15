import { Request, Response } from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import { arquivosRepository } from './arquivos.repository';
import { detectMimeType, EXTENSAO_POR_MIME } from '../../lib/fileSignature';
import { storage } from '../../lib/storage/localFilesystemStorage';
import { prismaUnscoped } from '../../lib/prisma';
import { resolverRetencaoDias, resolverTtlMaximoSegundos } from '../../config/segmentos';
import { signFileToken, verifyFileToken } from '../../lib/signedUrl';
import { isRecordNotFoundError } from '../../lib/prismaErrors';
import { requireAuthContext, requireTenantId } from '../../lib/tenantContext';

/** Sem upload maior que isto — reduz a superfície de negação de serviço. */
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
/** Categoria genérica do arquivo — nunca nome de setor fixo (ex.: "prontuario"). */
const TIPO_REGEX = /^[a-z0-9_-]{1,40}$/;

export const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_MAX_BYTES },
}).single('arquivo');

export async function uploadArquivo(req: Request, res: Response): Promise<void> {
  const tipo = typeof req.body?.tipo === 'string' ? req.body.tipo : '';
  if (!TIPO_REGEX.test(tipo)) {
    res.status(400).json({ error: 'tipo inválido — use apenas letras minúsculas, números, "_" e "-".' });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: 'arquivo é obrigatório.' });
    return;
  }

  // Validação real por bytes, nunca pela extensão nem pelo Content-Type
  // enviado pelo cliente — ambos são forjáveis (vetor de ataque citado no
  // Prompt 2.1: "arquivo malicioso renomeado").
  const mimeReal = detectMimeType(req.file.buffer);
  if (!mimeReal) {
    res.status(415).json({ error: 'Tipo de arquivo não suportado.' });
    return;
  }

  const tenantId = requireTenantId();
  const tenant = await prismaUnscoped.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) {
    res.status(404).json({ error: 'Tenant não encontrado.' });
    return;
  }

  const extensao = EXTENSAO_POR_MIME[mimeReal];
  const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex').slice(0, 16);
  // Nome aleatório (UUID+hash), nunca o nome original — que pode revelar
  // informação sensível (Prompt 2.1).
  const nomeArmazenado = `${crypto.randomUUID()}-${hash}.${extensao}`;
  const storagePath = `${tenantId}/${tipo}/${nomeArmazenado}`;

  const retencaoDias = resolverRetencaoDias(tenant);
  const retentionUntil = new Date(Date.now() + retencaoDias * 24 * 60 * 60 * 1000);

  await storage.save(storagePath, req.file.buffer);

  try {
    const arquivo = await arquivosRepository.create({
      tenantId,
      tipo,
      nomeOriginal: req.file.originalname.slice(0, 255),
      mimeType: mimeReal,
      tamanhoBytes: req.file.size,
      storagePath,
      retentionUntil,
    });
    res.status(201).json({
      arquivo: {
        id: arquivo.id,
        tipo: arquivo.tipo,
        mimeType: arquivo.mimeType,
        tamanhoBytes: arquivo.tamanhoBytes,
        retentionUntil: arquivo.retentionUntil,
      },
    });
  } catch (error) {
    // Não deixa órfão no storage se o registro no banco falhar depois de já
    // termos gravado os bytes.
    await storage.delete(storagePath).catch(() => undefined);
    throw error;
  }
}

export async function listArquivos(_req: Request, res: Response): Promise<void> {
  const arquivos = await arquivosRepository.list();
  res.json({ arquivos });
}

export async function gerarUrlArquivo(req: Request, res: Response): Promise<void> {
  const arquivo = await arquivosRepository.getById(req.params.id);
  if (!arquivo) {
    res.status(404).json({ error: 'Arquivo não encontrado.' });
    return;
  }

  const tenant = await prismaUnscoped.tenant.findUnique({ where: { id: arquivo.tenantId } });
  const ttlMaximo = tenant ? resolverTtlMaximoSegundos(tenant) : 300;
  const { token, expiresAt } = signFileToken(arquivo.id, ttlMaximo);

  // Log de cada geração de URL (Prompt 2.1, bullet ACESSO) — quem gerou,
  // para qual arquivo, e até quando o link valia.
  const auth = requireAuthContext();
  await arquivosRepository.registrarAcesso(arquivo.id, auth.userId, new Date(expiresAt * 1000));

  res.json({ url: `/arquivos/download?token=${token}`, expiresAt });
}

/**
 * Único endpoint público deste módulo: a segurança vem da assinatura HMAC
 * + expiração curta do token (capability URL, como um link pré-assinado de
 * S3), não de um JWT de sessão no momento do download.
 */
export async function downloadArquivo(req: Request, res: Response): Promise<void> {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const verificado = verifyFileToken(token);
  if (!verificado) {
    res.status(401).json({ error: 'Link inválido ou expirado.' });
    return;
  }

  const arquivo = await prismaUnscoped.arquivo.findFirst({ where: { id: verificado.arquivoId } });
  if (!arquivo) {
    res.status(404).json({ error: 'Arquivo não encontrado.' });
    return;
  }

  let buffer: Buffer;
  try {
    buffer = await storage.read(arquivo.storagePath);
  } catch {
    // Registro existe mas os bytes não (ex.: exclusão parcial interrompida).
    // 404 é a resposta honesta — melhor que um 500 opaco.
    res.status(404).json({ error: 'Arquivo não encontrado.' });
    return;
  }

  res.setHeader('Content-Type', arquivo.mimeType);
  // Defesa em profundidade para o conteúdo servido: nunca deixar o browser
  // adivinhar o tipo, e isolar o arquivo de qualquer origem/script.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(arquivo.nomeOriginal)}"`);
  res.send(buffer);
}

export async function updateBloqueioExclusao(req: Request, res: Response): Promise<void> {
  const { bloqueado, motivo } = req.body ?? {};
  if (typeof bloqueado !== 'boolean') {
    res.status(400).json({ error: 'bloqueado (boolean) é obrigatório.' });
    return;
  }
  if (bloqueado && typeof motivo !== 'string') {
    res.status(400).json({ error: 'motivo é obrigatório ao bloquear a exclusão.' });
    return;
  }

  const arquivo = await arquivosRepository.getById(req.params.id);
  if (!arquivo) {
    res.status(404).json({ error: 'Arquivo não encontrado.' });
    return;
  }

  const atualizado = await arquivosRepository.setBloqueioExclusao(
    req.params.id,
    bloqueado,
    bloqueado ? motivo : null,
  );
  res.json({
    arquivo: {
      id: atualizado.id,
      exclusaoBloqueada: atualizado.exclusaoBloqueada,
      motivoBloqueioExclusao: atualizado.motivoBloqueioExclusao,
    },
  });
}

export async function deleteArquivo(req: Request, res: Response): Promise<void> {
  const arquivo = await arquivosRepository.getById(req.params.id);
  if (!arquivo) {
    res.status(404).json({ error: 'Arquivo não encontrado.' });
    return;
  }
  if (arquivo.exclusaoBloqueada) {
    // Prazo legal (ex.: fiscal) — nunca exclusão cosmética que ignore isso.
    res.status(409).json({
      error: `Exclusão bloqueada: ${arquivo.motivoBloqueioExclusao ?? 'prazo legal de retenção.'}`,
    });
    return;
  }

  // Exclusão real, não soft delete cosmético: os bytes saem do storage.
  // Bytes primeiro, registro depois: se o delete do registro falhar, a
  // varredura de retenção reencontra a linha e termina o serviço. Na ordem
  // inversa, os bytes ficariam órfãos, sem nenhum registro que os aponte.
  await storage.delete(arquivo.storagePath);

  try {
    await arquivosRepository.remove(req.params.id);
  } catch (error) {
    if (isRecordNotFoundError(error)) {
      res.status(404).json({ error: 'Arquivo não encontrado.' });
      return;
    }
    throw error;
  }

  res.status(204).send();
}
