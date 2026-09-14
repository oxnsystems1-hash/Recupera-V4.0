import { execSync } from 'node:child_process';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/recupera_test?schema=public';

/**
 * Sincroniza o schema com o banco de teste antes da suíte rodar. Usa
 * `db push` (em vez de `migrate deploy`) porque este é o schema inicial do
 * projeto e ainda não há histórico de migrations versionado.
 */
export default function setup(): void {
  execSync('npx prisma db push --skip-generate --accept-data-loss', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}
