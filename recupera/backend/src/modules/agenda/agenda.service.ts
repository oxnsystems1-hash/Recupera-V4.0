import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';

/**
 * Conflito de horário do MESMO profissional. Não é uma checagem de
 * aplicação: a restrição `agendamentos_sem_sobreposicao` (EXCLUDE USING
 * gist, ver migration) recusa a sobreposição dentro da própria transação.
 * Entre um SELECT "está livre" e o INSERT cabe outra requisição — só o
 * banco consegue decidir isso sem corrida.
 */
/**
 * O Prisma não mapeia violação de EXCLUDE (SQLSTATE 23P01) nem de CHECK
 * (23514) para um código próprio: os dois chegam como
 * `PrismaClientUnknownRequestError`, com o erro do Postgres embutido na
 * mensagem. Por isso a identificação é pelo NOME da restrição, que é nosso
 * e está fixado na migration — não pela classe do erro nem só pelo SQLSTATE.
 */
function violou(error: unknown, restricao: string): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) &&
    !(error instanceof Prisma.PrismaClientUnknownRequestError)
  ) {
    return false;
  }
  return String(error.message).includes(restricao);
}

export function ehConflitoDeHorario(error: unknown): boolean {
  return violou(error, 'agendamentos_sem_sobreposicao');
}

export function ehIntervaloInvalido(error: unknown): boolean {
  return violou(error, 'agendamentos_intervalo_valido');
}

/**
 * Campos devolvidos em LISTAGEM (agenda e dashboard) — nunca o objeto
 * Prisma cru.
 *
 * `observacao` e `motivoCancelamento` ficam de fora de propósito: são texto
 * livre, e num tenant de segmento sensível (saúde, jurídico) é exatamente
 * ali que acaba escrito o que não deveria trafegar em lote. A tela de lista
 * não mostra nenhum dos dois, então mandá-los para o navegador de todo
 * papel autenticado seria expor dado sem finalidade — minimização (LGPD
 * art. 6º, III). Quem precisa do detalhe usa a resposta do próprio
 * create/update, que devolve o registro completo a quem acabou de escrevê-lo.
 */
export const SELECAO_AGENDAMENTO = {
  id: true,
  inicioEm: true,
  fimEm: true,
  status: true,
  cliente: { select: { id: true, nome: true } },
  profissional: { select: { id: true, nome: true } },
  servico: { select: { id: true, nome: true, categoria: true, duracaoMinutos: true } },
} satisfies Prisma.AgendamentoSelect;

/** Detalhe de um único agendamento, devolvido a quem acabou de escrevê-lo. */
export const SELECAO_AGENDAMENTO_DETALHE = {
  ...SELECAO_AGENDAMENTO,
  observacao: true,
  motivoCancelamento: true,
} satisfies Prisma.AgendamentoSelect;

/**
 * Disponibilidade de um profissional num dia: devolve os intervalos já
 * ocupados, para a tela montar as faixas livres. Só o que a tela precisa —
 * nada de dado de cliente aqui, porque a grade de horário não precisa saber
 * de quem é o agendamento para desenhar "ocupado".
 */
export async function ocupacaoDoProfissional(
  profissionalId: string,
  de: Date,
  ate: Date,
): Promise<Array<{ inicioEm: Date; fimEm: Date }>> {
  return prisma.agendamento.findMany({
    where: {
      profissionalId,
      status: { not: 'CANCELADO' },
      inicioEm: { lt: ate },
      fimEm: { gt: de },
    },
    select: { inicioEm: true, fimEm: true },
    orderBy: { inicioEm: 'asc' },
  });
}
