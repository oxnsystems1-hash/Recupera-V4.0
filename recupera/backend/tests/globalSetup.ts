import { execSync } from 'node:child_process';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/recupera_test?schema=public';

/**
 * Prepara o banco de teste aplicando as MIGRATIONS, não um `db push`.
 *
 * A diferença não é cosmética: `db push` só reconcilia o schema declarado
 * no schema.prisma e ignora tudo que vive dentro das migrations — no nosso
 * caso, o trigger que torna `logs_auditoria` append-only e impõe a retenção
 * mínima de 5 anos (Dia 5). Com `db push`, a suíte passaria verde sem
 * nunca exercitar a garantia que o banco de produção realmente aplica.
 * Teste tem que rodar sobre o mesmo banco que vai para produção.
 *
 * `migrate reset --force` recria do zero a cada execução, então a suíte
 * nunca herda estado de uma rodada anterior.
 */
export default function setup(): void {
  execSync('npx prisma migrate reset --force --skip-generate --skip-seed', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}
