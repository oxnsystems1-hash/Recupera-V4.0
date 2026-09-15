/**
 * Grau de sensibilidade resolvido automaticamente pelo campo `segmento` do
 * tenant (Dia 4 / Prompt 2.1: "campo segmento decide automaticamente o
 * grau de sensibilidade — nunca decisão manual caso a caso"). Mapa fechado
 * com os 8 segmentos-alvo da Referência Rápida 1 do Guia Mestre; um
 * segmento fora desta lista cai em 'reforcada' — mais seguro errar para o
 * lado de mais proteção do que menos.
 */
export type Sensibilidade = 'padrao' | 'reforcada';

const SEGMENTO_SENSIBILIDADE: Record<string, Sensibilidade> = {
  clinicas_saude_odonto_estetica: 'reforcada', // Alta — dado de saúde
  saloes_estudios_estetica: 'padrao',
  academias_personal_trainers: 'padrao',
  advocacia_contabilidade: 'reforcada', // Alta — sigilo profissional
  imobiliarias_corretores: 'padrao',
  autoescolas: 'padrao',
  pet_shops_veterinarias: 'reforcada', // Moderada — tratada como reforçada
  consultorias_financeira_rh_negocios: 'reforcada', // Alta — dado financeiro
};

export function getSensibilidade(segmento: string): Sensibilidade {
  return SEGMENTO_SENSIBILIDADE[segmento] ?? 'reforcada';
}

const RETENCAO_PADRAO_DIAS: Record<Sensibilidade, number> = { padrao: 365, reforcada: 1825 };
/** Piso mínimo: o tenant pode configurar mais, nunca menos. */
const RETENCAO_MINIMA_DIAS: Record<Sensibilidade, number> = { padrao: 30, reforcada: 1825 };
/** Nunca acima do teto absoluto de 15min do Prompt 2.1 (signedUrl.ts). */
const TTL_MAXIMO_SEGUNDOS: Record<Sensibilidade, number> = { padrao: 900, reforcada: 300 };

export function resolverRetencaoDias(tenant: {
  segmento: string;
  retencaoArquivosDias: number | null;
}): number {
  const sensibilidade = getSensibilidade(tenant.segmento);
  const configurado = tenant.retencaoArquivosDias ?? RETENCAO_PADRAO_DIAS[sensibilidade];
  return Math.max(configurado, RETENCAO_MINIMA_DIAS[sensibilidade]);
}

export function resolverTtlMaximoSegundos(tenant: { segmento: string }): number {
  return TTL_MAXIMO_SEGUNDOS[getSensibilidade(tenant.segmento)];
}
