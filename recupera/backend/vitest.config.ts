import { defineConfig } from 'vitest/config';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/recupera_test?schema=public';

export default defineConfig({
  test: {
    // Todos os arquivos de teste compartilham o mesmo banco Postgres de
    // teste e fazem deleteMany() global no setup/teardown; rodar em
    // paralelo faria um arquivo apagar as fixtures de outro no meio do
    // teste. Mantém a suíte sequencial (ainda paralela dentro do mesmo
    // arquivo) até existir isolamento por schema/transação por arquivo.
    fileParallelism: false,
    globalSetup: ['./tests/globalSetup.ts'],
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: 'segredo-de-teste-nao-usar-em-producao',
      MFA_ENCRYPTION_KEY: '0'.repeat(63) + '1',
    },
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
