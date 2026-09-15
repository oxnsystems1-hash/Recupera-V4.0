import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { asyncHandler } from '../src/lib/asyncHandler';
import { errorHandler } from '../src/middleware/errorHandler';

/**
 * Cobre a falha encontrada em revisão pós-Dia 3: Express 4 não encaminha
 * sozinho uma Promise rejeitada de um handler async para o middleware de
 * erro — sem lib/asyncHandler.ts + middleware/errorHandler.ts, um erro
 * inesperado (ex.: banco fora do ar) vira um unhandledRejection e pode
 * derrubar o processo inteiro, afetando todos os tenants.
 */

const app = createApp();

describe('Tratamento central de erros', () => {
  it('rota desconhecida responde 404 em JSON, nunca a página HTML padrão do Express', async () => {
    const response = await request(app).get('/rota-que-nao-existe');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Rota não encontrada.' });
  });

  it('corpo JSON malformado responde 400 em JSON, sem vazar stack trace', async () => {
    const response = await request(app)
      .post('/auth/login')
      .set('Content-Type', 'application/json')
      .send('{ isto não é json válido');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Corpo da requisição inválido.' });
  });

  it('asyncHandler encaminha rejeição para next() em vez de deixar a Promise sem tratamento', async () => {
    const erro = new Error('falha simulada de banco');
    const handlerQueFalha = asyncHandler(async () => {
      throw erro;
    });

    const next = vi.fn();
    handlerQueFalha({} as never, {} as never, next);
    // handlerQueFalha não retorna a Promise interna (é o contrato de um
    // RequestHandler do Express) — espera um tick para o .catch() rodar.
    await new Promise((resolve) => setImmediate(resolve));

    expect(next).toHaveBeenCalledWith(erro);
  });

  it('erro lançado por um controller chega ao errorHandler como 500 em JSON (ponta a ponta)', async () => {
    // App mínimo isolado — createApp() já registra seu próprio catch-all de
    // 404 antes de qualquer rota extra que se tentasse anexar depois.
    const appDeTeste = express();
    appDeTeste.get(
      '/rota-que-falha',
      asyncHandler(async () => {
        throw new Error('falha simulada de banco');
      }),
    );
    appDeTeste.use(errorHandler);

    const response = await request(appDeTeste).get('/rota-que-falha');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Erro interno.' });
  });
});
