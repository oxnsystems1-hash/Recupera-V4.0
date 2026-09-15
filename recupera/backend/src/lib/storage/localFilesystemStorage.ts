import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env';

/**
 * Storage privado local (MVP): fora de qualquer diretório servido
 * estaticamente pelo Express — o único jeito de ler um arquivo é pelo
 * código do backend, nunca por URL pública direta. Em produção, trocar
 * por um provider de object storage (S3/GCS/R2) atrás da mesma interface
 * — decisão de infraestrutura do Dia 14, fora de escopo do Dia 4.
 */
class LocalFilesystemStorage {
  constructor(private readonly root: string) {}

  private resolve(relativePath: string): string {
    const full = path.resolve(this.root, relativePath);
    // relativePath é sempre montado internamente a partir de tenantId (uuid
    // do banco) + tipo (validado por regex) + nome gerado (uuid+hash) — mas
    // confere aqui também que o resultado nunca escapa da raiz do storage,
    // como última barreira contra path traversal.
    if (!full.startsWith(path.resolve(this.root) + path.sep)) {
      throw new Error('Path de storage inválido.');
    }
    return full;
  }

  async save(relativePath: string, data: Buffer): Promise<void> {
    const full = this.resolve(relativePath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
  }

  async read(relativePath: string): Promise<Buffer> {
    return fs.readFile(this.resolve(relativePath));
  }

  async delete(relativePath: string): Promise<void> {
    await fs.rm(this.resolve(relativePath), { force: true });
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(relativePath));
      return true;
    } catch {
      return false;
    }
  }
}

export const storage = new LocalFilesystemStorage(env.storageRoot);
