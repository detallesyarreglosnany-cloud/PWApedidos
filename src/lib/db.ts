import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
// Con connection_limit=1 (Supabase + Vercel) las peticiones simultáneas hacen fila
// por la única conexión: la espera por defecto de Prisma (2 s) da error 500.
export const TX_WAIT = { maxWait: 15000, timeout: 20000 } as const;
