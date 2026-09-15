import { describe, expect, it } from 'vitest';
import {
  getSensibilidade,
  resolverRetencaoDias,
  resolverTtlMaximoSegundos,
} from '../src/config/segmentos';

describe('config/segmentos — sensibilidade decidida pelo campo segmento (Dia 4)', () => {
  it('classifica os 8 segmentos-alvo da Referência Rápida 1 corretamente', () => {
    expect(getSensibilidade('clinicas_saude_odonto_estetica')).toBe('reforcada');
    expect(getSensibilidade('advocacia_contabilidade')).toBe('reforcada');
    expect(getSensibilidade('pet_shops_veterinarias')).toBe('reforcada');
    expect(getSensibilidade('consultorias_financeira_rh_negocios')).toBe('reforcada');

    expect(getSensibilidade('saloes_estudios_estetica')).toBe('padrao');
    expect(getSensibilidade('academias_personal_trainers')).toBe('padrao');
    expect(getSensibilidade('imobiliarias_corretores')).toBe('padrao');
    expect(getSensibilidade('autoescolas')).toBe('padrao');
  });

  it('segmento desconhecido recebe o tratamento mais protegido (reforcada), nunca padrão por omissão', () => {
    expect(getSensibilidade('segmento-que-nao-existe')).toBe('reforcada');
  });

  it('retenção: usa o valor configurado no tenant quando acima do piso do segmento', () => {
    const dias = resolverRetencaoDias({
      segmento: 'saloes_estudios_estetica',
      retencaoArquivosDias: 500,
    });
    expect(dias).toBe(500);
  });

  it('retenção: nunca abaixo do piso do segmento, mesmo que o tenant configure menos', () => {
    const dias = resolverRetencaoDias({
      segmento: 'clinicas_saude_odonto_estetica', // piso: 1825 dias (reforçada)
      retencaoArquivosDias: 10,
    });
    expect(dias).toBe(1825);
  });

  it('retenção: sem configuração do tenant, usa o padrão do segmento', () => {
    expect(
      resolverRetencaoDias({ segmento: 'autoescolas', retencaoArquivosDias: null }),
    ).toBe(365);
    expect(
      resolverRetencaoDias({ segmento: 'advocacia_contabilidade', retencaoArquivosDias: null }),
    ).toBe(1825);
  });

  it('TTL máximo de URL assinada é mais curto para segmentos reforçados, nunca acima de 15min', () => {
    expect(resolverTtlMaximoSegundos({ segmento: 'saloes_estudios_estetica' })).toBe(900);
    expect(resolverTtlMaximoSegundos({ segmento: 'clinicas_saude_odonto_estetica' })).toBe(300);
    expect(resolverTtlMaximoSegundos({ segmento: 'clinicas_saude_odonto_estetica' })).toBeLessThanOrEqual(
      900,
    );
  });
});
