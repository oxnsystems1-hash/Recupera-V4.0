/**
 * Validação real de MIME por conteúdo (assinatura de bytes), nunca por
 * extensão nem pelo Content-Type enviado pelo cliente — ambos são
 * forjáveis e é exatamente o vetor de ataque que o Prompt 2.1 do Dia 4
 * pede para bloquear ("validar MIME só pela extensão permite upload de
 * arquivo malicioso renomeado").
 */
interface Assinatura {
  mime: string;
  check: (buffer: Buffer) => boolean;
}

const ASSINATURAS: Assinatura[] = [
  {
    mime: 'image/jpeg',
    check: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: 'image/png',
    check: (b) =>
      b.length >= 8 &&
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    mime: 'image/webp',
    check: (b) =>
      b.length >= 12 &&
      b.subarray(0, 4).toString('ascii') === 'RIFF' &&
      b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
  {
    mime: 'application/pdf',
    check: (b) => b.length >= 5 && b.subarray(0, 5).toString('ascii') === '%PDF-',
  },
];

/** Único ponto de verdade dos tipos permitidos (Prompt 2.1). */
export const EXTENSAO_POR_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/** Retorna o MIME real detectado pelos bytes, ou null se nenhum tipo permitido bateu. */
export function detectMimeType(buffer: Buffer): string | null {
  const encontrada = ASSINATURAS.find((assinatura) => assinatura.check(buffer));
  return encontrada?.mime ?? null;
}
