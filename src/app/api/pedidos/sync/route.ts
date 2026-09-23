import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { db } from '@/lib/db';

// Sincronización de la PWA de pedidos (public/pedidos).
//
// POST /api/pedidos/sync
//   headers: x-sync-key  (obligatoria si PEDIDOS_SYNC_KEY está definida)
//            x-admin-key (oficina: permite escribir catálogo y vendedores)
//   body:    { deviceId, since, sinceDays, sellerId, push: { <kind>: docs[] } }
//   kinds:   orders, clients, products, sellers, loads, config
//   resp:    { serverTime, accepted: {kind: ids[]}, rejected: [{kind,id,reason,doc}], pull: {kind: docs[]} }
//
// Reglas (espejo de public/pedidos/js/sync.js):
//   - Last-write-wins por updatedAt del documento.
//   - products/sellers/loads/config solo se escriben con clave admin.
//   - Un pedido bloqueado (su hoja pasó a un estado bloqueado: aprobada para
//     carga, cerrada, despachada…) no puede ser modificado por un vendedor.
//     Mientras la hoja esté en un estado editable, vendedor y oficina editan.
//   - Un teléfono (sellerId) solo baja sus pedidos y su cartera de clientes.

export const dynamic = 'force-dynamic';

const SYNC_KEY = process.env.PEDIDOS_SYNC_KEY || '';
const ADMIN_KEY = process.env.PEDIDOS_ADMIN_KEY || '';
const KINDS = ['orders', 'clients', 'products', 'sellers', 'loads', 'config'] as const;
const ADMIN_KINDS: readonly string[] = ['products', 'sellers', 'loads', 'config'];

type Kind = (typeof KINDS)[number];
// Campos de un pedido que controla la oficina: un teléfono nunca los pisa
// (aunque su copia local esté atrasada y no sepa que el pedido ya está en una hoja).
const OFFICE_ORDER_FIELDS = ['loadId', 'locked', 'loadStatusName', 'noteNumber', 'loadNumber', 'dispatchedAt', 'officeEdited', 'heldAt'];
const OFFICE_ORDER_STATUS: readonly string[] = ['en_carga', 'en_espera', 'despachado'];
const MAX_BODY_BYTES = 15 * 1024 * 1024; // primera publicación: catálogo con fotos + cartera
const MAX_DOCS_PER_KIND = 5000;
const MAX_DOC_BYTES = 256 * 1024; // productos con foto comprimida

type Doc = Record<string, unknown> & { id: string; updatedAt: string; deleted?: boolean };

function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function isDoc(d: unknown): d is Doc {
  if (!d || typeof d !== 'object') return false;
  const o = d as Record<string, unknown>;
  return typeof o.id === 'string' && o.id.length > 0 && o.id.length <= 120 &&
    typeof o.updatedAt === 'string' && !Number.isNaN(Date.parse(o.updatedAt));
}

function parseDoc(data: string): Doc {
  return JSON.parse(data) as Doc;
}

function daysAgo(n: number) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10);
}

export async function GET() {
  return NextResponse.json({ ok: true, service: 'pedidos-sync', time: new Date().toISOString() });
}

export async function POST(req: NextRequest) {
  const serverTime = new Date();

  if (SYNC_KEY && !safeEqual(req.headers.get('x-sync-key') || '', SYNC_KEY)) {
    return NextResponse.json({ error: 'Clave de sincronización inválida' }, { status: 401 });
  }
  const adminHeader = req.headers.get('x-admin-key');
  const isAdmin = !!ADMIN_KEY && !!adminHeader && safeEqual(adminHeader, ADMIN_KEY);
  if (adminHeader && !isAdmin) {
    return NextResponse.json({ error: 'Clave admin inválida' }, { status: 401 });
  }

  const len = Number(req.headers.get('content-length') || 0);
  if (len > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Paquete demasiado grande' }, { status: 413 });
  }

  let body: {
    since?: string | null;
    sinceDays?: number | null;
    sellerId?: string | null;
    push?: Partial<Record<Kind, unknown[]>>;
    noPull?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const accepted = Object.fromEntries(KINDS.map((k) => [k, [] as string[]])) as Record<Kind, string[]>;
  const rejected: { kind: Kind; id: string; reason: string; doc?: Doc }[] = [];
  const maxTs = new Date(serverTime.getTime() + 60_000).toISOString();

  try {
    for (const kind of KINDS) {
      const incoming = Array.isArray(body.push?.[kind]) ? body.push![kind]! : [];
      if (!incoming.length) continue;
      if (incoming.length > MAX_DOCS_PER_KIND) {
        return NextResponse.json({ error: `Demasiados documentos en ${kind}` }, { status: 413 });
      }
      if (ADMIN_KINDS.includes(kind) && !isAdmin) {
        // Un teléfono nunca publica catálogo ni cargas: se ignora sin error.
        continue;
      }

      await db.$transaction(async (tx) => {
        for (const raw of incoming) {
          if (!isDoc(raw)) continue;
          const doc: Doc = { ...raw };
          delete (doc as Record<string, unknown>).dirty;
          // Un reloj de teléfono adelantado no puede "ganar" para siempre.
          if (doc.updatedAt > maxTs) doc.updatedAt = serverTime.toISOString();
          if (JSON.stringify(doc).length > MAX_DOC_BYTES) {
            rejected.push({ kind, id: doc.id, reason: 'too_large' });
            continue;
          }

          const existing = await tx.distDoc.findUnique({ where: { kind_id: { kind, id: doc.id } } });
          if (existing) {
            if (kind === 'orders' && !isAdmin) {
              const cur = parseDoc(existing.data);
              if (cur.locked === true || existing.status === 'despachado') {
                rejected.push({ kind, id: doc.id, reason: 'locked', doc: cur });
                continue;
              }
            }
            if (kind === 'orders' && !isAdmin) {
              const cur = parseDoc(existing.data) as Record<string, unknown>;
              const d = doc as Record<string, unknown>;
              let changed = false;
              for (const f of OFFICE_ORDER_FIELDS) {
                if (cur[f] !== undefined && d[f] !== cur[f]) { d[f] = cur[f]; changed = true; }
              }
              if (OFFICE_ORDER_STATUS.includes(String(cur.status)) && d.status !== cur.status) { d.status = cur.status; changed = true; }
              // La oficina ve que el vendedor tocó un pedido que ya estaba en una hoja
              if (cur.loadId && JSON.stringify(d.lines) !== JSON.stringify(cur.lines)) d.sellerEdited = serverTime.toISOString();
              // Nueva versión con hora del servidor para que el teléfono la vuelva a bajar corregida
              if (changed && existing.updatedAt <= doc.updatedAt) doc.updatedAt = serverTime.toISOString();
            }
            if (existing.updatedAt > doc.updatedAt) {
              rejected.push({ kind, id: doc.id, reason: 'stale', doc: parseDoc(existing.data) });
              continue;
            }
            if (existing.updatedAt === doc.updatedAt) {
              accepted[kind].push(doc.id); // reintento idempotente
              continue;
            }
          }

          // Alerta de cliente duplicado el mismo día (mismo u otro vendedor): no bloquea
          if (kind === 'orders' && doc.routeDate) {
            const key = (o: Record<string, unknown>) => String(o.clientId || o.clientKey || '');
            const d = doc as Record<string, unknown>;
            const same = (await tx.distDoc.findMany({ where: { kind: 'orders', routeDate: String(doc.routeDate), deleted: false } }))
              .filter((r) => r.id !== doc.id).map((r) => ({ row: r, o: parseDoc(r.data) as Record<string, unknown> }))
              .filter(({ o }) => !o.deleted && key(o) && (key(o) === key(d) || (o.clientKey && o.clientKey === d.clientKey)));
            const dup = doc.deleted ? [] : same.map(({ o }) => ({ id: String(o.id), sellerName: String(o.sellerName || '') }));
            if (JSON.stringify(dup) !== JSON.stringify(d.dupWith || [])) {
              d.dupWith = dup;
              if (!isAdmin || existing) doc.updatedAt = serverTime.toISOString(); // que el teléfono baje la alerta
            }
            // Marcar también los otros pedidos del mismo cliente
            for (const { row, o } of same) {
              const list = ((o.dupWith as { id: string }[]) || []).filter((x) => x.id !== doc.id);
              if (!doc.deleted) list.push({ id: doc.id, sellerName: String(d.sellerName || '') } as { id: string });
              if (JSON.stringify(list) !== JSON.stringify(o.dupWith || [])) {
                const upd = { ...o, dupWith: list, updatedAt: serverTime.toISOString() };
                await tx.distDoc.update({ where: { kind_id: { kind: 'orders', id: row.id } }, data: { data: JSON.stringify(upd), updatedAt: upd.updatedAt } });
              }
            }
          }
          const data = JSON.stringify(doc);
          const cols = {
            data,
            deleted: !!doc.deleted,
            updatedAt: doc.updatedAt,
            sellerId: kind === 'orders' || kind === 'clients' || kind === 'loads' ? String(doc.sellerId || '') : null,
            routeDate: kind === 'orders' ? String(doc.routeDate || '') : null,
            status: kind === 'orders' ? String(doc.status || '') : null,
          };
          await tx.distDoc.upsert({
            where: { kind_id: { kind, id: doc.id } },
            create: { kind, id: doc.id, ...cols },
            update: cols,
          });
          accepted[kind].push(doc.id);
        }
      });
    }

    // Tandas intermedias de una subida grande: la bajada va en la última
    if (body.noPull) return NextResponse.json({ serverTime: serverTime.toISOString(), accepted, rejected, pull: {} });

    // ---- Bajada ----
    const since = body.since && !Number.isNaN(Date.parse(body.since)) ? new Date(body.since) : null;
    const syncedAt = since ? { gte: since } : undefined;
    const sellerId = typeof body.sellerId === 'string' && body.sellerId ? body.sellerId : null;
    const sinceDays = !since && typeof body.sinceDays === 'number' && body.sinceDays > 0
      ? Math.min(body.sinceDays, 365) : null;

    const bySeller = sellerId ? { sellerId } : {};
    const [products, sellers, config, clients, loads, orders] = await Promise.all([
      db.distDoc.findMany({ where: { kind: 'products', syncedAt } }),
      db.distDoc.findMany({ where: { kind: 'sellers', syncedAt } }),
      db.distDoc.findMany({ where: { kind: 'config', syncedAt } }),
      db.distDoc.findMany({ where: { kind: 'clients', syncedAt, ...bySeller } }),
      // Las hojas de carga solo interesan a la oficina
      sellerId ? Promise.resolve([]) : db.distDoc.findMany({ where: { kind: 'loads', syncedAt } }),
      db.distDoc.findMany({
        where: {
          kind: 'orders',
          syncedAt,
          ...(sellerId ? { sellerId } : {}),
          ...(sinceDays ? { routeDate: { gte: daysAgo(sinceDays) } } : {}),
        },
      }),
    ]);

    return NextResponse.json({
      serverTime: serverTime.toISOString(),
      accepted,
      rejected,
      pull: {
        products: products.map((d) => parseDoc(d.data)),
        sellers: sellers.map((d) => parseDoc(d.data)),
        config: config.map((d) => parseDoc(d.data)),
        clients: clients.map((d) => parseDoc(d.data)),
        loads: loads.map((d) => parseDoc(d.data)),
        orders: orders.map((d) => parseDoc(d.data)),
      },
    });
  } catch (error) {
    console.error('[pedidos/sync]', error);
    return NextResponse.json({ error: 'Error interno de sincronización' }, { status: 500 });
  }
}
