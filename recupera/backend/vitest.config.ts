import { defineConfig } from 'vitest/config';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/recupera_test?schema=public';

export default defineConfig({
  test: {
    globalSetup: ['./tests/globalSetup.ts'],
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: 'segredo-de-teste-nao-usar-em-producao',
    },
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
