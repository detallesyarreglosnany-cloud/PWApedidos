-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE IF NOT EXISTS "DistDoc" (
    "kind" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "sellerId" TEXT,
    "routeDate" TEXT,
    "status" TEXT,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TEXT NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DistDoc_pkey" PRIMARY KEY ("kind","id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DistDoc_kind_syncedAt_idx" ON "DistDoc"("kind", "syncedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DistDoc_kind_sellerId_routeDate_idx" ON "DistDoc"("kind", "sellerId", "routeDate");

-- CreateTable
CREATE TABLE IF NOT EXISTS "DistCounter" (
    "name" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DistCounter_pkey" PRIMARY KEY ("name")
);

-- Supabase publica las tablas de "public" en su API REST: sin políticas, RLS
-- deja la tabla cerrada a esa API. La app entra como dueño y no le afecta.
ALTER TABLE "DistDoc" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DistCounter" ENABLE ROW LEVEL SECURITY;
