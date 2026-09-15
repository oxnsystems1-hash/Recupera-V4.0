/*
  Warnings:

  - You are about to drop the `logs_acesso_arquivo` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "TipoSolicitacaoLgpd" AS ENUM ('EXPORTACAO', 'CORRECAO', 'EXCLUSAO');

-- CreateEnum
CREATE TYPE "StatusSolicitacaoLgpd" AS ENUM ('PENDENTE', 'AGUARDANDO_CONFIRMACAO', 'BLOQUEADA', 'CONCLUIDA', 'REJEITADA');

-- DropForeignKey
ALTER TABLE "logs_acesso_arquivo" DROP CONSTRAINT "logs_acesso_arquivo_tenantId_fkey";

-- AlterTable
ALTER TABLE "arquivos" ADD COLUMN     "clienteId" TEXT;

-- AlterTable
ALTER TABLE "clientes" ADD COLUMN     "endereco" TEXT;

-- DropTable
DROP TABLE "logs_acesso_arquivo";

-- CreateTable
CREATE TABLE "logs_auditoria" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "userId" TEXT,
    "acao" TEXT NOT NULL,
    "entidade" TEXT NOT NULL,
    "entidadeId" TEXT,
    "detalhes" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "logs_auditoria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "solicitacoes_lgpd" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "tipo" "TipoSolicitacaoLgpd" NOT NULL,
    "status" "StatusSolicitacaoLgpd" NOT NULL DEFAULT 'PENDENTE',
    "solicitadoPorId" TEXT NOT NULL,
    "aprovadoPorId" TEXT,
    "aprovadoEm" TIMESTAMP(3),
    "prazoAtendimento" TIMESTAMP(3) NOT NULL,
    "correcaoProposta" JSONB,
    "tokenConfirmacaoHash" TEXT,
    "tokenConfirmacaoAteEm" TIMESTAMP(3),
    "motivoBloqueio" TEXT,
    "bloqueadoAteEm" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "solicitacoes_lgpd_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "logs_auditoria_tenantId_createdAt_idx" ON "logs_auditoria"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "logs_auditoria_entidade_entidadeId_idx" ON "logs_auditoria"("entidade", "entidadeId");

-- CreateIndex
CREATE UNIQUE INDEX "solicitacoes_lgpd_tokenConfirmacaoHash_key" ON "solicitacoes_lgpd"("tokenConfirmacaoHash");

-- CreateIndex
CREATE INDEX "solicitacoes_lgpd_tenantId_idx" ON "solicitacoes_lgpd"("tenantId");

-- CreateIndex
CREATE INDEX "solicitacoes_lgpd_clienteId_idx" ON "solicitacoes_lgpd"("clienteId");

-- CreateIndex
CREATE INDEX "solicitacoes_lgpd_status_bloqueadoAteEm_idx" ON "solicitacoes_lgpd"("status", "bloqueadoAteEm");

-- CreateIndex
CREATE INDEX "arquivos_clienteId_idx" ON "arquivos"("clienteId");

-- AddForeignKey
ALTER TABLE "arquivos" ADD CONSTRAINT "arquivos_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "clientes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logs_auditoria" ADD CONSTRAINT "logs_auditoria_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solicitacoes_lgpd" ADD CONSTRAINT "solicitacoes_lgpd_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solicitacoes_lgpd" ADD CONSTRAINT "solicitacoes_lgpd_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "clientes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Auditoria imutável com retenção mínima de 5 anos (Dia 5 / Prompt 2.2).
--
-- A garantia é do BANCO, não do código da aplicação: vale também para quem
-- chegar no Postgres por fora do backend (psql, script de manutenção, ORM
-- futuro). UPDATE é sempre recusado; DELETE só passa para linha com mais de
-- 5 anos, que é exatamente a política "retenção mínima de 5 anos,
-- independente da política do tenant".
--
-- TRUNCATE continua possível (não dispara trigger de linha) e é o caminho
-- deliberado para limpeza de ambiente de teste.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION logs_auditoria_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'logs_auditoria e append-only: UPDATE bloqueado';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD."createdAt" < now() - interval '5 years' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'logs_auditoria tem retencao minima de 5 anos: DELETE bloqueado';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER logs_auditoria_append_only_trigger
BEFORE UPDATE OR DELETE ON "logs_auditoria"
FOR EACH ROW EXECUTE FUNCTION logs_auditoria_append_only();
