import { createApp } from './app';
import { env } from './config/env';
import { runRetentionSweep } from './jobs/retentionSweep';

const app = createApp();

app.listen(env.port, () => {
  console.log(`Recupera backend ouvindo na porta ${env.port}`);
});

/**
 * "Cron automático" do Prompt 2.1 (Dia 4), versão MVP: setInterval no
 * próprio processo. Um scheduler externo com monitoramento e alerta em
 * falha é decisão de infraestrutura do Dia 14 — deliberadamente fora de
 * escopo aqui. Só roda no processo real do servidor (não em createApp(),
 * que os testes importam) para a suíte continuar determinística.
 */
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
setInterval(() => {
  runRetentionSweep().catch((error) => {
    console.error('Falha na varredura de retenção:', error);
  });
}, RETENTION_SWEEP_INTERVAL_MS);
