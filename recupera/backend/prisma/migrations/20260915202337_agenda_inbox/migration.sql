-- CreateEnum
CREATE TYPE "StatusAgendamento" AS ENUM ('AGENDADO', 'CONFIRMADO', 'CONCLUIDO', 'CANCELADO');

-- CreateEnum
CREATE TYPE "CanalConversa" AS ENUM ('WHATSAPP', 'MANUAL');

-- CreateEnum
CREATE TYPE "AutorMensagem" AS ENUM ('CLIENTE', 'ATENDENTE', 'AGENTE_IA');

-- CreateEnum
CREATE TYPE "StatusMensagem" AS ENUM ('RECEBIDA', 'ENVIADA', 'SUGERIDA', 'DESCARTADA');

-- CreateTable
CREATE TABLE "profissionais" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profissionais_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "servicos" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "categoria" TEXT NOT NULL,
    "duracaoMinutos" INTEGER NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "servicos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agendamentos" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "profissionalId" TEXT NOT NULL,
    "servicoId" TEXT NOT NULL,
    "inicioEm" TIMESTAMP(3) NOT NULL,
    "fimEm" TIMESTAMP(3) NOT NULL,
    "status" "StatusAgendamento" NOT NULL DEFAULT 'AGENDADO',
    "observacao" TEXT,
    "motivoCancelamento" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agendamentos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversas" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "canal" "CanalConversa" NOT NULL DEFAULT 'WHATSAPP',
    "naoLidas" INTEGER NOT NULL DEFAULT 0,
    "ultimaMensagemEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mensagens" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversaId" TEXT NOT NULL,
    "autor" "AutorMensagem" NOT NULL,
    "conteudo" TEXT NOT NULL,
    "status" "StatusMensagem" NOT NULL,
    "enviadaPorId" TEXT,
    "enviadaEm" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mensagens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "profissionais_tenantId_idx" ON "profissionais"("tenantId");

-- CreateIndex
CREATE INDEX "servicos_tenantId_idx" ON "servicos"("tenantId");

-- CreateIndex
CREATE INDEX "agendamentos_tenantId_inicioEm_idx" ON "agendamentos"("tenantId", "inicioEm");

-- CreateIndex
CREATE INDEX "agendamentos_clienteId_idx" ON "agendamentos"("clienteId");

-- CreateIndex
CREATE INDEX "agendamentos_profissionalId_inicioEm_idx" ON "agendamentos"("profissionalId", "inicioEm");

-- CreateIndex
CREATE INDEX "conversas_tenantId_ultimaMensagemEm_idx" ON "conversas"("tenantId", "ultimaMensagemEm");

-- CreateIndex
CREATE INDEX "conversas_clienteId_idx" ON "conversas"("clienteId");

-- CreateIndex
CREATE INDEX "mensagens_tenantId_idx" ON "mensagens"("tenantId");

-- CreateIndex
CREATE INDEX "mensagens_conversaId_createdAt_idx" ON "mensagens"("conversaId", "createdAt");

-- AddForeignKey
ALTER TABLE "profissionais" ADD CONSTRAINT "profissionais_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "servicos" ADD CONSTRAINT "servicos_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agendamentos" ADD CONSTRAINT "agendamentos_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agendamentos" ADD CONSTRAINT "agendamentos_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "clientes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agendamentos" ADD CONSTRAINT "agendamentos_profissionalId_fkey" FOREIGN KEY ("profissionalId") REFERENCES "profissionais"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agendamentos" ADD CONSTRAINT "agendamentos_servicoId_fkey" FOREIGN KEY ("servicoId") REFERENCES "servicos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversas" ADD CONSTRAINT "conversas_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversas" ADD CONSTRAINT "conversas_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "clientes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mensagens" ADD CONSTRAINT "mensagens_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mensagens" ADD CONSTRAINT "mensagens_conversaId_fkey" FOREIGN KEY ("conversaId") REFERENCES "conversas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Double-booking é uma corrida, e corrida não se resolve com checagem na
-- aplicação: entre o SELECT que diz "horário livre" e o INSERT, outra
-- requisição cabe. A garantia precisa ser do banco.
--
-- A restrição abaixo recusa, no nível da transação, qualquer agendamento que
-- se sobreponha no tempo para o MESMO profissional. Agendamento cancelado
-- fica de fora (o horário volta a ficar livre).
--
-- btree_gist é necessário porque a restrição combina igualdade (profissional)
-- com sobreposição de intervalo (tsrange — o tipo da coluna é timestamp sem fuso).
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "agendamentos"
  ADD CONSTRAINT "agendamentos_sem_sobreposicao"
  EXCLUDE USING gist (
    "profissionalId" WITH =,
    tsrange("inicioEm", "fimEm", '[)') WITH &&
  ) WHERE (status <> 'CANCELADO');

-- Sanidade de intervalo: fim sempre depois do início.
ALTER TABLE "agendamentos"
  ADD CONSTRAINT "agendamentos_intervalo_valido" CHECK ("fimEm" > "inicioEm");
