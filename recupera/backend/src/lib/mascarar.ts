/**
 * Mascaramento de dado pessoal para o log de auditoria (Dia 5 / Prompt 2.2:
 * "nunca logar senha/token/secret · mascarar CPF e e-mail").
 *
 * A regra é sempre a mesma: o log serve para provar *o que aconteceu*, não
 * para reconstruir o dado do titular. Quem precisa do dado consulta a
 * tabela de origem, com RBAC; quem lê auditoria vê só o suficiente para
 * reconhecer o registro.
 */

/**
 * "12345678901" ou "123.456.789-01" → "***.***.***-**"
 *
 * As fronteiras `(?<!\d)`/`(?!\d)` evitam casar um trecho de número maior —
 * sem elas, os 11 primeiros dígitos de um timestamp de 13 virariam "CPF"
 * e o log sairia adulterado.
 */
export function mascararCpf(valor: string): string {
  return valor.replace(/(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/g, '***.***.***-**');
}

/** "joao@gmail.com" → "j***@gmail.com" */
export function mascararEmail(valor: string): string {
  return valor.replace(/([^\s@])([^\s@]*)@([^\s@]+)/g, (_todo, primeira, _resto, dominio) => {
    return `${primeira}***@${dominio}`;
  });
}

/**
 * Chaves cujo VALOR nunca pode aparecer no log, nem mascarado: segredo é
 * segredo. Casa por substring, em minúsculas — `passwordHash`,
 * `refreshToken`, `mfaSecret`, `authorization` etc. caem todos aqui.
 */
const CHAVES_SECRETAS = [
  'senha',
  'password',
  'token',
  'secret',
  'hash',
  'authorization',
  'cookie',
  'credential',
  'apikey',
  'api_key',
];

function ehChaveSecreta(chave: string): boolean {
  const normalizada = chave.toLowerCase();
  return CHAVES_SECRETAS.some((secreta) => normalizada.includes(secreta));
}

/** Texto livre pode conter CPF/e-mail no meio da frase — mascara os dois. */
export function mascararTexto(valor: string): string {
  return mascararEmail(mascararCpf(valor));
}

const PROFUNDIDADE_MAXIMA = 6;

/**
 * Prepara um objeto arbitrário para virar `detalhes` de auditoria: remove
 * o valor de qualquer chave secreta e mascara CPF/e-mail no que sobrar.
 * Percorre objetos e arrays aninhados, com teto de profundidade para não
 * travar em estrutura cíclica ou absurdamente aninhada.
 */
export function sanitizarParaAuditoria(valor: unknown, profundidade = 0): unknown {
  if (profundidade > PROFUNDIDADE_MAXIMA) return '[profundidade máxima]';

  if (typeof valor === 'string') return mascararTexto(valor);
  if (valor === null || typeof valor === 'number' || typeof valor === 'boolean') return valor;
  if (valor instanceof Date) return valor.toISOString();

  if (Array.isArray(valor)) {
    return valor.map((item) => sanitizarParaAuditoria(item, profundidade + 1));
  }

  if (typeof valor === 'object') {
    const saida: Record<string, unknown> = {};
    for (const [chave, item] of Object.entries(valor as Record<string, unknown>)) {
      saida[chave] = ehChaveSecreta(chave)
        ? '[removido]'
        : sanitizarParaAuditoria(item, profundidade + 1);
    }
    return saida;
  }

  // undefined, function, symbol: não têm representação útil em auditoria.
  return undefined;
}
