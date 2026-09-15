/**
 * Validação de entrada mínima e explícita, na borda do sistema. Existe para
 * que dado malformado vire 400 com mensagem clara em vez de escorrer até o
 * Prisma e voltar como 500 genérico — e para impor teto de tamanho em todo
 * campo de texto, já que o limite de corpo da requisição sozinho ainda
 * deixaria passar um único campo enorme.
 */
const MAX_TEXTO_CURTO = 200;

export function textoObrigatorio(valor: unknown, max: number = MAX_TEXTO_CURTO): string | null {
  if (typeof valor !== 'string') return null;
  const limpo = valor.trim();
  if (limpo.length === 0 || limpo.length > max) return null;
  return limpo;
}

/**
 * Checagem de formato de e-mail deliberadamente simples: valida a forma
 * (um @, algo antes, domínio com ponto depois) sem tentar reimplementar a
 * RFC 5322. Confirmação real de e-mail é por token, não por regex.
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function emailValido(valor: unknown): string | null {
  const texto = textoObrigatorio(valor, 254);
  if (!texto || !EMAIL_REGEX.test(texto)) return null;
  return texto.toLowerCase();
}
