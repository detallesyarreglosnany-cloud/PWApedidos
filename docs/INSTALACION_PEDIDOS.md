# Instalación paso a paso — Puerto Venado Pedidos

> Tiempo estimado: 1 a 2 horas la primera vez. No hace falta programar, pero sí seguir los pasos en orden.

## 0. Antes de empezar (obligatorio)

1. **Haz privado el repositorio en GitHub.** Si es público, cualquiera puede ver y copiar el código.
   GitHub → repositorio `PWApedidos` → **Settings** → abajo, *Danger Zone* → **Change visibility → Private**.
2. **Crea cuatro claves largas y distintas** y guárdalas en un lugar seguro (gestor de contraseñas o papel en la caja fuerte).
   Para generarlas: en <https://passwordsgenerator.net> elige 24 caracteres sin símbolos raros; o en una terminal escribe `openssl rand -base64 24`.

| Variable | Para qué sirve | Quién la conoce |
|---|---|---|
| `PEDIDOS_BASIC_USER` / `PEDIDOS_BASIC_PASS` | Usuario y clave para **abrir** la app. Sin ellas no se descarga ni una línea del código. Se escriben una vez por equipo y quedan recordadas un año; si las cambias en Vercel, todos los equipos deben volver a entrar | Todos (oficina y vendedores) |
| `PEDIDOS_SYNC_KEY` | Permite sincronizar pedidos | Todos |
| `PEDIDOS_ADMIN_KEY` | Permite publicar precios, catálogo, clientes y cerrar cargas | **Solo la oficina** |
| `PEDIDOS_SUPERVISOR_KEY` | Ve todos los pedidos, clientes, historial y reportes. No puede crear, editar ni eliminar nada. Opcional | Gerencia / supervisión |
| `DATABASE_URL` / `DIRECT_URL` | Conexión a la base de datos (Supabase) | Solo el servidor |

## Despliegue

Sigue la guía del [README](../README.md): Vercel + Supabase (Postgres).

---

## Primer uso (igual con A o B)

### PC de la oficina
1. Abre `https://TU-DOMINIO/pedidos` y escribe el usuario y la clave en la pantalla **Acceso a Pedidos**. El equipo los recuerda por un año, aunque se cierre la app o se reinicie el teléfono.
2. Entra en **Oficina** → **Cargar paquete de arranque** → elige `puerto-venado-arranque.json`.
3. Ve a **Ajustes → Sincronización**, escribe la **clave de sync** y la **clave admin**, y pulsa **Guardar y sincronizar**.
4. En **Ajustes → Seguridad de la oficina**, crea tu **PIN**. La oficina se bloqueará al salir y tras 15 minutos sin uso.
5. En **Ajustes → Empresa**, completa el RIF, el teléfono y la tasa Bs.
6. En Chrome, menú ⋮ → **Instalar Puerto Venado** para tenerla como programa.
7. Toca la 🔔 y pulsa **Activar avisos del sistema**, para recibir alertas aunque la pestaña esté en segundo plano.

### Teléfono de cada vendedor
1. Abre `https://TU-DOMINIO/pedidos` en Chrome (Android) o Safari (iPhone) y escribe el usuario y la clave en la pantalla **Acceso a Pedidos** (solo la primera vez).
2. Menú → **Agregar a pantalla de inicio**.
3. Elige su nombre → **Entrar** → ☰ → al final del menú, **🔑 Conexión** (si falta la clave aparece ya abierto), escribe la **clave de sync** (`PEDIDOS_SYNC_KEY`) en «Clave de sincronización», deja vacío «Servidor» → **Guardar conexión**. Su cartera y el catálogo se descargan solos.
4. **Nunca le des la clave admin a un vendedor.**

### Supervisor (solo consulta, para gerencia)
En el login, botón **👁 Supervisor · Solo consulta**. Pide la clave de sincronización y la clave de supervisor (`PEDIDOS_SUPERVISOR_KEY`, si la configuraste en Vercel). Desde ahí se ve, de todos los vendedores:
- **Resumen** del día.
- **Reportes**: elige un rango de fechas (hoy, últimos 7/15/30 días, o cualquier rango) y sale el total y el desglose por vendedor, por despachador/ruta y por categoría de producto, más el detalle de cada pedido y descarga en Excel.
- **Historial**: la misma actividad que ve la oficina.

Nunca puede crear, editar ni eliminar nada — ni siquiera si alguien intenta forzarlo, el servidor lo rechaza.

### Eliminar un pedido hecho por error (vendedor)
Toca el cliente en la fila de clientes de hoy → **Ver pedido** → **Eliminar**. Se puede mientras su hoja de carga no esté aprobada (🔒). Si ya está aprobada, lo quita la oficina.

### Eliminar un pedido desde la oficina
Si el vendedor se equivocó o no sabe hacerlo: en **Cargas** (dentro de la hoja, en «Clientes en espera») o en **Pedidos**, toca **Editar/Ver** en el pedido → **🗑 Eliminar pedido** → confirmar. El pedido sale de su hoja de carga (si la hoja queda vacía y sin número, se elimina), el vendedor recibe el aviso «La oficina eliminó el pedido» y queda anotado en el **Historial**. No se borra de la base de datos: queda marcado como eliminado (se puede recuperar). Un pedido ya **despachado** no se puede eliminar.

### Cliente que aún no paga (pedido en la hoja de carga)
En **Cargas**, abre la hoja → en la fila del cliente toca **⏸ Espera**. El pedido sale de la hoja **sin perderse** y queda en «Clientes en espera». Cuando pague, toca **↩ Reincorporar** y vuelve a la cola de carga. No lo elimines: eliminarlo borra el pedido.

### Pasar un cliente a otro vendedor (o asignar uno sin vendedor)
**Clientes** → busca el cliente → cambia el **Vendedor**. En la próxima sincronización aparece en el teléfono del nuevo vendedor y desaparece del anterior. El filtro **— Sin vendedor —** muestra los clientes sin asignar.

### Avisos en tiempo real (campanita 🔔)
En cada equipo (oficina y cada vendedor): toca 🔔 → **Activar avisos en este equipo**. Desde ahí los avisos llegan aunque la app esté cerrada o la pantalla bloqueada:
- **Oficina**: pedido nuevo, pedido modificado o eliminado por un vendedor.
- **Vendedor**: su pedido fue aprobado, puesto en espera, ajustado por la oficina, despachado (con número de nota) o eliminado.

Con la app abierta, la oficina revisa cada 10 s y el vendedor cada 30 s. En iPhone los avisos solo funcionan con la app instalada («Agregar a pantalla de inicio»).

### Seguimiento del vendedor (Mis pedidos)
☰ → **📋 Mis pedidos y cargas**. El vendedor ve TODOS sus pedidos (no solo los de hoy), por estado (enviados, aprobados, en espera, despachados, sin enviar) y por período (hoy, 7, 15 días, mes, todo), con el total enviado y el **total despachado** (base de su comisión). Al tocar un pedido ve lo que pidió contra lo que quedó o se despachó (si la oficina ajustó cantidades), la hoja, el número de carga, el despachador, la fecha de carga y la nota de entrega. En **Hojas de carga** ve cada hoja donde están sus clientes, con su estado en tiempo real.

### Historial de actividad
**Historial** muestra, por día, qué hizo cada vendedor y la oficina, con la hora: abrió la app, entró a su ruta, abrió, envió, modificó o eliminó pedidos, cambios de estado de las hojas, clientes reasignados. Arriba hay un resumen por persona (primera y última actividad, pedidos enviados, monto). Se exporta a Excel. Nadie puede editarlo ni borrarlo. Si un vendedor estuvo sin señal, sus acciones llegan con su hora real al recuperarla.

### Varios equipos con el mismo usuario
Un vendedor puede usar dos teléfonos y la oficina varias PCs (o PC y teléfono) a la vez: todos ven lo mismo en la próxima sincronización (oficina cada 10 s, vendedor cada 30 s, o al tocar el indicador «En línea»). Un pedido es uno solo aunque se vea en varios equipos. Si dos PCs cambian la misma hoja casi al mismo tiempo (una aprueba y otra pone el despachador, o una saca un cliente a espera), se conservan los dos cambios. Lo que se hace sin señal queda guardado en ese equipo y sube solo al recuperar internet; mientras tanto el indicador muestra cuántos cambios faltan por subir.

Si el mismo vendedor, **sin señal en los dos teléfonos**, hace un pedido al mismo cliente en cada uno, al sincronizar quedan dos pedidos y ambos se marcan **⚠ duplicado**: la oficina decide cuál queda (elimina el otro o lo pone en espera).

### Reiniciar datos (empezar de cero tras las pruebas)
**Ajustes → ⚠ Reiniciar datos**. Primero descarga el respaldo. Elige:
- **Pedidos, hojas de carga, historial y numeración**: se conservan catálogo, clientes, vendedores y ajustes. La primera carga real sale con el número C-00001 y la primera nota con NE-000001.
- **Todo**: después vuelve a cargar el paquete de arranque.

Escribe REINICIAR para confirmar. Cada equipo (oficina, vendedores, supervisor) borra su copia en su próxima sincronización y se recarga solo. Lo que un equipo tenía sin enviar **de antes** del reinicio se borra (son datos de prueba y nunca llegan al servidor); si un vendedor estaba sin señal y tomó pedidos **después** del reinicio, esos se conservan y se envían al recuperar la señal. El reinicio queda anotado en el Historial.

### Respaldo (obligatorio, una vez por semana)
**Ajustes → Servidor y respaldo**:
- **Revisar estado del servidor**: confirma que la base de datos responde, que tiene sus tablas y cuántos registros hay.
- **Descargar respaldo del servidor**: un archivo con todo (pedidos, clientes, cargas, catálogo, historial). Guárdalo fuera de la PC (Drive, correo, USB). Se restaura con «Importar paquete».

El plan gratuito de Supabase no incluye copias de seguridad descargables; por eso este respaldo semanal es obligatorio (o pasar a Supabase Pro, que hace copias diarias).

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
