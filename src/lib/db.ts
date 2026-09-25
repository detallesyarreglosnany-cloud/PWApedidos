import { PrismaClient } from '@prisma/client'

// El pooler de Supabase (puerto 6543, modo transacción) no admite las sentencias
// preparadas con nombre de Prisma: sin pgbouncer=true falla al azar con
// "prepared statement already exists". Se agrega aunque falte en la variable.
export function poolerSafeUrl(url: string | undefined) {
  if (!url || !/:6543(\/|\?|$)/.test(url) || /[?&]pgbouncer=true/.test(url)) return url
  return url + (url.includes('?') ? '&' : '?') + 'pgbouncer=true'
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

const url = poolerSafeUrl(process.env.DATABASE_URL)

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error'],
    ...(url ? { datasources: { db: { url } } } : {}),
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
// Con connection_limit=1 (Supabase + Vercel) las peticiones simultáneas hacen fila
// por la única conexión: la espera por defecto de Prisma (2 s) da error 500.
export const TX_WAIT = { maxWait: 15000, timeout: 20000 } as const;
