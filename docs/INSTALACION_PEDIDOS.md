# Instalación paso a paso — Puerto Venado Pedidos

> Tiempo estimado: 1 a 2 horas la primera vez. No hace falta programar, pero sí seguir los pasos en orden.

## 0. Antes de empezar (obligatorio)

1. **Haz privado el repositorio en GitHub.** Si es público, cualquiera puede ver y copiar el código.
   GitHub → repositorio `PWApedidos` → **Settings** → abajo, *Danger Zone* → **Change visibility → Private**.
2. **Crea cuatro claves largas y distintas** y guárdalas en un lugar seguro (gestor de contraseñas o papel en la caja fuerte).
   Para generarlas: en <https://passwordsgenerator.net> elige 24 caracteres sin símbolos raros; o en una terminal escribe `openssl rand -base64 24`.

| Variable | Para qué sirve | Quién la conoce |
|---|---|---|
| `PEDIDOS_BASIC_USER` / `PEDIDOS_BASIC_PASS` | Usuario y clave para **abrir** la app. Sin ellas no se descarga ni una línea del código | Todos (oficina y vendedores) |
| `PEDIDOS_SYNC_KEY` | Permite sincronizar pedidos | Todos |
| `PEDIDOS_ADMIN_KEY` | Permite publicar precios, catálogo, clientes y cerrar cargas | **Solo la oficina** |
| `DATABASE_URL` / `DIRECT_URL` | Conexión a la base de datos (Supabase) | Solo el servidor |

## Despliegue

Sigue la guía del [README](../README.md): Vercel + Supabase (Postgres).

---

## Primer uso (igual con A o B)

### PC de la oficina
1. Abre `https://TU-DOMINIO/pedidos` y escribe el usuario y la clave de acceso. Marca "recordar".
2. Entra en **Oficina** → **Cargar paquete de arranque** → elige `puerto-venado-arranque.json`.
3. Ve a **Ajustes → Sincronización**, escribe la **clave de sync** y la **clave admin**, y pulsa **Guardar y sincronizar**.
4. En **Ajustes → Seguridad de la oficina**, crea tu **PIN**. La oficina se bloqueará al salir y tras 15 minutos sin uso.
5. En **Ajustes → Empresa**, completa el RIF, el teléfono y la tasa Bs.
6. En Chrome, menú ⋮ → **Instalar Puerto Venado** para tenerla como programa.
7. Toca la 🔔 y pulsa **Activar avisos del sistema**, para recibir alertas aunque la pestaña esté en segundo plano.

### Teléfono de cada vendedor
1. Abre `https://TU-DOMINIO/pedidos` en Chrome (Android) o Safari (iPhone) y escribe el usuario y la clave.
2. Menú → **Agregar a pantalla de inicio**.
3. Elige su nombre → ☰ → **Conexión**, escribe la **clave de sync** → **Guardar**. Su cartera y el catálogo se descargan solos.
4. **Nunca le des la clave admin a un vendedor.**

## Imprimir y descargar
- **Hoja de carga y notas:** botón **🖨 Imprimir / PDF**. En la ventana que abre el navegador:
  - elige tu impresora para imprimir;
  - o elige **Guardar como PDF** para descargarla.
- **Excel:** botón **⇩ Descargar Excel** (CSV que abre directo en Excel) o **📋 Copiar para Excel**.

## Qué protege el sistema y qué no
- ✅ **Sin la clave de acceso** no se ve la app ni se descarga su código (servidor con autenticación). Los buscadores no la indexan y no se puede incrustar en otras webs.
- ✅ **Sin la clave de sync** nadie lee ni sube pedidos. **Sin la clave admin** nadie cambia precios, clientes ni cargas.
- ✅ **El PIN** bloquea la oficina en la PC compartida.
- ✅ **El repositorio privado** evita que se copie desde GitHub.
- ⚠️ **Lo que no se puede impedir:** quien ya tiene la clave de acceso puede, técnicamente, ver el JavaScript que corre en su navegador (esto pasa con cualquier web del mundo). Por eso:
  - cambia la clave de acceso si alguien se va de la empresa;
  - deja por escrito en el contrato de quién es el código y que no puede copiarse.
