// Crea o actualiza las tablas (DistDoc, DistCounter) antes de compilar.
// En producción es obligatorio: si falla, el despliegue falla y sigue en línea
// la versión anterior. Las vistas previas de Vercel no tienen la base de datos
// configurada (las variables son solo de producción): ahí se omite.
import { execSync } from 'node:child_process';

if (process.env.VERCEL_ENV === 'preview' || process.env.VERCEL_ENV === 'development') {
  console.log(`[db-push] Omitido en ${process.env.VERCEL_ENV}: la base de datos es solo de producción.`);
  process.exit(0);
}
if (!process.env.DATABASE_URL) {
  if (process.env.VERCEL) {
    console.error('[db-push] Falta DATABASE_URL en producción.');
    process.exit(1);
  }
  console.log('[db-push] Sin DATABASE_URL: se omite (compilación local).');
  process.exit(0);
}
execSync('prisma db push --skip-generate', { stdio: 'inherit' });
