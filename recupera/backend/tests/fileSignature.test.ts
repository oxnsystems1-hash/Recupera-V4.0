import { describe, expect, it } from 'vitest';
import { detectMimeType, EXTENSAO_POR_MIME } from '../src/lib/fileSignature';

describe('detectMimeType — validação real de MIME por bytes', () => {
  it('reconhece JPEG, PNG, WEBP e PDF pelos números mágicos', () => {
    expect(detectMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(
      detectMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])),
    ).toBe('image/png');
    expect(
      detectMimeType(
        Buffer.concat([
          Buffer.from('RIFF'),
          Buffer.from([0, 0, 0, 0]),
          Buffer.from('WEBP'),
        ]),
      ),
    ).toBe('image/webp');
    expect(detectMimeType(Buffer.from('%PDF-1.7 resto do arquivo'))).toBe('application/pdf');
  });

  it('rejeita conteúdo que não bate com nenhuma assinatura permitida, mesmo com extensão de imagem', () => {
    expect(detectMimeType(Buffer.from('isto nao e uma imagem de verdade'))).toBeNull();
  });

  it('rejeita um executável renomeado para .png (assinatura MZ do Windows PE)', () => {
    expect(detectMimeType(Buffer.from([0x4d, 0x5a, 0x90, 0x00]))).toBeNull();
  });

  it('toda entrada de EXTENSAO_POR_MIME cobre um dos 4 tipos permitidos pelo Prompt 2.1', () => {
    expect(Object.keys(EXTENSAO_POR_MIME).sort()).toEqual(
      ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].sort(),
    );
  });
});
