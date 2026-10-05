/* BPL CCTV Layout — minimal .xlsx reader (no dependencies; works in the browser and in Node for tests)
   Reads sheet names and, per sheet, each cell's text + fill colour + merged ranges. Nothing leaves the device. */
(function (root) {
  const dec = new TextDecoder();
  const u16 = (b, o) => b[o] | (b[o + 1] << 8), u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

  // ---------- zip ----------
  function entries(buf) {
    const b = new Uint8Array(buf); let e = b.length - 22;
    while (e >= 0 && u32(b, e) !== 0x06054b50) e--;
    if (e < 0) throw new Error('ไม่ใช่ไฟล์ .xlsx');
    const out = {}; let p = u32(b, e + 16);
    for (let n = u16(b, e + 10); n > 0; n--) {
      const method = u16(b, p + 10), size = u32(b, p + 20), nl = u16(b, p + 28), xl = u16(b, p + 30), cl = u16(b, p + 32), off = u32(b, p + 42);
      out[dec.decode(b.subarray(p + 46, p + 46 + nl))] = { method, size, off };
      p += 46 + nl + xl + cl;
    }
    return { b, files: out };
  }
  async function read(zip, name) {
    const f = zip.files[name]; if (!f) return '';
    const b = zip.b, start = f.off + 30 + u16(b, f.off + 26) + u16(b, f.off + 28), data = b.subarray(start, start + f.size);
    if (f.method === 0) return dec.decode(data);
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  }

  // ---------- xml helpers (regex: the sheets are megabytes of flat <c> elements) ----------
  const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
  const attr = (tag, name) => { const m = new RegExp('\\b' + name + '="([^"]*)"').exec(tag); return m ? unesc(m[1]) : ''; };
  const texts = xml => { let s = '', m; const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g; while ((m = re.exec(xml))) s += unesc(m[1]); return s; };
  const colNo = s => { let n = 0; for (let i = 0; i < s.length; i++) n = n * 26 + s.charCodeAt(i) - 64; return n - 1; };
  const ref = r => { const m = /^([A-Z]+)(\d+)$/.exec(r); return m ? [colNo(m[1]), +m[2] - 1] : null; };

  // ---------- workbook ----------
  async function open(buf) {
    const zip = entries(buf);
    const wb = await read(zip, 'xl/workbook.xml'), rels = await read(zip, 'xl/_rels/workbook.xml.rels');
    const target = {}; (rels.match(/<Relationship\b[^>]*>/g) || []).forEach(t => target[attr(t, 'Id')] = attr(t, 'Target'));
    const sheets = (wb.match(/<sheet\b[^>]*>/g) || []).map(t => ({ name: attr(t, 'name'), hidden: !!attr(t, 'state'), path: 'xl/' + (target[attr(t, 'r:id')] || '').replace(/^\/?xl\//, '') }));

    let strings = null, fills = null;
    async function shared() {
      if (strings) return strings;
      const xml = await read(zip, 'xl/sharedStrings.xml'); strings = [];
      const re = /<si>([\s\S]*?)<\/si>|<si\/>/g; let m;
      while ((m = re.exec(xml))) strings.push(m[1] ? texts(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '')) : '');
      return strings;
    }
    // style index -> fill colour ('' | 'yellow' | 'RRGGBB')
    async function styles() {
      if (fills) return fills;
      const xml = await read(zip, 'xl/styles.xml');
      const fillList = ((/<fills\b[\s\S]*?<\/fills>/.exec(xml) || [''])[0].match(/<fill>[\s\S]*?<\/fill>|<fill\/>/g) || []).map(f => {
        const fg = /<fgColor\b[^>]*>/.exec(f); if (!fg || /patternType="none"/.test(f)) return '';
        const rgb = attr(fg[0], 'rgb'); if (rgb) return rgb.slice(-6).toUpperCase();
        return attr(fg[0], 'indexed') === '13' || attr(fg[0], 'indexed') === '5' ? 'FFFF00' : attr(fg[0], 'theme') ? 'theme' : '';
      });
      const xfs = (/<cellXfs\b[\s\S]*?<\/cellXfs>/.exec(xml) || [''])[0].match(/<xf\b[^>]*>/g) || [];
      fills = xfs.map(x => fillList[+attr(x, 'fillId')] || '');
      return fills;
    }
    // -> { cols, rows, cells: [{ x, y, t, fill }], merges: [{ x, y, w, h }] }
    async function sheet(i) {
      const xml = await read(zip, sheets[i].path), ss = await shared(), fl = await styles();
      const cells = []; let cols = 0, rows = 0, m;
      const re = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      while ((m = re.exec(xml))) {
        const p = ref(attr(m[1], 'r')); if (!p) continue;
        const type = attr(m[1], 't'), body = m[2] || '', v = /<v>([\s\S]*?)<\/v>/.exec(body);
        const t = (type === 's' ? (v ? ss[+v[1]] || '' : '') : type === 'inlineStr' ? texts(body) : v ? unesc(v[1]) : '').trim();
        const fill = fl[+attr(m[1], 's') || 0] || '';
        if (!t && !fill) continue;
        cells.push({ x: p[0], y: p[1], t, fill }); cols = Math.max(cols, p[0] + 1); rows = Math.max(rows, p[1] + 1);
      }
      const merges = (xml.match(/<mergeCell\b[^>]*>/g) || []).map(t => { const [a, b] = attr(t, 'ref').split(':').map(ref); return a && b ? { x: a[0], y: a[1], w: b[0] - a[0] + 1, h: b[1] - a[1] + 1 } : null; }).filter(Boolean);
      return { name: sheets[i].name, cols, rows, cells, merges };
    }
    return { sheets, sheet };
  }

  // Sheet cells -> elements at sheet coordinates. Text rules are BPL.parseSheet's (same as pasting from Sheets);
  // the file adds what a paste loses: merged-cell sizes, fill colours and camera numbers stored as numbers.
  function toElements(sh) {
    const grid = [], fillAt = {}, mergeAt = {}, at = (x, y) => x + ',' + y;
    sh.merges.forEach(m => mergeAt[at(m.x, m.y)] = m);
    sh.cells.forEach(c => {
      const colored = c.fill && c.fill !== 'FFFFFF' && c.fill !== 'theme'; if (colored) fillAt[at(c.x, c.y)] = c.fill;
      let t = c.t.replace(/\r?\n/g, '\u2028').replace(/\t/g, ' ');
      if (/^\d{1,2}$/.test(t) && colored && t !== '0') t = t.padStart(3, '0');
      if (/^[-.0\s]*$/.test(t) || /^#(N\/A|REF!|VALUE!)/.test(t)) return;
      (grid[c.y] = grid[c.y] || [])[c.x] = t;
    });
    const tsv = Array.from({ length: sh.rows }, (_, y) => Array.from({ length: sh.cols }, (_, x) => (grid[y] && grid[y][x]) || '').join('\t')).join('\n');
    const els = root.BPL.parseSheet(tsv, 0, 0);
    els.forEach(e => {
      const m = mergeAt[at(e.x, e.y)], fill = fillAt[at(e.x, e.y)];
      if (e.type === 'conveyor') {
        let w = 1; while (fill && fillAt[at(e.x + w, e.y)] === fill && !(grid[e.y] && grid[e.y][e.x + w])) w++;
        if (m && m.w > 1) e.w = m.w; else if (w > 1) e.w = w;
      } else if (e.type === 'dock' && m) { e.w = m.w; e.h = m.h; }
      else if (e.type === 'text' && m) { e.w = m.w; e.h = m.h; if (fill) Object.assign(e, { type: 'zone', tone: 'outline' }), delete e.size; }
    });
    // a camera written under several cells is still one camera: keep its first position
    const seen = new Set();
    return els.filter(e => e.type !== 'cam' || (!seen.has(e.no) && seen.add(e.no)));
  }

  root.BPLXlsx = { open, toElements };
})(typeof window !== 'undefined' ? window : globalThis);
