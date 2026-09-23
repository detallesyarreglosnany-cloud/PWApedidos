/* =========================================================================
 * importer.js — Lectura de Excel/CSV (xls, xlsx, csv) y normalización
 *
 * - SheetJS se carga solo al importar (no pesa en los teléfonos).
 * - Detecta la fila de encabezados aunque el reporte traiga títulos arriba.
 * - Adivina columnas por sinónimos; la oficina confirma en un diálogo.
 * - Clasifica productos por rubro y separa la presentación del nombre.
 * ========================================================================= */
(function (global) {
  'use strict';

  const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z0-9%]+/g, ' ').trim();

  let xlsxPromise = null;
  function loadXLSX() {
    if (global.XLSX) return Promise.resolve(global.XLSX);
    if (!xlsxPromise) {
      xlsxPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = './vendor/xlsx.full.min.js';
        s.onload = () => resolve(global.XLSX);
        s.onerror = () => { xlsxPromise = null; reject(new Error('No se pudo cargar el lector de Excel')); };
        document.head.appendChild(s);
      });
    }
    return xlsxPromise;
  }

  const FIELDS = {
    products: [
      ['code', 'Código *', ['CODIGO', 'COD', 'CODIGO PRODUCTO', 'REFERENCIA', 'SKU', 'COD ARTICULO']],
      ['name', 'Nombre / descripción *', ['NOMBRE', 'DESCRIPCION', 'PRODUCTO', 'ARTICULO', 'DESCRIPCION PRODUCTO']],
      ['presentation', 'Presentación / gramaje', ['PRESENTACION', 'GRAMAJE', 'TAMANO', 'CONTENIDO', 'MEDIDA']],
      ['category', 'Categoría (REF)', ['REF', 'RUBRO', 'CATEGORIA', 'DEPARTAMENTO', 'LINEA', 'FAMILIA', 'GRUPO']],
      ['brand', 'Marca', ['MARCA', 'FABRICANTE']],
      ['unitsPerBox', 'Unidades por caja', ['UND X CAJA', 'UNIDADES POR CAJA', 'UNID X CAJA', 'EMPAQUE', 'UNIDADES X BULTO', 'UND X BULTO', 'CAJA X', 'CONTENIDO CAJA', 'UNIDADES']],
      ['unitPrice', 'Precio unidad $', ['PRECIO UNIDAD', 'PRECIO UNITARIO', 'PRECIO DETAL', 'PRECIO UND', 'PRECIO']],
      ['boxPrice', 'Precio caja $', ['PRECIO CAJA', 'PRECIO BULTO', 'PRECIO MAYOR', 'PRECIO X CAJA']],
      ['stock', 'Stock / existencia', ['STOCK UNIDADES', 'STOCK', 'EXISTENCIA', 'EXISTENCIAS', 'DISPONIBLE', 'INVENTARIO', 'CANTIDAD']],
      ['sellBy', 'Venta (caja/unidad)', ['VENTA', 'UNIDAD DE VENTA', 'TIPO', 'UNIDAD VENTA', 'TIPO VENTA', 'UM']],
      ['active', 'Activo (SI/NO)', ['ACTIVO', 'ESTATUS', 'ESTADO']],
    ],
    clients: [
      ['rif', 'RIF / C.I. *', ['RIF', 'CEDULA', 'CI', 'RIF CI', 'DOCUMENTO']],
      ['name', 'Nombre *', ['NOMBRE', 'RAZON SOCIAL', 'CLIENTE']],
      ['phone', 'Teléfono', ['TELEFONOS', 'TELEFONO', 'TLF', 'CELULAR']],
      ['seller', 'Vendedor', ['VENDEDOR', 'ASESOR']],
      ['creditDays', 'Días de crédito', ['DIAS CREDITO', 'CREDITO']],
      ['group', 'Grupo / tipo', ['GRUPO', 'TIPO CLIENTE', 'SEGMENTO']],
      ['address', 'Dirección', ['DIRECCION', 'DOMICILIO']],
      ['route', 'Ruta / zona', ['RUTA', 'ZONA', 'SECTOR']],
    ],
  };

  /** Lee el archivo y devuelve { headers, rows } (rows = arrays de texto). */
  async function readFile(file) {
    const name = file.name.toLowerCase();
    let matrix;
    if (/\.(csv|txt)$/.test(name)) {
      matrix = parseCSV(await file.text());
    } else {
      const XLSX = await loadXLSX();
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
      const ws = wb.Sheets[wb.SheetNames[0]];
      matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: false });
    }
    matrix = matrix.map((r) => r.map((c) => String(c == null ? '' : c).trim()));
    // Fila de encabezados = la que más coincide con sinónimos conocidos (en las 15 primeras)
    const known = new Set([].concat(...Object.values(FIELDS).map((f) => [].concat(...f.map((x) => x[2])))));
    let best = 0, bestScore = -1;
    matrix.slice(0, 15).forEach((r, i) => {
      const score = r.filter((c) => known.has(norm(c))).length;
      if (score > bestScore) { best = i; bestScore = score; }
    });
    const headers = matrix[best] || [];
    const rows = matrix.slice(best + 1).filter((r) => r.some((c) => c));
    return { headers, rows };
  }

  function parseCSV(text) {
    text = text.replace(/^\uFEFF/, '');
    const first = text.split(/\r?\n/)[0];
    const sep = [';', '\t', ','].sort((a, b) => first.split(b).length - first.split(a).length)[0];
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === sep) { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += c;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  /** { field: índiceDeColumna | -1 } adivinado por sinónimos. */
  function guess(kind, headers) {
    const H = headers.map(norm);
    const used = new Set(), out = {};
    FIELDS[kind].forEach(([key, , syn]) => {
      let idx = -1;
      for (const s of syn) { const i = H.findIndex((h, j) => !used.has(j) && h === s); if (i >= 0) { idx = i; break; } }
      if (idx < 0) for (const s of syn) { const i = H.findIndex((h, j) => !used.has(j) && h.includes(s)); if (i >= 0) { idx = i; break; } }
      if (idx >= 0) used.add(idx);
      out[key] = idx;
    });
    return out;
  }

  /* ----------------------- Normalización de productos ----------------------- */

  /**
   * Columna REF del sistema administrativo → categoría (familia).
   *   "REF 2" / "REF 1,5" → REFRESCOS · "CONF CHOWI" → CONFITERIA (subgrupo CHOWI)
   *   "GALLETAS" / "TIP TOP" → GALLETA · "SALSA X UN" → SALSA · "MORENA" → CERVEZA
   */
  function categoryFromRef(ref) {
    const r = norm(ref);
    if (!r) return { category: '', subgroup: '' };
    const parts = r.split(' '), w = parts[0];
    if (w === 'REF') return { category: 'REFRESCOS', subgroup: '' };
    if (w === 'CONF' || w === 'CONFI') return { category: 'CONFITERIA', subgroup: parts.length > 1 ? parts[parts.length - 1] : '' };
    if (w === 'GALLETA' || w === 'GALLETAS') return { category: 'GALLETA', subgroup: '' };
    if (r === 'TIP TOP') return { category: 'GALLETA', subgroup: 'TIP TOP' };
    if (w === 'MORENA') return { category: 'CERVEZA', subgroup: '' };
    return { category: w, subgroup: '' };
  }

  // Solo si el archivo NO trae categoría: se deduce del nombre con los mismos nombres de familia.
  const RUBRO_RULES = [
    ['LICOR', /\b(WHISKY|WHISKEY|ANIS|RON|VODKA|GINEBRA|TEQUILA|VINO|LICOR|TOXICA|PAMPERO|SANGRIA)\b/],
    ['MALTA', /\b(MALTA|MALTIN)\b/],
    ['CERVEZA', /\b(CERVEZA|ZULIA|CARDENAL|POLAR)\b/],
    ['NECTAR', /\b(NECTAR|KAITO)\b/],
    ['JUGO', /\b(JUGO|DEL VALLE)\b/],
    ['AGUA', /\b(AGUA|NEVADA|MINALBA)\b/],
    ['SODA', /\b(SODA|SCHWEPPES)\b/],
    ['REFRESCOS', /\b(REFRESCO|COCA|COCACOLA|COLA|FRESCOLITA|CHINOTTO|PEPSI|FANTA|GOLDEN)\b/],
    ['MAYONESA', /\bMAYONESA\b/],
    ['MOSTAZA', /\bMOSTAZA\b/],
    ['SALSA', /\b(SALSA|KETCHUP)\b/],
    ['SARDINA', /\bSARDINA\b/],
    ['MERMELADA', /\bMERMELADA\b/],
    ['GELATINA', /\bGELATINA\b/],
    ['ARROZ', /\bARROZ\b/],
    ['PASTA', /\bPASTA\b/],
    ['GALLETA', /\b(GALLETA|GALLETAS|WAFER|CHARMY|TIP TOP|PASTELITO|PALMERITAS|PANQ)\b/],
    ['CONFITERIA', /\b(PAPA|PAPAS|CHOWI|CHOWUI|COTUFA|COTUFAS|COTUFYS|SALSERITO|SASERITO|YUCA|YUCACHIPS|SURTIDO|CHOCOLATE|CARAMELO|CHUPETA)\b/],
  ];

  function classifyRubro(text) {
    const t = norm(text);
    for (const [rubro, re] of RUBRO_RULES) if (re.test(t)) return rubro;
    return 'OTROS';
  }

  // "COCA COLA 2LT X 6" → presentación "2 L"; "SALSA PIZZA 340GR" → "340 g"
  const PRES_RE = /(\d+(?:[.,]\d+)?)\s*(ML|LTS?|LITROS?|L|GRS?|GRAMOS|G|KGS?|KILOS?|K|CC|OZ)\b/i;
  function splitPresentation(name) {
    const m = String(name).match(PRES_RE);
    if (!m) return { name: String(name).trim(), presentation: '' };
    let unit = m[2].toUpperCase();
    unit = /^L/.test(unit) ? 'L' : /^(G|GR)/.test(unit) ? 'g' : /^K/.test(unit) ? 'kg' : unit === 'CC' ? 'ml' : unit.toLowerCase();
    const presentation = m[1].replace('.', ',') + ' ' + unit;
    const clean = String(name).replace(m[0], ' ').replace(/\s{2,}/g, ' ').trim();
    return { name: clean || String(name).trim(), presentation };
  }

  /** "12", "X12", "CAJA X 24" → 12 / 24. */
  function parseUPB(v) {
    const m = String(v || '').match(/(\d+)/);
    return m ? Math.max(1, parseInt(m[1], 10)) : 0;
  }

  function parseSellBy(v) {
    const t = norm(v);
    if (!t) return '';
    if (/AMBOS|MIXTO/.test(t)) return 'ambos';
    if (/CAJA|BULTO|CJ|BTO|PAQ/.test(t)) return 'caja';
    if (/UNID|UND|UN\b|DETAL/.test(t)) return 'unidad';
    return '';
  }

  global.Importer = { FIELDS, readFile, guess, classifyRubro, categoryFromRef, splitPresentation, parseUPB, parseSellBy, parseCSV, norm };
})(window);
