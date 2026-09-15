import { Cliente, Prisma } from '@prisma/client';
import { prisma, prismaUnscoped } from '../../lib/prisma';
import { storage } from '../../lib/storage/localFilesystemStorage';
import { registrarAuditoria } from '../../lib/auditoria';

/**
 * Client aceito pelas funções que rodam tanto dentro de uma requisição
 * (escopado por tenant) quanto numa varredura de sistema (cru). Tipar pelo
 * client cru é o denominador comum: o escopado tem a mesma superfície,
 * apenas com o filtro de tenant injetado por baixo.
 */
type ClientePrisma = typeof prismaUnscoped;

/** Prazo legal de atendimento ao titular (Prompt 2.2: "em até 15 dias"). */
export const PRAZO_ATENDIMENTO_DIAS = 15;

export function prazoAtendimento(de: Date = new Date()): Date {
  return new Date(de.getTime() + PRAZO_ATENDIMENTO_DIAS * 24 * 60 * 60 * 1000);
}

/**
 * Pacote de portabilidade (Prompt 2.2): dados cadastrais, histórico e
 * *referências* de arquivo — nunca os bytes dos arquivos.
 *
 * Só enxerga o tenant do solicitante: a busca do cliente e de tudo que
 * pende dele passa pelo Prisma Client escopado.
 */
export async function montarExportacao(cliente: Cliente) {
  const [arquivos, solicitacoes, agendamentos, conversas] = await Promise.all([
    prisma.arquivo.findMany({
      where: { clienteId: cliente.id },
      select: {
        id: true,
        tipo: true,
        nomeOriginal: true,
        mimeType: true,
        tamanhoBytes: true,
        createdAt: true,
        retentionUntil: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.solicitacaoLgpd.findMany({
      where: { clienteId: cliente.id },
      select: { id: true, tipo: true, status: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.agendamento.findMany({
      where: { clienteId: cliente.id },
      select: {
        id: true,
        inicioEm: true,
        fimEm: true,
        status: true,
        observacao: true,
        profissional: { select: { nome: true } },
        servico: { select: { nome: true } },
      },
      orderBy: { inicioEm: 'asc' },
    }),
    prisma.conversa.findMany({
      where: { clienteId: cliente.id },
      select: {
        id: true,
        canal: true,
        createdAt: true,
        mensagens: {
          // Sugestão não decidida nunca foi comunicada ao titular: não faz
          // parte do histórico dele.
          where: { status: { in: ['RECEBIDA', 'ENVIADA'] } },
          select: { autor: true, conteudo: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  return {
    geradoEm: new Date().toISOString(),
    titular: {
      id: cliente.id,
      nome: cliente.nome,
      email: cliente.email,
      telefone: cliente.telefone,
      endereco: cliente.endereco,
      cadastradoEm: cliente.createdAt.toISOString(),
    },
    // Referências, não conteúdo: o titular recebe a lista do que existe e
    // pede o arquivo em si pelo canal autenticado, se quiser.
    arquivos,
    solicitacoesLgpd: solicitacoes,
    // Entidades criadas no Dia 6: o pacote do titular passou a incluí-las
    // de fato, como o Prompt 2.2 exige ("histórico de agendamento/conversas").
    agendamentos,
    conversas,
  };
}

/**
 * Obrigação legal que impede a exclusão agora (Prompt 2.2: "com obrigação
 * legal (fiscal/contratual) → bloquear e registrar motivo, excluir
 * automaticamente após vencer o prazo").
 *
 * A fonte da verdade é o bloqueio já modelado no Dia 4: arquivo com
 * `exclusaoBloqueada` guarda o motivo e a data em que o prazo vence.
 * Retorna null quando nada impede a exclusão imediata.
 */
export async function obrigacaoLegalPendente(
  clienteId: string,
  client: ClientePrisma = prismaUnscoped,
): Promise<{ motivo: string; ateEm: Date } | null> {
  const bloqueados = await client.arquivo.findMany({
    where: { clienteId, exclusaoBloqueada: true },
    select: { motivoBloqueioExclusao: true, retentionUntil: true },
    orderBy: { retentionUntil: 'desc' },
  });

  if (bloqueados.length === 0) return null;

  const maisLongo = bloqueados[0];
  const motivos = [
    ...new Set(bloqueados.map((a) => a.motivoBloqueioExclusao ?? 'prazo legal de retenção')),
  ];

  return {
    motivo: `Exclusão bloqueada por obrigação legal em ${bloqueados.length} arquivo(s): ${motivos.join('; ')}`,
    ateEm: maisLongo.retentionUntil,
  };
}

/**
 * Exclusão real do titular: bytes dos arquivos fora do storage, registros
 * fora do banco. Nada de soft delete cosmético — o cascade do schema leva
 * junto arquivos e solicitações do cliente.
 *
 * Roda com o client recebido: nas rotas é o escopado por tenant; na
 * varredura automática é o cru, porque não há requisição por trás.
 */
export async function executarExclusaoDoTitular(
  clienteId: string,
  client: ClientePrisma = prismaUnscoped,
): Promise<{ arquivosRemovidos: number; agendamentosRemovidos: number; conversasRemovidas: number }> {
  const arquivos = await client.arquivo.findMany({
    where: { clienteId },
    select: { id: true, storagePath: true },
  });

  let arquivosRemovidos = 0;
  for (const arquivo of arquivos) {
    try {
      await storage.delete(arquivo.storagePath);
      arquivosRemovidos += 1;
    } catch (error) {
      // Um arquivo problemático não pode impedir o resto da exclusão: o
      // direito do titular não espera o próximo deploy. A falha fica
      // registrada para conferência manual.
      console.error(`Falha ao remover bytes do arquivo ${arquivo.id} na exclusão LGPD:`, error);
      await registrarAuditoria({
        acao: 'LGPD_EXCLUSAO_EXECUTADA',
        entidade: 'Arquivo',
        entidadeId: arquivo.id,
        detalhes: { falhaAoRemoverBytes: true },
      });
    }
  }

  // Agendamentos e conversas do titular saem junto (cascade no schema), mas
  // as mensagens dependem da conversa — o cascade de Conversa→Mensagem
  // resolve. O count aqui é só para a trilha de auditoria saber o tamanho do
  // que foi apagado.
  const [agendamentosRemovidos, conversasRemovidas] = await Promise.all([
    client.agendamento.count({ where: { clienteId } }),
    client.conversa.count({ where: { clienteId } }),
  ]);

  // Os registros de arquivo saem explicitamente: a relação com Cliente é
  // SetNull (um arquivo pode existir sem titular), então apagar o cliente
  // deixaria linhas órfãs — com nome original, datas e ponteiro para bytes
  // que não existem mais. Exclusão real é apagar o metadado também.
  await client.arquivo.deleteMany({ where: { clienteId } });

  // SolicitacaoLgpd cai por cascade junto com o cliente (ver schema).
  await client.cliente.delete({ where: { id: clienteId } });

  return { arquivosRemovidos, agendamentosRemovidos, conversasRemovidas };
}

/** Campos cadastrais que o titular pode corrigir — e só eles (Prompt 2.2). */
export const CAMPOS_CORRIGIVEIS = ['nome', 'email', 'telefone', 'endereco'] as const;
export type CampoCorrigivel = (typeof CAMPOS_CORRIGIVEIS)[number];

export function apenasCamposCorrigiveis(
  entrada: Record<string, unknown>,
): Partial<Record<CampoCorrigivel, string>> {
  const saida: Partial<Record<CampoCorrigivel, string>> = {};
  for (const campo of CAMPOS_CORRIGIVEIS) {
    const valor = entrada[campo];
    if (typeof valor === 'string' && valor.trim().length > 0) {
      saida[campo] = valor.trim();
    }
  }
  return saida;
}

export type CorrecaoProposta = Prisma.JsonObject;
