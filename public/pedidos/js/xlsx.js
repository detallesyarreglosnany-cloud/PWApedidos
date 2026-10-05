/* =========================================================================
 * xlsx.js — Escritor de archivos Excel (.xlsx) sin dependencias.
 *
 * Un .xlsx es un zip de XML: aquí se arma a mano (zip sin comprimir) para
 * poder dar formato (colores, bordes, texto girado, anchos, paneles
 * inmovilizados, filtros, impresión horizontal) y escribir FÓRMULAS con su
 * valor ya calculado. Las celdas vacías quedan vacías (no «0»).
 *
 *   XlsxOut.build([{ name, rows, widths, freeze, merges, heights, filter, landscape }]) → Uint8Array
 *
 * rows = filas de celdas. Cada celda puede ser:
 *   · texto, número, null/''  (vacía)
 *   · { v, f, s }  v = valor (o valor calculado si hay fórmula), f = fórmula SIN «=», s = estilo
 *   · { d: 'AAAA-MM-DD', s }  fecha real de Excel
 * Estilo s: { b, i, color, fill, size, align:'left|center|right', valign, wrap, rot:90, fmt:'int|money|usd|date|text|pct', border:true }
 * ========================================================================= */
(function (global) {
  'use strict';

  const enc = new TextEncoder();
  const bytes = (s) => enc.encode(s);

  /* ------------------------------ zip (sin comprimir) ------------------------------ */
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (u8) => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

  function zip(files) {
    const chunks = [], central = [];
    let offset = 0;
    const u16 = (v) => new Uint8Array([v & 255, (v >> 8) & 255]);
    const u32 = (v) => new Uint8Array([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]);
    const cat = (...a) => { const n = a.reduce((x, y) => x + y.length, 0), o = new Uint8Array(n); let p = 0; a.forEach((y) => { o.set(y, p); p += y.length; }); return o; };
    const now = new Date(), dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1), dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    files.forEach((f) => {
      const name = bytes(f.name), data = f.data, crc = crc32(data);
      const local = cat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data);
      central.push(cat(u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name));
      chunks.push(local); offset += local.length;
    });
    const cdSize = central.reduce((a, c) => a + c.length, 0);
    return cat(...chunks, ...central, u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cdSize), u32(offset), u16(0));
  }

  /* ------------------------------ utilidades XML ------------------------------ */
  // Caracteres no válidos en XML 1.0 se quitan; el resto se escapa
  const esc = (v) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const colName = (n) => { let s = ''; n += 1; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
  const ref = (r, c) => colName(c) + (r + 1);
  const serial = (iso) => { const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) + 25569 : null; };

  /* ------------------------------ estilos ------------------------------ */
  const FMT = { int: 3, money: 4, text: 0, date: 14, general: 0 };
  function makeStyles() {
    const fonts = ['<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'];
    const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
    const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>',
      '<border><left style="thin"><color rgb="FF8A8A8A"/></left><right style="thin"><color rgb="FF8A8A8A"/></right><top style="thin"><color rgb="FF8A8A8A"/></top><bottom style="thin"><color rgb="FF8A8A8A"/></bottom><diagonal/></border>'];
    const custom = [{ code: '"$"#,##0.00', id: 164 }, { code: '0%', id: 165 }];
    const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
    const idx = new Map();
    const index = (arr, xml) => { const i = arr.indexOf(xml); if (i >= 0) return i; arr.push(xml); return arr.length - 1; };
    const argb = (c) => 'FF' + String(c).replace('#', '').toUpperCase();
    function get(s) {
      if (!s) return 0;
      const key = JSON.stringify(s);
      if (idx.has(key)) return idx.get(key);
      const font = `<font>${s.b ? '<b/>' : ''}${s.i ? '<i/>' : ''}<sz val="${s.size || 11}"/>${s.color ? `<color rgb="${argb(s.color)}"/>` : ''}<name val="Calibri"/><family val="2"/></font>`;
      const fontId = index(fonts, font);
      const fillId = s.fill ? index(fills, `<fill><patternFill patternType="solid"><fgColor rgb="${argb(s.fill)}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
      const borderId = s.border ? 1 : 0;
      const numFmtId = s.fmt === 'usd' ? 164 : s.fmt === 'pct' ? 165 : (FMT[s.fmt] || 0);
      const al = (s.align || s.valign || s.wrap || s.rot) ? `<alignment${s.align ? ` horizontal="${s.align}"` : ''} vertical="${s.valign || (s.rot ? 'bottom' : 'center')}"${s.wrap ? ' wrapText="1"' : ''}${s.rot ? ` textRotation="${s.rot}"` : ''}/>` : '';
      const xf = `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"${numFmtId ? ' applyNumberFormat="1"' : ''} applyFont="1"${fillId ? ' applyFill="1"' : ''}${borderId ? ' applyBorder="1"' : ''}${al ? ' applyAlignment="1">' + al + '</xf>' : '/>'}`;
      xfs.push(xf); idx.set(key, xfs.length - 1);
      return xfs.length - 1;
    }
    const xml = () => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="${custom.length}">${custom.map((c) => `<numFmt numFmtId="${c.id}" formatCode="${esc(c.code)}"/>`).join('')}</numFmts>
<fonts count="${fonts.length}">${fonts.join('')}</fonts><fills count="${fills.length}">${fills.join('')}</fills><borders count="${borders.length}">${borders.join('')}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
    return { get, xml };
  }

  /* ------------------------------ hoja ------------------------------ */
  function sheetXml(sh, st) {
    const rows = sh.rows || [];
    let maxC = 0;
    const out = [];
    rows.forEach((row, r) => {
      if (!row) return;
      const cells = [];
      row.forEach((cell, c) => {
        if (cell === null || cell === undefined || cell === '') return;
        const o = typeof cell === 'object' && !Array.isArray(cell) ? cell : { v: cell };
        const sid = st.get(o.s);
        const a = ref(r, c);
        maxC = Math.max(maxC, c + 1);
        if (o.d) { const n = serial(o.d); cells.push(n == null ? `<c r="${a}" s="${sid}" t="inlineStr"><is><t>${esc(o.d)}</t></is></c>` : `<c r="${a}" s="${st.get({ ...(o.s || {}), fmt: 'date' })}"><v>${n}</v></c>`); return; }
        if (o.f) {
          const isNum = typeof o.v === 'number' && Number.isFinite(o.v);
          cells.push(`<c r="${a}" s="${sid}"${isNum ? '' : ' t="str"'}><f>${esc(String(o.f).replace(/^=/, ''))}</f>${o.v === undefined || o.v === null ? '' : `<v>${isNum ? o.v : esc(o.v)}</v>`}</c>`);
          return;
        }
        if (typeof o.v === 'number' && Number.isFinite(o.v)) { cells.push(`<c r="${a}" s="${sid}"><v>${o.v}</v></c>`); return; }
        if (o.v === null || o.v === undefined || o.v === '') { if (o.s) cells.push(`<c r="${a}" s="${sid}"/>`); return; }
        cells.push(`<c r="${a}" s="${sid}" t="inlineStr"><is><t xml:space="preserve">${esc(o.v)}</t></is></c>`);
      });
      const h = (sh.heights || {})[r];
      if (cells.length || h) out.push(`<row r="${r + 1}"${h ? ` ht="${h}" customHeight="1"` : ''}>${cells.join('')}</row>`);
    });
    const widths = sh.widths || [];
    const cols = widths.length ? `<cols>${widths.map((w, i) => (w ? `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>` : '')).join('')}</cols>` : '';
    const fr = sh.freeze;
    const pane = fr && (fr.r || fr.c) ? `<sheetViews><sheetView workbookViewId="0"${sh.first ? ' tabSelected="1"' : ''}><pane${fr.c ? ` xSplit="${fr.c}"` : ''}${fr.r ? ` ySplit="${fr.r}"` : ''} topLeftCell="${ref(fr.r || 0, fr.c || 0)}" activePane="${fr.r && fr.c ? 'bottomRight' : fr.r ? 'bottomLeft' : 'topRight'}" state="frozen"/></sheetView></sheetViews>`
      : `<sheetViews><sheetView workbookViewId="0"${sh.first ? ' tabSelected="1"' : ''}/></sheetViews>`;
    const merges = (sh.merges || []).length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
    const filter = sh.filter ? `<autoFilter ref="${sh.filter}"/>` : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr>${sh.tab ? `<tabColor rgb="FF${String(sh.tab).replace('#', '')}"/>` : ''}<pageSetUpPr fitToPage="1"/></sheetPr>${pane}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${out.join('')}</sheetData>${filter}${merges}<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup orientation="${sh.landscape === false ? 'portrait' : 'landscape'}" fitToWidth="1" fitToHeight="0"/></worksheet>`;
  }

  const safeName = (n, i) => (String(n || 'Hoja' + (i + 1)).replace(/[\[\]:*?\/\\]/g, ' ').trim().slice(0, 31) || 'Hoja' + (i + 1));

  /** Arma el libro y devuelve los bytes del .xlsx. */
  function build(sheets) {
    const st = makeStyles();
    const used = new Set();
    const names = sheets.map((s, i) => { let n = safeName(s.name, i), k = 2; while (used.has(n.toLowerCase())) n = safeName(s.name, i).slice(0, 28) + ' ' + k++; used.add(n.toLowerCase()); return n; });
    sheets.forEach((s, i) => { s.first = i === 0; });
    const sheetXmls = sheets.map((s) => sheetXml(s, st));
    const files = [
      { name: '[Content_Types].xml', data: bytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`) },
      { name: '_rels/.rels', data: bytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
      { name: 'xl/workbook.xml', data: bytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`) },
      { name: 'xl/_rels/workbook.xml.rels', data: bytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) },
      ...sheetXmls.map((x, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: bytes(x) })),
    ];
    files.push({ name: 'xl/styles.xml', data: bytes(st.xml()) }); // los estilos se arman al recorrer las hojas
    return zip(files);
  }

  global.XlsxOut = { build, colName, ref, esc, MIME: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
})(typeof window !== 'undefined' ? window : globalThis);
