import { NextRequest, NextResponse, after } from 'next/server';
import { Prisma } from '@prisma/client';
import { db, TX_WAIT } from '@/lib/db';
import { isAdminReq, isSupervisorReq, syncOk } from '@/lib/keys';
import { sendPush, type PushMsg } from '@/lib/push';
import { RESET_LOCK, currentEpoch, epochAt } from '@/lib/epoch';

// Sincronización de la PWA de pedidos (public/pedidos).
//
// POST /api/pedidos/sync
//   headers: x-sync-key  (obligatoria si PEDIDOS_SYNC_KEY está definida)
//            x-admin-key (oficina: permite escribir catálogo y vendedores)
//   body:    { deviceId, since, sinceDays, sellerId, noPull, push: { <kind>: docs[] } }
//   kinds:   orders, clients, products, sellers, loads, config, events
//   resp:    { serverTime, accepted: {kind: ids[]}, rejected: [{kind,id,reason,doc}], pull: {kind: docs[]}, more, page, dups }
//   La bajada va por páginas de ~3 MB (Vercel corta en 4,5 MB): si `more` es
//   true, el equipo repite la petición con `page` hasta terminar.
//
// Reglas (espejo de public/pedidos/js/sync.js):
//   - Last-write-wins por updatedAt del documento, garantizado en la propia
//     escritura (ON CONFLICT … WHERE), no solo en la lectura previa.
//   - products/sellers/loads/config solo se escriben con clave admin.
//   - Un teléfono solo escribe pedidos y clientes de SU vendedor y nunca los
//     reasigna a otro vendedor. Baja también las hojas de carga donde están
//     sus clientes, para seguir su despacho.
//   - Un pedido bloqueado (hoja aprobada, cerrada, despachada…) no lo modifica
//     un vendedor. Los campos de la oficina nunca los pisa un teléfono.
//   - events (historial de actividad) solo se agregan: nunca se editan ni se
//     borran. Solo la oficina los baja.
//   - Un cliente reasignado guarda sus vendedores anteriores (formerSellerIds):
//     así el teléfono del vendedor anterior también se entera y deja de verlo.
//   - Pedidos y hojas se combinan CAMPO POR CAMPO (doc.fv guarda la hora de cada
//     campo): si dos equipos editan el mismo documento sin haberse sincronizado,
//     no se pierde ninguno de los dos cambios.
//   - Si la oficina reinició los datos (epoch distinto), el equipo no escribe
//     nada: recibe { reset } y primero borra su copia local.
//   - La alerta de cliente duplicado se calcula al bajar (campo `dups`) y NO se
//     guarda dentro de los pedidos: así nunca cambia la versión de un pedido
//     ajeno ni descarta la edición pendiente de otro equipo.

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const KINDS = ['orders', 'clients', 'products', 'sellers', 'loads', 'config', 'events'] as const;
const ADMIN_KINDS: readonly string[] = ['products', 'sellers', 'loads', 'config'];

type Kind = (typeof KINDS)[number];
// Campos de un pedido que controla la oficina: un teléfono nunca los pisa
// (aunque su copia local esté atrasada y no sepa que el pedido ya está en una hoja).
const OFFICE_ORDER_FIELDS = ['loadId', 'locked', 'loadStatusName', 'noteNumber', 'loadNumber', 'dispatchedAt', 'officeEdited', 'heldAt'];
const OFFICE_ORDER_STATUS: readonly string[] = ['en_carga', 'en_espera', 'despachado'];
// Solo se guardan en el equipo: el servidor calcula dupWith en cada bajada
const LOCAL_ONLY_FIELDS = ['dirty', 'dupWith'];
const MAX_BODY_BYTES = 4 * 1024 * 1024; // Vercel corta en 4,5 MB; el cliente envía tandas de ~2,5 MB
const MAX_DOCS_PER_KIND = 5000;
const MAX_DOC_BYTES = 256 * 1024; // productos con foto comprimida
const CHUNK = 200; // documentos por consulta
// La bajada relee este margen hacia atrás: una escritura que empezó antes del
// cursor pero terminó después no se pierde (fusionar dos veces no cambia nada).
const PULL_OVERLAP_MS = 5 * 60_000;
const PULL_BUDGET = 3 * 1024 * 1024; // tamaño máximo de cada página de bajada
const PULL_ORDER: readonly Kind[] = ['config', 'products', 'sellers', 'clients', 'loads', 'orders', 'events'];
const EVENTS_DAYS = 31; // historial que baja una oficina nueva

type Doc = Record<string, unknown> & { id: string; updatedAt: string; deleted?: boolean };
type Row = { kind: string; id: string; data: string; sellerId: string | null; routeDate: string | null; status: string | null; deleted: boolean; updatedAt: string };

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

function toRow(kind: Kind, doc: Doc): Row {
  return {
    kind,
    id: doc.id,
    data: JSON.stringify(doc),
    sellerId: kind === 'orders' || kind === 'clients' || kind === 'loads' || kind === 'events' ? String(doc.sellerId || '') : null,
    routeDate: kind === 'orders' ? String(doc.routeDate || '') : kind === 'events' ? String(doc.day || '') : null,
    status: kind === 'orders' ? String(doc.status || '') : null,
    deleted: !!doc.deleted,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Upsert por lotes. Solo escribe si la versión que llega no es más vieja, y solo
 * si los datos no se reiniciaron mientras tanto (candado + época en la misma
 * transacción: nada de antes del reinicio se cuela después). Devuelve los ids escritos.
 */
async function writeRows(rows: Row[], epoch: string) {
  if (!rows.length) return new Set<string>();
  const values = rows.map((r) => Prisma.sql`(${r.kind}, ${r.id}, ${r.data}, ${r.sellerId}, ${r.routeDate}, ${r.status}, ${r.deleted}, ${r.updatedAt})`);
  const out = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${RESET_LOCK})`;
    return tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "DistDoc" ("kind", "id", "data", "sellerId", "routeDate", "status", "deleted", "updatedAt", "syncedAt")
    SELECT v.*, now() FROM (VALUES ${Prisma.join(values)}) AS v
    WHERE COALESCE((SELECT "value" FROM "DistSetting" WHERE "name" = 'epoch'), '') = ${epoch}
    ON CONFLICT ("kind", "id") DO UPDATE SET
      "data" = EXCLUDED."data", "sellerId" = EXCLUDED."sellerId", "routeDate" = EXCLUDED."routeDate",
      "status" = EXCLUDED."status", "deleted" = EXCLUDED."deleted", "updatedAt" = EXCLUDED."updatedAt", "syncedAt" = now()
    WHERE "DistDoc"."updatedAt" <= EXCLUDED."updatedAt"
    RETURNING "id"`;
  }, TX_WAIT);
  return new Set(out.map((r) => r.id));
}

// ---- Versión por campo (pedidos y hojas), espejo de public/pedidos/js/db.js ----
const FV_SKIP = new Set(['id', 'updatedAt', 'fv', 'dirty', 'dupWith', 'partial']);
const FV_KINDS: readonly string[] = ['orders', 'loads'];
type Fv = Record<string, string>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const keysOf = (a: Doc, b: Doc) => new Set([...Object.keys(a), ...Object.keys(b)]);
// Documento sin fv (de un equipo con la versión anterior): todos sus campos valen con su updatedAt
function fvFull(d: Doc): Fv {
  if (d.fv && typeof d.fv === 'object') return d.fv as Fv;
  const fv: Fv = {};
  for (const k of Object.keys(d)) if (!FV_SKIP.has(k)) fv[k] = d.updatedAt;
  return fv;
}
const fvOf = (d: Doc, k: string) => (typeof fvFull(d)[k] === 'string' ? fvFull(d)[k] : '');

/** Deja en doc.fv solo horas válidas, sin pasar de maxTs (reloj adelantado). */
function cleanFv(doc: Doc, maxTs: string, now: string) {
  if (doc.fv === undefined) return;
  const fv: Fv = {};
  if (doc.fv && typeof doc.fv === 'object') {
    for (const [k, t] of Object.entries(doc.fv as Fv)) {
      if (typeof t === 'string' && !Number.isNaN(Date.parse(t))) fv[k] = t > maxTs ? now : t;
    }
  }
  doc.fv = fv;
}

// Campos que cambian juntos: se toman todos del mismo lado (nunca "enviado" de
// un lado con la hoja del otro). Los del pedido los decide la oficina: el
// teléfono del vendedor no los marca, así nunca le ganan a la oficina.
const GROUPS: Record<string, string[]> = {
  orders: ['status', 'loadId', 'locked', 'loadStatusName', 'noteNumber', 'loadNumber', 'dispatchedAt', 'heldAt'],
  loads: ['status', 'statusHistory', 'number', 'closedAt', 'approvedAt', 'totals', 'firstNote', 'lastNote'],
};

/** Combina dos versiones: fromA / fromB = el resultado trae algo que b / a no tenía. */
function mergeFields(a: Doc, b: Doc, kind: string) {
  const aWins = a.updatedAt >= b.updatedAt;
  const w = aWins ? a : b, lo = aWins ? b : a;
  const doc: Doc = { ...w };
  const take = (src: Doc, k: string) => { if (k in src) (doc as Record<string, unknown>)[k] = src[k]; else delete (doc as Record<string, unknown>)[k]; };
  const group = GROUPS[kind] || [];
  const stamp = (d: Doc) => group.reduce((m, k) => (fvOf(d, k) > m ? fvOf(d, k) : m), '');
  if (stamp(lo) > stamp(w)) group.forEach((k) => take(lo, k));
  for (const k of keysOf(a, b)) {
    if (FV_SKIP.has(k) || group.includes(k) || !(fvOf(lo, k) > fvOf(w, k))) continue;
    take(lo, k);
  }
  const fv: Fv = {};
  for (const x of [fvFull(lo), fvFull(w)]) for (const [k, t] of Object.entries(x)) if (typeof t === 'string' && t > (fv[k] || '')) fv[k] = t;
  doc.fv = fv;
  const differs = (x: Doc) => [...keysOf(doc, x)].some((k) => !FV_SKIP.has(k) && !same(doc[k], x[k]));
  return { doc, fromA: differs(b), fromB: differs(a) };
}
/** Una hora estrictamente posterior a todas (la versión combinada debe ganar en todos los equipos). */
function later(...ts: string[]) {
  const max = ts.slice().sort().pop()!;
  return new Date(Math.max(Date.parse(max) + 1, Date.now())).toISOString();
}

/** Alertas de cliente duplicado el mismo día (mismo u otro vendedor), para los pedidos recientes del alcance. */
async function duplicates(sellerId: string | null) {
  const from = daysAgo(3);
  const recent = await db.distDoc.findMany({ where: { kind: 'orders', deleted: false, routeDate: { gte: from } } });
  const orders = recent.map((r) => parseDoc(r.data) as Record<string, unknown>).filter((o) => !o.deleted);
  const keysOf = (o: Record<string, unknown>) => {
    const k: string[] = [];
    if (o.clientId) k.push(o.routeDate + '|i|' + o.clientId);
    if (o.clientKey) k.push(o.routeDate + '|k|' + o.clientKey);
    return k;
  };
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const o of orders) for (const k of keysOf(o)) { const g = groups.get(k) || []; g.push(o); groups.set(k, g); }
  const dups: Record<string, { id: string; sellerName: string }[]> = {};
  // Aprobado en adelante, el vendedor ya puede tomarle otro pedido al mismo cliente
  const approved = (o: Record<string, unknown>) => o.locked === true || o.status === 'despachado';
  for (const o of orders) {
    if (sellerId && o.sellerId !== sellerId) continue;
    const seen = new Map<string, { id: string; sellerName: string }>();
    for (const k of keysOf(o)) for (const x of groups.get(k) || []) {
      if (x.id === o.id || (x.sellerId === o.sellerId && (approved(x) || approved(o)))) continue;
      seen.set(String(x.id), { id: String(x.id), sellerName: String(x.sellerName || '') });
    }
    dups[String(o.id)] = [...seen.values()];
  }
  return { from, map: dups };
}

// Lo que ve un vendedor de una hoja de carga: estado, número, fecha, ruta y
// despachador. Nunca montos, notas ni pedidos de otros vendedores (hojas fusionadas).
const SELLER_LOAD_FIELDS = ['id', 'label', 'number', 'status', 'route', 'date', 'createdAt', 'closedAt', 'dispatcherId', 'dispatcherName',
  'firstNote', 'lastNote', 'sellerId', 'sellerIds', 'deleted', 'updatedAt'];
function sellerLoadView(d: Doc): Doc {
  return { ...Object.fromEntries(SELLER_LOAD_FIELDS.filter((f) => f in d).map((f) => [f, d[f]])), id: d.id, updatedAt: d.updatedAt, partial: true };
}

// ---- Avisos push según el cambio de un pedido ----
type Notice = { to: 'office' | 'seller'; sellerId: string; msg: PushMsg };
const SENT = ['enviado', 'en_carga', 'en_espera', 'despachado'];
const isSent = (o: Record<string, unknown> | null) => !!o && !o.deleted && SENT.includes(String(o.status));

function orderNotice(cur: Record<string, unknown> | null, doc: Record<string, unknown>, fromOffice: boolean): Notice | null {
  const id = String(doc.id), sid = String(doc.sellerId || ''), who = String(doc.sellerName || ''), client = String(doc.clientName || '');
  const office = (title: string, body: string, ev: string): Notice => ({ to: 'office', sellerId: sid, msg: { title, body, tag: `o-${id}-${ev}` } });
  const seller = (title: string, body: string, ev: string): Notice => ({ to: 'seller', sellerId: sid, msg: { title, body, tag: `o-${id}-${ev}` } });
  if (!fromOffice) {
    if (isSent(doc) && !isSent(cur)) return office('🧾 Nuevo pedido', `${who}: ${client}`, 'new');
    if (isSent(cur) && doc.deleted && !cur!.deleted) return office('🗑 Pedido eliminado', `${who} eliminó el pedido de ${client}`, 'del');
    if (isSent(cur) && doc.sellerEdited && doc.sellerEdited !== cur!.sellerEdited) return office('✏️ Pedido modificado', `${who} modificó el pedido de ${client}`, 'mod');
    return null;
  }
  if (!cur || !sid) return null;
  if (doc.deleted && !cur.deleted) return seller('🗑 Pedido eliminado por oficina', client, 'del');
  if (doc.status === 'despachado' && cur.status !== 'despachado') {
    const nota = doc.noteNumber ? ` · Nota NE-${String(doc.noteNumber).padStart(6, '0')}` : '';
    return seller('🚚 Pedido despachado', client + nota, 'desp');
  }
  if (doc.status === 'en_espera' && cur.status !== 'en_espera') return seller('⏸ Pedido en espera', `${client}: la oficina lo dejó para otra carga`, 'esp');
  if (doc.locked === true && cur.locked !== true) return seller('✅ Pedido aprobado', `${client} · ${String(doc.loadStatusName || 'Aprobado para carga')}`, 'apr');
  if (doc.officeEdited && doc.officeEdited !== cur.officeEdited) return seller('✏️ Pedido ajustado', `La oficina ajustó las cantidades de ${client}`, 'aj');
  return null;
}

/** Agrupa: si un mismo destino recibe muchos avisos iguales de golpe, sale uno solo con la lista. */
function grouped(list: Notice[]) {
  const out = new Map<string, { to: 'office' | 'seller'; sellerId: string; msgs: PushMsg[] }>();
  const byTitle = new Map<string, Notice[]>();
  for (const n of list) {
    const k = n.to + '|' + (n.to === 'seller' ? n.sellerId : '') + '|' + n.msg.title;
    byTitle.set(k, (byTitle.get(k) || []).concat(n));
  }
  byTitle.forEach((ns, k) => {
    const dest = k.split('|').slice(0, 2).join('|');
    const g = out.get(dest) || { to: ns[0].to, sellerId: ns[0].sellerId, msgs: [] };
    if (ns.length <= 3) g.msgs.push(...ns.map((n) => n.msg));
    else g.msgs.push({ title: `${ns[0].msg.title} (${ns.length})`, body: ns.map((n) => n.msg.body).join(' · ').slice(0, 300), tag: `g-${Date.now()}-${k}` });
    out.set(dest, g);
  });
  return [...out.values()];
}

export async function GET() {
  return NextResponse.json({ ok: true, service: 'pedidos-sync', time: new Date().toISOString() });
}

export async function POST(req: NextRequest) {
  const serverTime = new Date();

  if (!syncOk(req)) {
    return NextResponse.json({ error: 'Clave de sincronización inválida' }, { status: 401 });
  }
  const adminHeader = req.headers.get('x-admin-key');
  const isAdmin = isAdminReq(req);
  if (adminHeader && !isAdmin) {
    return NextResponse.json({ error: 'Clave admin inválida' }, { status: 401 });
  }
  // Supervisor: ve todo (igual que la oficina para la bajada), pero nunca puede
  // escribir nada — el bloqueo está más abajo, en el propio bucle de escritura.
  const supHeader = req.headers.get('x-supervisor-key');
  const isSupervisor = isSupervisorReq(req);
  if (supHeader && !isSupervisor) {
    return NextResponse.json({ error: 'Clave de supervisor inválida' }, { status: 401 });
  }

  const len = Number(req.headers.get('content-length') || 0);
  if (len > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Paquete demasiado grande' }, { status: 413 });
  }

  let body: {
    since?: string | null;
    sinceDays?: number | null;
    epoch?: string | null;
    sellerId?: string | null;
    noPull?: boolean;
    page?: { k?: number; id?: string } | null;
    push?: Partial<Record<Kind, unknown[]>>;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const sellerId = typeof body.sellerId === 'string' && body.sellerId ? body.sellerId : null;

  const accepted = Object.fromEntries(KINDS.map((k) => [k, [] as string[]])) as Record<Kind, string[]>;
  const rejected: { kind: Kind; id: string; reason: string; doc?: Doc }[] = [];
  const notices: Notice[] = [];
  const maxTs = new Date(serverTime.getTime() + 60_000).toISOString();

  try {
    // Datos reiniciados por la oficina: este equipo primero borra su copia local
    const epoch = await currentEpoch();
    if ((typeof body.epoch === 'string' ? body.epoch : '') !== epoch) {
      return NextResponse.json({ serverTime: serverTime.toISOString(), reset: epoch, resetAt: await epochAt(), accepted, rejected, pull: {} });
    }

    for (const kind of KINDS) {
      // Si el mismo documento viene repetido, gana su versión más reciente
      const newest = new Map<string, Doc>();
      for (const d of (Array.isArray(body.push?.[kind]) ? body.push![kind]! : []).filter(isDoc)) {
        const prev = newest.get(d.id);
        if (!prev || prev.updatedAt < d.updatedAt) newest.set(d.id, d);
      }
      const incoming = [...newest.values()];
      if (!incoming.length) continue;
      if (incoming.length > MAX_DOCS_PER_KIND) {
        return NextResponse.json({ error: `Demasiados documentos en ${kind}` }, { status: 413 });
      }
      // Un teléfono nunca publica catálogo ni cargas: se ignora sin error.
      if (ADMIN_KINDS.includes(kind) && !isAdmin) continue;
      // El supervisor NUNCA escribe nada, sea cual sea el sellerId que mande.
      if (isSupervisor) continue;
      // Un teléfono sin vendedor elegido no escribe pedidos ni clientes (quedan pendientes).
      if (!isAdmin && !sellerId) continue;

      for (let i = 0; i < incoming.length; i += CHUNK) {
        const part = incoming.slice(i, i + CHUNK);
        const existingRows = await db.distDoc.findMany({ where: { kind, id: { in: part.map((d) => d.id) } } });
        const existingById = new Map(existingRows.map((r) => [r.id, r]));
        const toWrite: Row[] = [];
        const pending = new Map<string, Notice>();

        for (const raw of part) {
          let doc: Doc = { ...raw };
          for (const f of LOCAL_ONLY_FIELDS) delete (doc as Record<string, unknown>)[f];
          // Un reloj de teléfono adelantado no puede "ganar" para siempre.
          if (doc.updatedAt > maxTs) doc.updatedAt = serverTime.toISOString();
          if (FV_KINDS.includes(kind)) cleanFv(doc, maxTs, serverTime.toISOString());
          if (JSON.stringify(doc).length > MAX_DOC_BYTES) {
            rejected.push({ kind, id: doc.id, reason: 'too_large' });
            continue;
          }
          const existing = existingById.get(doc.id);
          const cur = existing ? parseDoc(existing.data) : null;

          // Una hoja en vista reducida (la del vendedor) nunca reemplaza a la real:
          // se rechaza y el equipo recibe la hoja completa
          if (kind === 'loads' && (doc as Record<string, unknown>).partial) {
            rejected.push({ kind, id: doc.id, reason: 'partial', doc: cur || undefined });
            continue;
          }
          if (kind === 'events') {
            // Historial: solo se agrega. Un teléfono solo escribe eventos de su vendedor.
            if (!isAdmin && String(doc.sellerId || '') !== sellerId) { rejected.push({ kind, id: doc.id, reason: 'foreign' }); continue; }
            if (existing) { accepted[kind].push(doc.id); continue; }
            toWrite.push(toRow(kind, doc));
            continue;
          }
          if (!isAdmin && (kind === 'orders' || kind === 'clients')) {
            // Nunca se escribe ni se reasigna un pedido o cliente de otro vendedor
            if (String(doc.sellerId || '') !== sellerId || (cur && String(cur.sellerId || '') !== sellerId)) {
              rejected.push({ kind, id: doc.id, reason: 'foreign', doc: cur || undefined });
              continue;
            }
          }

          if (existing && cur) {
            if (kind === 'orders' && !isAdmin && (cur.locked === true || existing.status === 'despachado')) {
              rejected.push({ kind, id: doc.id, reason: 'locked', doc: cur });
              continue;
            }
            if (FV_KINDS.includes(kind)) {
              // Otro equipo cambió otros campos del mismo pedido u hoja: se conservan ambos
              const m = mergeFields(cur, doc, kind);
              if (!m.fromB) {
                // No trae nada nuevo: reintento idempotente o versión vieja
                if (existing.updatedAt === doc.updatedAt) accepted[kind].push(doc.id);
                else rejected.push({ kind, id: doc.id, reason: 'stale', doc: cur });
                continue;
              }
              if (m.fromA || existing.updatedAt >= doc.updatedAt) doc = { ...m.doc, updatedAt: later(existing.updatedAt, doc.updatedAt) };
            }
            if (kind === 'orders' && !isAdmin) {
              const c = cur as Record<string, unknown>;
              const d = doc as Record<string, unknown>;
              const fv = doc.fv ? (doc.fv as Fv) : {}, cfv = fvFull(cur);
              const keep = (f: string) => { if (cfv[f]) fv[f] = cfv[f]; else delete fv[f]; };
              let changed = false;
              for (const f of OFFICE_ORDER_FIELDS) {
                if (c[f] !== undefined && d[f] !== c[f]) { d[f] = c[f]; keep(f); changed = true; }
              }
              if (OFFICE_ORDER_STATUS.includes(String(c.status)) && d.status !== c.status) { d.status = c.status; keep('status'); changed = true; }
              // La oficina ve que el vendedor tocó un pedido que ya estaba en una hoja
              if (c.loadId && JSON.stringify(d.lines) !== JSON.stringify(c.lines)) { d.sellerEdited = serverTime.toISOString(); fv.sellerEdited = serverTime.toISOString(); }
              // Nueva versión con hora del servidor para que el teléfono la vuelva a bajar corregida
              if (changed && existing.updatedAt <= doc.updatedAt) doc.updatedAt = later(existing.updatedAt, doc.updatedAt);
            }
            if (existing.updatedAt > doc.updatedAt) {
              rejected.push({ kind, id: doc.id, reason: 'stale', doc: cur });
              continue;
            }
            if (existing.updatedAt === doc.updatedAt) {
              accepted[kind].push(doc.id); // reintento idempotente
              continue;
            }
          }
          if (kind === 'orders') {
            const n = orderNotice(cur as Record<string, unknown> | null, doc as Record<string, unknown>, isAdmin);
            if (n) pending.set(doc.id, n);
          }
          toWrite.push(toRow(kind, doc));
        }

        const written = await writeRows(toWrite, epoch);
        const lost = toWrite.filter((r) => !written.has(r.id));
        for (const r of toWrite) if (written.has(r.id)) accepted[kind].push(r.id);
        pending.forEach((n, id) => { if (written.has(id)) notices.push(n); });
        if (lost.length) {
          // Otro equipo escribió una versión más nueva entre la lectura y la escritura
          const now = await db.distDoc.findMany({ where: { kind, id: { in: lost.map((r) => r.id) } } });
          for (const r of now) rejected.push({ kind, id: r.id, reason: 'stale', doc: parseDoc(r.data) });
        }
      }
    }

    // Avisos push: se envían después de responder (no hacen esperar al teléfono)
    if (notices.length) {
      after(async () => {
        for (const g of grouped(notices)) {
          try { await sendPush(g.to, g.to === 'seller' ? g.sellerId : null, g.msgs); } catch (e) { console.warn('[push]', e); }
        }
      });
    }

    // Tandas intermedias de una subida grande: la bajada va en la última
    if (body.noPull) return NextResponse.json({ serverTime: serverTime.toISOString(), accepted, rejected, pull: {} });

    // ---- Bajada (por páginas) ----
    const since = body.since && !Number.isNaN(Date.parse(body.since)) ? new Date(Date.parse(body.since) - PULL_OVERLAP_MS) : null;
    const syncedAt = since ? { gte: since } : undefined;
    const sinceDays = !since && typeof body.sinceDays === 'number' && body.sinceDays > 0
      ? Math.min(body.sinceDays, 365) : null;
    // Un teléfono sin vendedor elegido solo baja catálogo, vendedores y ajustes
    const noScope = !isAdmin && !isSupervisor && !sellerId;
    const office = (isAdmin || isSupervisor) && !sellerId;

    const whereOf = (kind: Kind): Prisma.DistDocWhereInput | null => {
      switch (kind) {
        case 'config': case 'products': case 'sellers': return { kind, syncedAt };
        case 'clients':
          if (noScope) return null;
          // Los suyos, y los que fueron suyos (para que el teléfono los suelte)
          return sellerId
            ? { kind, syncedAt, OR: [{ sellerId }, { data: { contains: JSON.stringify(sellerId) } }] }
            : { kind, syncedAt };
        case 'loads':
          if (office) return { kind, syncedAt };
          // El vendedor ve las hojas donde están sus clientes (estado, despachador, fecha)
          return sellerId ? { kind, syncedAt, data: { contains: JSON.stringify(sellerId) } } : null;
        case 'orders':
          if (noScope) return null;
          return { kind, syncedAt, ...(sellerId ? { sellerId } : {}), ...(sinceDays ? { routeDate: { gte: daysAgo(sinceDays) } } : {}) };
        case 'events': return office ? { kind, syncedAt, ...(since ? {} : { routeDate: { gte: daysAgo(EVENTS_DAYS) } }) } : null;
      }
    };

    const pull = Object.fromEntries(PULL_ORDER.map((k) => [k, [] as Doc[]])) as Record<Kind, Doc[]>;
    let k = Math.max(0, Math.min(PULL_ORDER.length, Number(body.page?.k) || 0));
    let afterId = typeof body.page?.id === 'string' ? body.page.id : '';
    let size = 0;
    let next: { k: number; id: string } | null = null;
    outer: for (; k < PULL_ORDER.length; k++, afterId = '') {
      const kind = PULL_ORDER[k];
      const where = whereOf(kind);
      if (!where) continue;
      for (;;) {
        const rows = await db.distDoc.findMany({ where: { AND: [where, { id: { gt: afterId } }] }, orderBy: { id: 'asc' }, take: 200 });
        for (const r of rows) {
          if (size && size + r.data.length > PULL_BUDGET) { next = { k, id: afterId }; break outer; }
          pull[kind].push(kind === 'loads' && !office ? sellerLoadView(parseDoc(r.data)) : parseDoc(r.data));
          size += r.data.length;
          afterId = r.id;
        }
        if (rows.length < 200) break;
      }
    }

    return NextResponse.json({
      serverTime: serverTime.toISOString(),
      accepted,
      rejected,
      pull,
      more: !!next,
      page: next,
      dups: next || noScope ? null : await duplicates(sellerId),
    });
  } catch (error) {
    console.error('[pedidos/sync]', error);
    return NextResponse.json({ error: 'Error interno de sincronización' }, { status: 500 });
  }
}
