import { db } from '@/lib/db';

// "Época" de los datos: cambia cada vez que la oficina reinicia los datos
// (Ajustes → Reiniciar datos). Un equipo con otra época no escribe nada: primero
// borra su copia local y baja todo de nuevo. '' = nunca se reinició.

/** Candado de Postgres: el reinicio lo toma exclusivo y cada escritura de sync compartido. */
export const RESET_LOCK = 72450101;

export async function currentEpoch() {
  const row = await db.distSetting.findUnique({ where: { name: 'epoch' } });
  return row ? row.value : '';
}

/** Hora del último reinicio: lo que un equipo hizo DESPUÉS (sin señal) se conserva. */
export async function epochAt() {
  const row = await db.distSetting.findUnique({ where: { name: 'epochAt' } });
  return row ? row.value : '';
}
