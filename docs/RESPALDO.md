# Respaldo automático diario (GitHub Actions)

Todos los días a las ~3:00 a. m. (hora de Venezuela) GitHub baja **todos** los datos de la app
(pedidos, hojas, liquidaciones, clientes, catálogo con fotos, vendedores, ajustes, historial y
kardex de vacíos) y los guarda en un **.zip cifrado con contraseña**: los **últimos 7 días** y el del **día 1 de cada mes por 60 días**.
Es el mismo archivo del botón «Respaldo del servidor»: se restaura con **Oficina → Ajustes →
Cargar paquete**. Si un día falla, GitHub te manda un correo.

## Configurarlo (una sola vez, ~5 minutos)

1. Entra a GitHub → repositorio **PWApedidos** → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
2. Crea estos 4 secretos (nombre exacto, valor sin espacios):

   | Nombre | Valor |
   |---|---|
   | `PEDIDOS_URL` | La dirección de la app, por ejemplo `https://pw-apedidos.vercel.app` (sin `/pedidos` al final) |
   | `PEDIDOS_SYNC_KEY` | El mismo valor de `PEDIDOS_SYNC_KEY` en Vercel → Settings → Environment Variables |
   | `PEDIDOS_ADMIN_KEY` | El mismo valor de `PEDIDOS_ADMIN_KEY` en Vercel |
   | `RESPALDO_CLAVE` | Una contraseña larga **nueva** (ej. 4 palabras + números). **Guárdala** en tu gestor de claves: sin ella el respaldo no se puede abrir. |

3. Pruébalo: **Actions** → **Respaldo diario** → **Run workflow**. En 1–2 minutos debe quedar en verde ✅.

## Bajar y abrir un respaldo

1. **Actions** → **Respaldo diario** → abre la corrida del día que quieres → abajo, en **Artifacts**, descarga `respaldo-diario-…` o `respaldo-mensual-…`.
2. GitHub lo entrega como `.zip`; adentro está `respaldo_puerto_venado.zip`. Ábrelo con **7-Zip** (gratis, https://7-zip.org) y escribe la contraseña `RESPALDO_CLAVE`. (El Explorador de Windows no abre zips cifrados con AES-256.)
3. Adentro está `respaldo_puerto_venado_AAAA-MM-DD.json`.

## Restaurar (solo si se perdieron datos en el servidor)

1. En la PC de oficina: **Ajustes → Cargar paquete** → elige el `.json`.
2. La app lo carga y lo sube al servidor en la próxima sincronización (necesita internet).
3. Revisa Pedidos, Archivo, Clientes y Envases.

> Antes de restaurar, si el servidor todavía tiene datos, baja también un «Respaldo del servidor»
> del estado actual: así puedes volver atrás si eliges el día equivocado.

## Cambiar las claves

Si cambias `PEDIDOS_SYNC_KEY` o `PEDIDOS_ADMIN_KEY` en Vercel, cámbialas también aquí; si no,
el respaldo falla (y te llega el correo de aviso).
