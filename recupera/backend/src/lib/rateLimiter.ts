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

const buckets = new Map<string, Bucket>();

export function registerFailedAttempt(key: string): void {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart > WINDOW_MS) {
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
