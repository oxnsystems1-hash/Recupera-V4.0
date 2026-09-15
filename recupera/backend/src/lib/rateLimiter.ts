/**
 * Rate limiting de tentativas (Dia 3 / Prompt 1.3: "5 tentativas/15min,
 * IP + conta"). Janela fixa em memória — suficiente para o MVP de
 * processo único; se o backend escalar horizontalmente, migrar para um
 * store compartilhado (Redis) mantendo a mesma interface.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

interface Bucket {
  count: number;
  windowStart: number;
}

/**
 * Teto de chaves em memória. Sem ele, tentativas de login com e-mails
 * aleatórios criariam uma chave nova por tentativa e o Map cresceria sem
 * limite — exaustão de memória a partir de um endpoint público.
 */
const MAX_BUCKETS = 50_000;

const buckets = new Map<string, Bucket>();

function purgeExpired(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart > WINDOW_MS) {
      buckets.delete(key);
    }
  }
}

export function registerFailedAttempt(key: string): void {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart > WINDOW_MS) {
    if (buckets.size >= MAX_BUCKETS) {
      purgeExpired(now);
      if (buckets.size >= MAX_BUCKETS) {
        // Ainda cheio só de janelas ativas: descarta a chave mais antiga
        // (inserção é ordenada no Map) em vez de crescer indefinidamente.
        const maisAntiga = buckets.keys().next();
        if (!maisAntiga.done) buckets.delete(maisAntiga.value);
      }
    }
    buckets.set(key, { count: 1, windowStart: now });
    return;
  }
  bucket.count += 1;
}

export function isRateLimited(key: string): boolean {
  const bucket = buckets.get(key);
  if (!bucket) return false;
  if (Date.now() - bucket.windowStart > WINDOW_MS) {
    buckets.delete(key);
    return false;
  }
  return bucket.count >= MAX_ATTEMPTS;
}

export function resetAttempts(key: string): void {
  buckets.delete(key);
}

/** Uso exclusivo dos testes, para isolar suítes entre si. */
export function clearAllRateLimits(): void {
  buckets.clear();
}
