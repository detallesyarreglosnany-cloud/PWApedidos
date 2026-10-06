import { createHash } from 'crypto';
import { db } from '@/lib/db';

// Fotos de productos FUERA del catálogo que se sincroniza.
//
// Antes cada producto llevaba su foto (data URL de ~30 KB) dentro del documento:
// un cambio de precio en bloque hacía que cada teléfono volviera a bajar el
// catálogo completo con todas sus fotos. Ahora:
//   - la foto vive en DistDoc kind 'images' (id = id del producto)
//   - el producto solo lleva imageV (huella de la foto)
//   - el equipo la pide a GET /api/pedidos/img?id=…&v=… una sola vez por versión
//     y la guarda en su caché (service worker): funciona sin señal.
// Nunca se borra una foto: si cambia, se reemplaza; el respaldo la incluye.

type Doc = Record<string, unknown> & { id: string; updatedAt: string };

const isDataImage = (v: unknown): v is string => typeof v === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(v);
export const imageHash = (dataUrl: string) => createHash('sha1').update(dataUrl).digest('hex').slice(0, 12);

/**
 * Si el producto trae la foto adentro, la guarda aparte y la quita del documento.
 * Devuelve el documento a guardar y si cambió (para darle una versión nueva).
 */
export async function stashImage(doc: Doc): Promise<{ doc: Doc; changed: boolean }> {
  if (!('image' in doc)) return { doc, changed: false };
  const img = doc.image;
  const out: Doc = { ...doc };
  delete out.image;
  if (isDataImage(img)) {
    const v = imageHash(img);
    const now = new Date().toISOString();
    const have = await db.distDoc.findFirst({ where: { kind: 'images', id: doc.id, data: { contains: `"v":"${v}"` } }, select: { id: true } });
    if (!have) {
      const data = JSON.stringify({ id: doc.id, v, image: img, updatedAt: now });
      await db.distDoc.upsert({
        where: { kind_id: { kind: 'images', id: doc.id } },
        create: { kind: 'images', id: doc.id, data, updatedAt: now },
        update: { data, updatedAt: now, deleted: false },
      });
    }
    out.imageV = v;
  } else if (img === '' || img === null) {
    out.imageV = ''; // se quitó la foto
  } else if (typeof img === 'string' && img.includes('/api/pedidos/img')) {
    // Un equipo devolvió la dirección de la foto: se conserva la versión que tenía
  }
  return { doc: out, changed: true };
}

/** Productos guardados con la foto adentro (versión anterior): se migran por tandas. */
export async function productsWithInlineImage(limit: number) {
  return db.$queryRaw<{ id: string; data: string }[]>`
    SELECT "id", "data" FROM "DistDoc" WHERE "kind" = 'products' AND "data" LIKE '%"image":"data:%' LIMIT ${limit}`;
}
