import { createApp } from './app';
import { env } from './config/env';

const app = createApp();

app.listen(env.port, () => {
  console.log(`Recupera backend ouvindo na porta ${env.port}`);
});
