/* BPL CCTV Layout — shared store (layout in localStorage, CCTV captures in IndexedDB) */
(function () {
  const CW = 64, CH = 22, LS = 'bpl.layout.v1';
  const uid = () => Math.random().toString(36).slice(2, 10);
  const C = s => { let n = 0; for (const ch of s) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
  const colName = x => { let n = Math.floor(x) + 1, s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  const seq = (a, b, s = 1) => { const r = []; for (let i = a; i <= b; i += s) r.push(i); return r; };

  // the real layout lives in the private data repo; this is only the blank sheet
  function defaultLayout() { return paper({ name: 'BPL Layout CCTV', cols: 92, rows: 92, elements: [], updated: 0 }); }
  // white paper with free margin on every side for future outer layout
  function paper(l) {
    if (!l || l.paper) return l;
    const dx = 44, dy = 30;
    return Object.assign({}, l, { elements: (l.elements || []).map(e => Object.assign({}, e, { x: e.x + dx, y: e.y + dy })), cols: Math.max(180, (l.cols || 92) + dx * 2), rows: Math.max(150, (l.rows || 92) + dy * 2), ox: dx, oy: dy, paper: true });
  }

  // ---------- persistence ----------
  const bc = 'BroadcastChannel' in window ? new BroadcastChannel('bpl-layout') : null;
  function load() { try { const s = localStorage.getItem(LS); if (s) return paper(JSON.parse(s)); } catch (e) {} return defaultLayout(); }
  function save(l) { localStorage.setItem(LS, JSON.stringify(l)); bc && bc.postMessage({ t: 'layout' }); }
  function onChange(cb) { bc && bc.addEventListener('message', e => cb(e.data)); window.addEventListener('storage', e => { if (e.key === LS) cb({ t: 'layout' }); }); }

  let _db;
  const db = () => _db || (_db = new Promise((res, rej) => { const r = indexedDB.open('bpl-cctv', 1); r.onupgradeneeded = () => r.result.createObjectStore('imgs'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
  const store = async mode => (await db()).transaction('imgs', mode).objectStore('imgs');
  const wrap = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const img = {
    async all() { const s = await store('readonly'); const [k, v] = await Promise.all([wrap(s.getAllKeys()), wrap((await store('readonly')).getAll())]); const o = {}; k.forEach((key, i) => o[key] = v[i]); return o; },
    async set(no, val) { await wrap((await store('readwrite')).put(val, no)); bc && bc.postMessage({ t: 'img' }); },
    async del(no) { await wrap((await store('readwrite')).delete(no)); bc && bc.postMessage({ t: 'img' }); },
    async clear() { await wrap((await store('readwrite')).clear()); },
  };
  function compress(file, max = 1600) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => { const im = new Image(); im.onload = () => { const k = Math.min(1, max / im.width); const c = document.createElement('canvas'); c.width = Math.round(im.width * k); c.height = Math.round(im.height * k); c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); res(c.toDataURL('image/jpeg', 0.82)); }; im.onerror = rej; im.src = fr.result; };
      fr.onerror = rej; fr.readAsDataURL(file);
    });
  }
  async function exportFile(layout) {
    const images = await img.all();
    const blob = new Blob([JSON.stringify({ app: 'bpl-cctv-layout', version: 1, layout, images })], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    const d = new Date(); a.download = 'bpl-layout-' + d.toISOString().slice(0, 10) + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  async function importFile(file) {
    const data = JSON.parse(await file.text());
    if (!data.layout || !Array.isArray(data.layout.elements)) throw new Error('ไฟล์ไม่ถูกต้อง');
    data.layout = paper(data.layout); save(data.layout);
    if (data.images) { await img.clear(); for (const k of Object.keys(data.images)) await img.set(k, data.images[k]); }
    return data.layout;
  }

  // ---------- geometry ----------
  const center = e => [(e.x + e.w / 2) * CW, (e.y + e.h / 2) * CH];
  function covers(c, px, py) {
    const [cx, cy] = center(c), dx = px - cx, dy = py - cy, d = Math.hypot(dx, dy);
    if (d > (c.range || 0)) return false; if (d < 1) return true;
    let a = Math.atan2(dy, dx) * 180 / Math.PI - (c.dir || 0); a = ((a % 360) + 540) % 360 - 180;
    return Math.abs(a) <= (c.fov || 60) / 2;
  }
  const probe = e => [[.5, .5], [.5, .12], [.5, .88], [.12, .5], [.88, .5]].map(([u, v]) => [(e.x + e.w * u) * CW, (e.y + e.h * v) * CH]);
  function camsFor(el, els) {
    if (el.cams && String(el.cams).trim()) { const nos = String(el.cams).split(/[\s,]+/).filter(Boolean); return els.filter(e => e.type === 'cam' && nos.includes(e.no)); }
    const pts = probe(el), [ex, ey] = center(el), dist = c => { const [x, y] = center(c); return Math.hypot(x - ex, y - ey); };
    let r = els.filter(c => c.type === 'cam' && pts.some(p => covers(c, p[0], p[1])));
    if (!r.length) r = els.filter(c => c.type === 'cam' && dist(c) < 220).sort((a, b) => dist(a) - dist(b)).slice(0, 3);
    return r.sort((a, b) => dist(a) - dist(b));
  }
  const seenBy = (cam, els) => els.filter(e => ['drop', 'dock', 'conveyor', 'slide', 'door', 'zone'].includes(e.type) && (e.type !== 'zone' || e.pattern === 'room') && probe(e).some(p => covers(cam, p[0], p[1])));
  function cone(c) {
    const [cx, cy] = center(c), r = c.range || 100;
    if ((c.fov || 60) >= 359) return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
    const f = Math.min(c.fov || 60, 359), a1 = ((c.dir || 0) - f / 2) * Math.PI / 180, a2 = ((c.dir || 0) + f / 2) * Math.PI / 180;
    return `M${cx} ${cy}L${cx + r * Math.cos(a1)} ${cy + r * Math.sin(a1)}A${r} ${r} 0 ${f > 180 ? 1 : 0} 1 ${cx + r * Math.cos(a2)} ${cy + r * Math.sin(a2)}Z`;
  }

  // ---------- render ----------
  const YEL = 'oklch(0.89 0.15 96)', YEL_D = 'oklch(0.66 0.13 88)';
  const ORDER = { zone: 0, shape: 1, wall: 2, door: 2, dock: 2, slide: 3, conveyor: 3, drop: 4, barrow: 5, line: 5, curve: 5, text: 6, pillar: 6, pin: 7, cam: 8 };
  const DEFZ = { zone: 1, shape: 1, wall: 2, door: 2, dock: 2, pillar: 2, slide: 3, conveyor: 3, drop: 3, barrow: 4, line: 4, curve: 4, text: 4, pin: 5, cam: 5 };
  const zOf = e => +e.z || DEFZ[e.type] || 3;
  const ARROW = { r: '→', l: '←', u: '↑', d: '↓' };
  const V = (n, d) => `var(--${n}, ${d})`;
  const ACC = V('color-accent', '#ec3013'), INK = V('cell-ink', '#201e1d'), SEL = V('sel', '#ec3013');
  const _mc = document.createElement('canvas').getContext('2d'), _mw = {};
  const emWidth = t => { t = String(t || ''); if (!t) return 1; if (_mw[t] == null) { _mc.font = '800 100px Archivo, "IBM Plex Sans Thai", system-ui, sans-serif'; _mw[t] = _mc.measureText(t).width / 100 * 1.06; } return Math.max(0.6, _mw[t]); };
  const fitFs = (t, w, h, max) => Math.max(5, Math.min(max, h * 0.8, (w - 1) / emWidth(t)));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { for (const k in _mw) delete _mw[k]; window.dispatchEvent(new Event('bpl-fonts')); });
  const primaryKey = e => e.type === 'drop' ? 'branch' : e.type === 'cam' ? 'no' : 'label';
  function head(tx, ty, fx, fy, s) { const a = Math.atan2(ty - fy, tx - fx), p = k => [tx - s * Math.cos(a + k), ty - s * Math.sin(a + k)].map(v => v.toFixed(1)).join(','); return `${tx.toFixed(1)},${ty.toFixed(1)} ${p(-0.45)} ${p(0.45)}`; }
  function view(e, o) {
    const W = e.w * CW, H = e.h * CH, wt = e.bold ? 800 : null, tv = e.tdir === 'v', TW = tv ? H : W, TH = tv ? W : H;
    const b = { position: 'absolute', left: e.x * CW, top: e.y * CH, width: W, height: H, boxSizing: 'border-box', overflow: 'hidden', zIndex: zOf(e) * 10 };
    const it = { id: e.id, type: e.type, a: '', b: '', c: '', d: '', title: '', sa: {}, sb: {}, sc: {}, sd: {}, cd: '', cs: {}, hd: '', hd2: '', hs: {} };
    const on = o.sel && o.sel.has(e.id), hl = o.hl && o.hl.has(e.id);
    const line = (fs, w, extra) => Object.assign({ fontSize: fs, lineHeight: 1.1, fontWeight: wt || w, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxInlineSize: '100%' }, extra || {});
    const center = { display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center' };
    let op = (e.op == null ? 100 : +e.op) / 100; if (o.dim && !o.dim.has(e.id)) op *= 0.22; if (op < 1) b.opacity = op;
    if (tv) b.writingMode = 'vertical-rl';
    let simple = false;
    switch (e.type) {
      case 'drop': {
        it.a = e.branch || '—'; it.b = e.fd || ''; it.c = e.chute || ''; it.d = e.code || '';
        const n = 1 + [it.b, it.c, it.d].filter(Boolean).length, fa = fitFs(it.a, TW - 6, TH / n * 1.1, 26);
        Object.assign(b, { background: hl ? ACC : (e.fill || V('cell-bg', '#fff')), color: hl ? '#111' : (e.ink || INK), border: '1px solid ' + V('cell-line', '#201e1d'), display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'space-evenly', padding: '2px', textAlign: 'center' });
        it.sa = line(fa, 800, { textOverflow: 'clip' });
        [['b', it.b], ['c', it.c], ['d', it.d]].forEach(([k, t]) => it['s' + k] = line(Math.min(fa * 0.9, fitFs(t, TW - 6, TH / n, 20)), 600, { opacity: 0.72 }));
        it.title = [e.branch, e.fd, e.chute].filter(Boolean).join(' · ');
        break;
      }
      case 'cam': {
        const has = !!(o.imgs && o.imgs[e.no]), col = e.fill || V('cam', '#ec3013'), act = hl || on, round = e.model === 'dome' || e.model === 'fisheye';
        Object.assign(b, { overflow: 'visible', display: 'flex', alignItems: 'center', justifyContent: 'center', writingMode: 'horizontal-tb' });
        it.m = { background: act ? '#fff' : has ? col : V('cam-empty', '#fff'), color: act ? '#111' : has ? (e.ink || V('cam-ink', '#fff')) : (e.fill || V('cam-empty-ink', '#ae1800')), border: (e.model === 'ptz' ? '3px double ' : '1.5px solid ') + (act ? '#111' : col), borderRadius: round ? 10 : 0, boxShadow: act ? '0 0 0 2px ' + ACC : 'none', fontFamily: 'Archivo, sans-serif', fontWeight: 700, fontSize: 10, lineHeight: '14px', padding: '0 4px', minWidth: 24, textAlign: 'center', whiteSpace: 'nowrap', cursor: 'pointer', fontVariantNumeric: 'tabular-nums' };
        it.a = e.no || '?'; it.title = 'กล้อง ' + (e.no || '?') + (e.name ? ' · ' + e.name : '') + (has ? '' : ' (ยังไม่มีภาพ)');
        break;
      }
      case 'conveyor': {
        const base = e.fill || YEL, vert = e.dir === 'u' || e.dir === 'd';
        Object.assign(b, { background: `repeating-linear-gradient(${vert ? 0 : 90}deg, ${base} 0 14px, rgba(0,0,0,.22) 14px 15px)`, border: '1px solid ' + (e.fill ? 'rgba(0,0,0,.35)' : YEL_D), color: e.ink || '#111', display: 'flex', flexDirection: vert && !tv ? 'column' : 'row', alignItems: 'center', gap: '6px', padding: vert ? '6px 0' : '0 6px', whiteSpace: 'nowrap', justifyContent: e.dir === 'l' || e.dir === 'u' ? 'flex-end' : 'flex-start' });
        if (hl) b.outline = '3px solid ' + SEL;
        it.a = e.label || ''; it.b = ARROW[e.dir] || '→'; it.title = 'สายพาน ' + (e.label || '');
        const fs = Math.min((vert ? W : H) * 0.72, 18);
        it.sa = line(fs, 800, { background: base, padding: '0 3px', letterSpacing: '.03em' }); it.sb = line(fs * 1.15, 800);
        break;
      }
      case 'slide': {
        const base = e.fill || YEL;
        Object.assign(b, center, { background: `linear-gradient(${H > W ? 180 : 90}deg, transparent, ${base})`, border: '1px solid ' + YEL_D, color: e.ink || INK });
        it.a = e.label || ''; it.sa = line(fitFs(it.a, TW - 6, TH, 14), 700); simple = true; break;
      }
      case 'dock': {
        const tall = TH > CH * 1.2; it.a = e.label || ''; it.b = e.hub || '';
        Object.assign(b, { background: hl ? ACC : (e.fill || V('dock-bg', '#eae9e9')), color: hl ? '#111' : (e.ink || INK), border: '2px solid ' + V('cell-line', '#201e1d'), padding: tall ? '4px' : '0 6px', display: 'flex', flexDirection: tall ? 'column' : 'row', alignItems: 'center', justifyContent: 'flex-start', gap: tall ? '4px' : '10px', textAlign: tall ? 'center' : 'left' });
        const fa = tall ? fitFs(it.a, TW - 8, TH * 0.2, 18) : Math.min(TH * 0.7, 14);
        it.sa = line(fa, 800);
        it.sb = tall ? { fontSize: Math.min(fa * 0.9, Math.max(7, Math.sqrt((TW - 8) * TH * 0.5 / Math.max(1, it.b.length)) * 0.95)), lineHeight: 1.15, fontWeight: wt || 500, overflow: 'hidden', wordBreak: 'break-word', opacity: .85 } : line(Math.min(TH * 0.6, 12), 500, { opacity: .85 });
        it.title = [e.label, e.hub].filter(Boolean).join(' · ');
        break;
      }
      case 'door':
        Object.assign(b, center, { border: '2px dashed ' + V('zone-line', '#605d5d'), background: e.fill || 'transparent', color: e.ink || INK });
        it.a = e.label || ''; it.sa = line(fitFs(it.a, TW - 6, TH, 14), 700); simple = true; break;
      case 'wall':
        Object.assign(b, center, { background: e.fill || V('wall', '#201e1d'), color: e.ink || '#fff' });
        it.a = e.label || ''; it.sa = line(fitFs(it.a, Math.max(W, H) - 6, Math.min(W, H), 12), 700, !tv && H > W * 1.6 ? { writingMode: 'vertical-rl' } : {}); simple = true; break;
      case 'zone': {
        const p = e.pattern || 'none';
        const bg = p === 'hatch' ? `repeating-linear-gradient(45deg, color-mix(in srgb, ${e.fill || ACC} 38%, transparent) 0 8px, transparent 8px 16px)`
          : p === 'walk' ? `repeating-linear-gradient(${H > W ? 0 : 90}deg, color-mix(in srgb, ${e.fill || '#7fc8a9'} 30%, transparent) 0 10px, transparent 10px 20px)`
          : p === 'room' ? (e.fill || 'transparent') : (e.fill || V('zone-bg', 'color-mix(in srgb, #d7d3d3 45%, transparent)'));
        const bd = p === 'hatch' ? '2px solid ' + (e.fill || ACC) : p === 'walk' ? '2px dashed ' + (e.fill || '#7fc8a9') : p === 'room' ? '3px solid ' + V('wall', '#201e1d') : '2px solid ' + V('zone-line', '#605d5d');
        Object.assign(b, { border: bd, background: bg, color: e.ink || INK, padding: '2px 5px', display: 'flex', alignItems: p === 'room' ? 'flex-start' : 'center', justifyContent: p === 'room' ? 'flex-start' : 'center', textAlign: 'center' });
        if (hl) b.outline = '3px solid ' + SEL;
        it.a = e.label || ''; it.title = e.label || '';
        it.sa = line(p === 'room' ? Math.min(14, fitFs(it.a, TW - 10, 16, 14)) : fitFs(it.a, TW - 10, TH - 4, 28), 700, p === 'hatch' ? { background: V('map-bg', '#fff'), padding: '0 4px' } : {});
        simple = true; break;
      }
      case 'shape':
        Object.assign(b, center, { border: `${e.thick || 2}px solid ${e.ink || INK}`, background: e.fill || 'transparent', color: e.ink || INK, borderRadius: e.shape === 'ellipse' ? '50%' : 0 });
        it.a = e.label || ''; it.sa = line(fitFs(it.a, TW * 0.8, TH * 0.8, 40), 700); simple = true; break;
      case 'barrow':
        Object.assign(b, center, { background: e.fill || ACC, color: e.ink || '#111', clipPath: e.double ? 'polygon(0 50%,20% 0,20% 27%,80% 27%,80% 0,100% 50%,80% 100%,80% 73%,20% 73%,20% 100%)' : 'polygon(0 27%,68% 27%,68% 0,100% 50%,68% 100%,68% 73%,0 73%)', padding: e.double ? '0 20%' : '0 32% 0 4%', writingMode: 'horizontal-tb' });
        it.a = e.label || ''; it.sa = line(fitFs(it.a, W * (e.double ? 0.58 : 0.62), H * 0.42, 40), 800); simple = true; break;
      case 'pillar':
        Object.assign(b, center, { background: e.fill || V('pillar', '#201e1d'), color: e.ink || V('pillar-ink', '#fff') });
        it.a = e.label || '';
        it.sa = !tv && H > W * 1.6 ? line(fitFs(it.a, H - 4, W, 14), 700, { writingMode: 'vertical-rl' }) : line(fitFs(it.a, TW - 4, TH, 14), 700);
        simple = true; break;
      case 'pin':
        Object.assign(b, center, { overflow: 'visible', writingMode: 'horizontal-tb' });
        it.a = e.label || '';
        it.sa = { minWidth: 22, height: 22, padding: '0 5px', borderRadius: 11, background: e.fill || ACC, color: e.ink || '#111', fontWeight: 800, fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 0 2px ' + V('map-bg', '#fff'), whiteSpace: 'nowrap' };
        it.title = e.note || e.label; simple = true; break;
      case 'line': {
        const col = e.fill || ACC, t = e.thick || 3, hd = !!e.head;
        Object.assign(b, { overflow: 'visible', background: 'transparent', writingMode: 'horizontal-tb' });
        it.sa = { position: 'absolute', left: 0, right: hd ? Math.max(10, t * 3) - 2 : 0, top: '50%', height: t, transform: 'translateY(-50%)', background: col };
        it.sb = { position: 'absolute', right: 0, top: '50%', width: Math.max(10, t * 3), height: Math.max(10, t * 3.2), transform: 'translateY(-50%)', clipPath: 'polygon(0 0,100% 50%,0 100%)', background: col, display: hd ? 'block' : 'none' };
        it.a = e.label || ''; it.sc = { position: 'absolute', left: '50%', bottom: '50%', transform: 'translate(-50%,-4px)', fontSize: 11, fontWeight: wt || 700, color: e.ink || INK, whiteSpace: 'nowrap', background: V('map-bg', '#fff'), padding: '0 3px', display: it.a ? 'block' : 'none' };
        break;
      }
      case 'curve': {
        const col = e.fill || ACC, t = e.thick || 4, P = (u, v) => [u * CW, v * CH];
        const [ax, ay] = P(e.ax || 0, e.ay || 0), [bx, by] = P(e.bx || e.w, e.by || e.h), [qx, qy] = P(e.qx ?? e.w / 2, e.qy ?? 0), hs = Math.max(11, t * 3), hm = e.head || 'end';
        Object.assign(b, { overflow: 'visible', background: 'transparent', writingMode: 'horizontal-tb' });
        it.cd = `M${ax} ${ay}Q${qx} ${qy} ${bx} ${by}`; it.cs = { fill: 'none', stroke: col, strokeWidth: t, strokeLinecap: 'round', pointerEvents: 'stroke' }; it.hs = { fill: col };
        it.hd = hm !== 'none' ? head(bx, by, qx, qy, hs) : ''; it.hd2 = hm === 'both' ? head(ax, ay, qx, qy, hs) : '';
        it.a = e.label || ''; const mx = 0.25 * ax + 0.5 * qx + 0.25 * bx, my = 0.25 * ay + 0.5 * qy + 0.25 * by;
        it.sc = { position: 'absolute', left: mx, top: my, transform: 'translate(-50%,-130%)', fontSize: 11, fontWeight: wt || 700, color: e.ink || INK, whiteSpace: 'nowrap', background: V('map-bg', '#fff'), padding: '0 3px', display: it.a ? 'block' : 'none' };
        break;
      }
      case 'text': {
        it.a = e.label || '';
        Object.assign(b, { overflow: 'visible', display: 'flex', alignItems: 'center', justifyContent: e.align === 'left' ? 'flex-start' : 'center', background: e.fill || 'transparent', color: e.ink || INK });
        const fs = e.fit === false ? (+e.size || 12) : fitFs(it.a, TW - 4, TH, 400);
        it.sa = { fontSize: fs, lineHeight: 1, fontWeight: e.bold ? 800 : 500, whiteSpace: 'nowrap', letterSpacing: '0.01em' };
        simple = true; break;
      }
    }
    if (e.rot && e.type !== 'cam') { b.transform = `rotate(${e.rot}deg)`; b.transformOrigin = 'center'; }
    if (on && e.type !== 'cam') { b.outline = '2px solid ' + SEL; b.outlineOffset = '2px'; b.zIndex = 60; }
    it.box = b; it.isDrop = e.type === 'drop'; it.isCam = e.type === 'cam'; it.isConv = e.type === 'conveyor'; it.isDock = e.type === 'dock'; it.isLine = e.type === 'line'; it.isCurve = e.type === 'curve'; it.isSimple = simple;
    it.isZone = false; it.isPillar = false; it.isText = false;
    if (!o.v2) { it.isZone = simple; it.isSimple = false; }
    it.hasD = !!it.d; it.hasB = !!it.b; it.hasC = !!it.c;
    return it;
  }
  const sorted = els => els.slice().sort((a, b) => (zOf(a) - zOf(b)) || (ORDER[a.type] - ORDER[b.type]));
  function bounds(els) { if (!els.length) return { x: 0, y: 0, w: 10, h: 10 }; let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; els.forEach(e => { x0 = Math.min(x0, e.x); y0 = Math.min(y0, e.y); x1 = Math.max(x1, e.x + e.w); y1 = Math.max(y1, e.y + e.h); }); return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; }

  // ---------- Google Sheets paste import ----------
  function parseSheet(tsv, ox = 0, oy = 0) {
    const rows = tsv.replace(/\r/g, '').split('\n').map(r => r.split('\t'));
    const out = [], parts = {}, isCam = s => /^\d{3}(\s*[,\-]\s*\d{3})*$/.test(s);
    const runRight = (r, c, cap) => { let w = 1; while (w < cap && c + w < rows[r].length && !(rows[r][c + w] || '').trim()) w++; return w; };
    rows.forEach((row, r) => row.forEach((raw, c) => {
      const s = (raw || '').trim(); if (!s) return; const x = ox + c, y = oy + r;
      if (/^[<>]/.test(s) || /[>]\s*[>]|[<]\s*[<]/.test(s)) { const lbl = s.replace(/[<>]/g, '').trim(); out.push({ id: uid(), type: 'conveyor', x, y, w: runRight(r, c, 80), h: 1, dir: s.includes('<') ? 'l' : 'r', label: lbl }); return; }
      if (/_(BDC|PDC|DC|ODS)$/i.test(s) || /^virtual/i.test(s)) { (parts[x] = parts[x] || []).push({ y, k: 'branch', v: s }); return; }
      if (/^\d{5}$/.test(s)) { (parts[x] = parts[x] || []).push({ y, k: 'code', v: s }); return; }
      if (/^OUT\s*FD\s*\d+/i.test(s)) { (parts[x] = parts[x] || []).push({ y, k: 'fd', v: s.replace(/^OUT\s*/i, '').replace(/\s+/g, '') }); return; }
      if (/^\d{2}[AB]$/i.test(s) || /^D\d{2}/.test(s)) { (parts[x] = parts[x] || []).push({ y, k: 'chute', v: s }); return; }
      if (isCam(s)) { const nums = s.includes('-') ? (([a, b]) => { const r2 = []; for (let i = +a; i <= +b; i++) r2.push(String(i).padStart(3, '0')); return r2; })(s.split('-').map(t => t.trim())) : s.split(',').map(t => t.trim()); nums.forEach((n, i) => out.push({ id: uid(), type: 'cam', no: n, name: '', note: '', x: x + (nums.length > 1 ? (i - (nums.length - 1) / 2) * 0.5 : 0), y, w: 1, h: 1, dir: 90, fov: 70, range: 120 })); return; }
      if (/^(OUT|IN)\s*(FD\b|\d{2,3})/i.test(s)) { const [l, ...h] = s.split('\u2028'); out.push({ id: uid(), type: 'dock', x, y, w: 2, h: 3, label: l.replace(/\s+/g, ' ').trim(), hub: h.join(' ').trim(), note: '' }); return; }
      const lane = /BPL-?\s*(OUT|IN)\s*-\s*\d+\s*(LH|FD)?/i.exec(s);
      if (lane) { out.push({ id: uid(), type: 'dock', x, y, w: Math.min(runRight(r, c, 8), 8), h: 1, label: lane[0].replace(/\s+/g, ' '), hub: s.replace(lane[0], '').replace(/\s+/g, ' ').trim(), note: '' }); return; }
      if (s === 'เสา') { out.push({ id: uid(), type: 'pillar', x, y, w: 1, h: 1, label: 'เสา' }); return; }
      out.push({ id: uid(), type: 'text', x, y, w: Math.min(runRight(r, c, 6), 6), h: 1, label: s.replace(/\u2028/g, ' '), size: 11 });
    }));
    Object.keys(parts).forEach(x => {
      const list = parts[x].sort((a, b) => a.y - b.y); let g = null;
      const flush = () => { if (!g) return; const d = { id: uid(), type: 'drop', x: +x, y: g.y0, w: 1, h: g.items.length === 1 ? 1 : Math.max(2, g.y1 - g.y0 + 1), fd: '', chute: '', branch: '', code: '', cams: '', note: '' }; g.items.forEach(p => d[p.k] = d[p.k] || p.v); out.push(d); g = null; };
      list.forEach(p => { if (g && p.y - g.y1 <= (p.k === 'code' || g.items[g.items.length - 1].k === 'code' ? 4 : 2)) { g.y1 = p.y; g.items.push(p); } else { flush(); g = { y0: p.y, y1: p.y, items: [p] }; } }); flush();
    });
    return out;
  }

  window.BPL = { CW, CH, uid, colName, defaultLayout, load, save, onChange, img, compress, exportFile, importFile, covers, camsFor, seenBy, cone, view, sorted, primaryKey, fitFs, paper, zOf, DEFZ, bounds, center, parseSheet, ARROW };
})();
