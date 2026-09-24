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

-- CreateTable
CREATE TABLE IF NOT EXISTS "DistPush" (
    "endpoint" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "sellerId" TEXT,
    "data" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DistPush_pkey" PRIMARY KEY ("endpoint","role")
);
CREATE INDEX IF NOT EXISTS "DistPush_role_sellerId_idx" ON "DistPush"("role", "sellerId");

-- CreateTable
CREATE TABLE IF NOT EXISTS "DistSetting" (
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "DistSetting_pkey" PRIMARY KEY ("name")
);

-- Supabase publica las tablas de "public" en su API REST: sin políticas, RLS
-- deja la tabla cerrada a esa API. La app entra como dueño y no le afecta.
ALTER TABLE "DistDoc" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DistCounter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DistPush" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DistSetting" ENABLE ROW LEVEL SECURITY;
