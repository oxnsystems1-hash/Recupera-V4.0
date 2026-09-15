import { createApp } from './app';
import { env } from './config/env';
import { runRetentionSweep } from './jobs/retentionSweep';
import { runLgpdSweep } from './jobs/lgpdSweep';

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
  // Exclusões LGPD que estavam bloqueadas por prazo legal já vencido
  // (Dia 5): o direito do titular não depende de alguém lembrar de voltar.
  runLgpdSweep().catch((error) => {
    console.error('Falha na varredura de exclusões LGPD:', error);
  });
}, RETENTION_SWEEP_INTERVAL_MS);
