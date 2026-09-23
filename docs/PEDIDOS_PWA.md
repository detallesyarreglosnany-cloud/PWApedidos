# Puerto Venado · PWA de pedidos, hojas de carga y despacho

App web instalable y **offline-first** de Distribuidora de Suministros Puerto Venado.
- **Vendedores:** usan el teléfono en la calle.
- **Oficina:** usa la PC para armar las cargas, aprobar el despacho, llevar el inventario y el archivo.

Vive en `public/pedidos/` (HTML + CSS + JS sin dependencias ni CDN) y se abre en `/pedidos`.
La sincronización pasa por `POST /api/pedidos/sync`, protegida con clave.

```
public/pedidos/
├── index.html, styles.css, manifest.webmanifest, sw.js
├── icons/        logo (login, impresión), íconos PWA
├── fonts/        Oswald (OFL) para funcionar sin internet
├── vendor/       SheetJS: lector de Excel, se carga solo al importar
└── js/
    ├── db.js        IndexedDB: products, sellers, clients, orders, loads, config, meta
    ├── seed.js      estructura inicial: vendedores+rutas, despachadores, límites (sin demo)
    ├── sync.js      sincronización HTTP + paquetes .json (WhatsApp / respaldo)
    ├── matrix.js    matriz productos × clientes + exportación Excel/CSV
    ├── loads.js     hojas de carga: armado automático, espera, aprobación
    ├── print.js     hoja de carga (sin precios) y notas de entrega (original + copia)
    ├── importer.js  Excel/CSV → catálogo y cartera, clasificador de rubros
    ├── app.js       núcleo + login + pantalla del vendedor
    └── office.js    oficina: Cargas, Pedidos, Archivo, Inventario, Clientes, Vendedores, Ajustes
```

> **Datos sensibles fuera del repositorio.** Por eso la lista de precios
> y la cartera de clientes (RIF, teléfonos) **no** están en el código. Llegan en el
> *paquete de arranque* (`puerto-venado-arranque.json`), que la oficina importa una sola vez.
> Desde ahí viajan solo por la sincronización, protegida con clave.

## 1. Flujo operativo

```
VENDEDOR (teléfono)                     OFICINA (PC)
abierto ─cierra y envía─▶ enviado ─armado automático─▶ hoja "Esperando aprobación"   ✏️ editable (vendedor y oficina)
                                                        │ ⇄ mover · ⏸ espera · fusionar · ← → reordenar
                                                        ▼
                                                   "Aprobada para carga"  🔒 ya nadie edita · Nº de carga
                                                        ▼
                                                   "Carga cerrada"        🔒 cierre: notas NE, inventario, fecha, Archivo
                                                        ▼
                                                   "Despachada" / estados que agregues
```

- **Estados configurables** en Ajustes → Estados de la carga: nombre, orden y dos marcas.
  - **🔒 Bloquea:** desde ese estado nadie edita los pedidos.
  - **Cierra la carga:** numera las notas, descuenta el inventario, fija la fecha y la pasa al Archivo.
  - El estado se cambia con el selector de la hoja. Si una hoja cerrada se lleva a un estado sin cierre, se **reabre**: el inventario se devuelve y los números ya emitidos se conservan.
- **Edición de pedidos:** vendedor (con o sin señal) y oficina editan mientras la hoja esté en un estado sin 🔒. El servidor protege los campos de la oficina (hoja, estado, bloqueo, número de nota). Así, un teléfono con información atrasada nunca saca un pedido de su hoja ni lo duplica. Los cambios quedan marcados como "editado oficina" o "modificado por vendedor".
- **Hojas:** agrupan uno o **varios vendedores** (fusionar), con las iniciales L.R. / F.A. sobre cada cliente. El tope es 900 bultos o 32 clientes, configurable. Se puede:
  - mover un cliente a otra hoja o a una hoja nueva;
  - reordenar las columnas (← →);
  - crear hojas vacías;
  - dejar clientes en espera y reincorporarlos después.
- **Datos editables de la hoja:**
  - **código** (automático tipo `SEP16-BARR`);
  - **fecha de la carga** (si se deja vacía, se toma la fecha del cierre; la hoja muestra además el rango de fechas de los pedidos, ej. `14-16SEP`);
  - ruta y despachador.

  Los vendedores, rutas y despachadores se agregan en Vendedores y Ajustes.
- **Totales siempre visibles:** en pantalla, el encabezado, las filas de totales y la columna TOTAL quedan fijos al desplazarse. La hoja impresa sale sin precios, con la fila de iniciales del vendedor y columnas en blanco configurables (por defecto **VACÍOS** y **DEVOLUCIÓN**).
- **Notas de entrega:** una por cliente, con precios, en ORIGINAL y COPIA.
- **Archivo:** guarda las cargas cerradas con código, número, fecha, estado, vendedores, ruta, despachador y totales. Se filtra y se exporta a CSV.

## 2. Catálogo (lista de precios 30/07/2026)

- 169 renglones → **139 productos**. Las **categorías salen de la columna REF del archivo**, agrupadas por familia:
  - `REF 2`, `REF 1,5`, `REF 1,25`, `REF 1`, `REF 350`, `REF LATA` y `REF PET 355` → **REFRESCOS**, con el tamaño como subgrupo.
  - `CONF CHOWI`, `CONF PAPA`, `CONF YUCA`, etc. → **CONFITERIA**, con subgrupo CHOWI, PAPA, YUCA, etc.
  - `GALLETA`, `GALLETAS` y `TIP TOP` → **GALLETA**.
  - `MORENA` (Cerveza Morena) → **CERVEZA**.
  - El resto toma su primera palabra: `SALSA X UN` → SALSA, `MOSTAZA VIDRIO` → MOSTAZA.
  - Al importar un Excel con la columna REF se aplica la misma regla (`Importer.categoryFromRef`).
- **Orden inicial:**
  - Categorías: REFRESCOS › SODA › JUGO › NECTAR › AGUA › MALTA › CERVEZA › SARDINA › CONFITERIA › GALLETA › ARROZ › PASTA › MERMELADA › GELATINA › SALSA › MAYONESA › MOSTAZA › LICOR.
  - Dentro de REFRESCOS: 2 L › 1,5 L › 1,25 L › 1 L › 350 ml › lata › PET 355.
  - Dentro de LICOR: whiskys primero.
  - Todo se ajusta en **Inventario → ↕ Ordenar catálogo**, con flechas para categorías y productos. El cambio llega a los teléfonos y a la hoja de carga.
- **Perfil de administrador:** la oficina saluda con "Hola, Daniela". El nombre y el pie de página se editan en Ajustes → Mi perfil de administrador.
- **Forma de venta:**
  - **Caja y unidad:** solo cuando la lista trae ambos precios. En ese caso los dos renglones se fusionan en un producto (30 casos). El código de caja queda como principal y el de unidad en `unitCode`.
  - **Solo unidad:** whisky, ron, anís y vodka, además de los renglones "P/UND" sin caja equivalente.
  - **Solo caja:** todo lo demás (refrescos, aguas, Del Valle, soda, maltas, cervezas…).
- Cada producto tiene: código, código unidad, nombre (el de facturación), presentación, rubro, subgrupo (ej. REFRESCOS · 2 L), marca, unidades por caja, precio caja, precio unidad, stock, **orden**, activo y **foto**.
- **Stock vacío = sin control de inventario:** no muestra alertas ni descuenta. Se llena desde Inventario.
- **Fotos:** se pueden subir una por una (📷 en el formulario) o **en lote**. En lote, el nombre del archivo debe ser el código, por ejemplo `222.jpg` o `G17.png`. Se comprimen a unos 30 KB y quedan disponibles sin internet en los teléfonos.

## 3. Estructura de datos (IndexedDB y servidor)

| Store | Documento | Notas |
|---|---|---|
| `products` | `{id, code, unitCode, name, presentation, category, subgroup, brand, sellBy, unitsPerBox, boxPrice, unitPrice, stock, sort, active, image}` | `stock` en unidades, o `null` = sin control |
| `sellers` | `{id, name, routes[], aliases[], active}` | los alias enlazan con el Excel ("LUCAS E CHAVEZ" → Lucas Ch.) |
| `clients` | `{id, rif, name, phone, address, group, creditDays, sellerId, route, source}` | `source: 'campo'` = creado por el vendedor en la calle |
| `orders` | `{id, sellerId, clientId, clientName, route, routeDate, status, lines{pid:{cajas, unidades, precios congelados…}}, loadId, noteNumber, officeEdited}` | los precios quedan congelados en cada línea |
| `loads` | `{id, sellerId, route, dispatcherId, status, orderIds[], number, approvedAt, totals{…}, firstNote, lastNote}` | `status`: `espera` \| `aprobada` |
| `config` | `{company, routes[], dispatchers[], rubros[], load{limit, maxClients, measure}, exchangeRate, counters{load, note}}` | un solo documento, compartido por todos los equipos |

El servidor guarda cada documento en `DistDoc` (Prisma/PostgreSQL) con índices por vendedor, fecha y estado.
- Gana la escritura más reciente según `updatedAt`.
- Solo la clave admin puede publicar catálogo, vendedores, cargas y configuración.
- Cada teléfono baja solo su cartera y sus pedidos.

## 4. Exportación a Excel/VBA
- **Copiar para Excel:** texto con tabuladores, se pega directo con Ctrl+V.
- **CSV:** usa `;` y coma decimal, con BOM UTF-8 para que se vean las tildes.
- Encabezado fijo: `CODIGO | PRODUCTO | PRESENTACION | UM | <clientes> | TOTAL`. Las filas de totales llevan en la primera columna las claves `TOTAL_CAJAS`, `TOTAL_UNIDADES`, `TOTAL_BULTOS` y `TOTAL_USD`.
- Los nombres de cliente que empiezan con `= + - @` se exportan con un `'` delante, para que Excel no los tome como fórmula.

## 5. Despliegue
Ver el [README](../README.md). Al publicar cambios en `public/pedidos`, sube `CACHE_VERSION` en `sw.js`.

## 6. Límites conocidos
- Los números de carga y de nota los asigna el equipo que aprueba. Si dos PCs aprueban a la vez sin haber sincronizado, podrían repetir número. Recomendación: aprobar desde una sola PC.
- El stock que ve el vendedor no descuenta lo que ya está en hojas pendientes de aprobar; los faltantes se ven en la oficina.
- `vendor/xlsx.full.min.js` es SheetJS 0.18.5, la última versión en npm, y tiene avisos de seguridad conocidos. Solo lo usa la oficina, para leer archivos propios. Conviene actualizarlo a 0.20.x desde cdn.sheetjs.com cuando sea posible.
