-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "retencaoArquivosDias" INTEGER;

-- CreateTable
CREATE TABLE "arquivos" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "nomeOriginal" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "tamanhoBytes" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "retentionUntil" TIMESTAMP(3) NOT NULL,
    "exclusaoBloqueada" BOOLEAN NOT NULL DEFAULT false,
    "motivoBloqueioExclusao" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "arquivos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "logs_acesso_arquivo" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "arquivoId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "logs_acesso_arquivo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "arquivos_storagePath_key" ON "arquivos"("storagePath");

-- CreateIndex
CREATE INDEX "arquivos_tenantId_idx" ON "arquivos"("tenantId");

-- CreateIndex
CREATE INDEX "logs_acesso_arquivo_tenantId_idx" ON "logs_acesso_arquivo"("tenantId");

-- CreateIndex
CREATE INDEX "logs_acesso_arquivo_arquivoId_idx" ON "logs_acesso_arquivo"("arquivoId");

-- AddForeignKey
ALTER TABLE "arquivos" ADD CONSTRAINT "arquivos_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logs_acesso_arquivo" ADD CONSTRAINT "logs_acesso_arquivo_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
