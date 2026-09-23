# Puerto Venado · Pedidos

PWA de toma de pedidos, hojas de carga y despacho de Distribuidora de Suministros Puerto Venado.

- La app vive en `public/pedidos/` (HTML + CSS + JS, funciona sin internet).
- El servidor (Next.js) solo hace dos cosas: pide usuario y clave una sola vez en `/acceso` y deja una cookie de un año (`src/proxy.ts`, `src/app/acceso/route.ts`) y sincroniza los datos (`src/app/api/pedidos/sync/route.ts`).
- Los datos se guardan en PostgreSQL (Supabase), en una sola tabla: `DistDoc`.

Detalle funcional: [docs/PEDIDOS_PWA.md](docs/PEDIDOS_PWA.md) · Primer uso: [docs/INSTALACION_PEDIDOS.md](docs/INSTALACION_PEDIDOS.md)

## Despliegue en Vercel + Supabase

1. **Supabase → Connect → Direct connection string.** Copia dos cadenas y reemplaza `[YOUR-PASSWORD]` por la clave de la base de datos:
   - *Transaction pooler* (puerto **6543**) → `DATABASE_URL`, y agrega al final `?pgbouncer=true&connection_limit=1`
   - *Session pooler* (puerto **5432**) → `DIRECT_URL`
2. **La tabla se crea sola** en cada despliegue (`prisma db push` dentro de `npm run build`, usando `DIRECT_URL`). Si prefieres hacerlo a mano: Supabase → SQL Editor → pega `prisma/init.sql` → Run.
3. **Vercel → Add New → Project →** importa `PWApedidos`. Framework: Next.js. No cambies nada más.
4. **Environment Variables** (Production, Preview y Development):

   | Variable | Valor |
   |---|---|
   | `DATABASE_URL` | cadena del paso 1, puerto 6543 |
   | `DIRECT_URL` | cadena del paso 1, puerto 5432 |
   | `PEDIDOS_BASIC_USER` | usuario para abrir la app |
   | `PEDIDOS_BASIC_PASS` | clave larga para abrir la app |
   | `PEDIDOS_SYNC_KEY` | clave larga de sincronización |
   | `PEDIDOS_ADMIN_KEY` | clave larga, **solo oficina** |
   | `PEDIDOS_SUPERVISOR_KEY` | opcional: ve todo, no puede cambiar nada |

5. **Deploy.** La dirección raíz (`https://…vercel.app/`) abre la app directamente.

## Desarrollo local

```bash
cp .env.example .env   # completa los valores
npm install
npm run db:push        # crea la tabla en la base de datos del .env
npm run dev            # http://localhost:3000
```

Al publicar cambios en `public/pedidos`, sube `CACHE_VERSION` en `public/pedidos/sw.js`.
