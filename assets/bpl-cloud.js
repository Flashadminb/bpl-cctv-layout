/* BPL CCTV Layout — online sync through a private GitHub data repo (see config.js)
   Nothing is readable without a token: a read-only token opens view, a read/write one opens edit.
   branch main   : layout.json + images.json (index), normal history
   branch images : the captures, rewritten as a single parentless commit on every change so replaced
                   or deleted pictures drop out of the repo instead of piling up in history
   view  : reads layout.json + images.json through the GitHub API, polls the branch head for changes
   edit  : keeps a local draft (localStorage + IndexedDB) and commits it to the data repo */
(function () {
  const B = window.BPL;
  const LS = 'bpl.layout.v1', LS_DIRTY = 'bpl.dirty', LS_BASE = 'bpl.base', LS_CFG = 'bpl.cloud', LS_VIEW = 'bpl.view.cache';
  const ROOT = new URL('../', (document.currentScript && document.currentScript.src) || location.href).href, IMG_BRANCH = 'images';
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

  // ---------- config ----------
  const saved = () => { try { return JSON.parse(localStorage.getItem(LS_CFG) || '{}'); } catch (e) { return {}; } };
  function cfg() {
    const c = Object.assign({ owner: '', repo: '', branch: 'main', token: '', role: '' }, window.BPL_REPO || {}), s = saved();
    Object.keys(s).forEach(k => { if (s[k]) c[k] = s[k]; });
    return c;
  }
  const setCfg = patch => localStorage.setItem(LS_CFG, JSON.stringify(Object.assign(saved(), patch)));
  const hasToken = () => { const c = cfg(); return !!(c.token && c.owner && c.repo); };
  const isAuth = e => !!e && (e.status === 401 || e.status === 403 || e.status === 404);
  const isLimit = e => !!e && (e.status === 429 || (e.status === 403 && /rate limit/i.test(e.message)));

  async function ghRes(path, opt = {}) {
    const c = cfg();
    const r = await fetch(`https://api.github.com/repos/${c.owner}/${c.repo}${path}`, {
      method: opt.method || 'GET', cache: 'no-store',
      headers: Object.assign({ Accept: opt.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', Authorization: 'Bearer ' + c.token, 'X-GitHub-Api-Version': '2022-11-28' }, opt.headers || {}),
      body: opt.body ? JSON.stringify(opt.body) : undefined
    });
    if (!r.ok && r.status !== 304) { let msg = ''; try { msg = (await r.json()).message || ''; } catch (e) {} const err = new Error(msg || 'HTTP ' + r.status); err.status = r.status; throw err; }
    return r;
  }
  const gh = async (path, opt = {}) => { const r = await ghRes(path, opt); return opt.raw ? r.text() : r.json(); };
  // which page a token opens: creating an (unreferenced, empty) blob only succeeds with write access
  async function probe() {
    await gh('');
    try { await gh('/git/blobs', { method: 'POST', body: { content: '', encoding: 'utf-8' } }); return 'edit'; }
    catch (e) { if (isAuth(e) && !isLimit(e)) return 'view'; throw e; }
  }
  const gate = () => location.replace(ROOT);
  // signing out also drops what this device cached for offline use
  const logout = () => { setCfg({ token: '', role: '' }); localStorage.removeItem(LS_VIEW); try { caches.delete('bpl-img').then(gate, gate); } catch (e) { gate(); } };

  // ---------- data repo ----------
  async function readJSON(name, ref) {
    try { return JSON.parse(await gh('/contents/' + name + '?ref=' + ref, { raw: true })); } catch (e) { if (e.status === 404) return null; throw e; }
  }
  // branch head; a 304 on the conditional request costs no API quota
  let etag = '', headSha = '';
  async function head() {
    const r = await ghRes('/git/ref/heads/' + cfg().branch, etag ? { headers: { 'If-None-Match': etag } } : {});
    if (r.status === 304) return headSha;
    etag = r.headers.get('ETag') || ''; headSha = (await r.json()).object.sha;
    return headSha;
  }
  async function fetchRemote(sha) {
    sha = sha || await head();
    const [layout, idx] = await Promise.all([readJSON('layout.json', sha), readJSON('images.json', sha)]);
    return { sha, layout: layout && B.paper(layout), idx: idx || {} };
  }

  // ---------- captures: fetched on demand, kept in the browser cache by blob sha ----------
  const urls = {}, queued = {}, queue = []; let active = 0, tick = 0;
  const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
  async function loadBlob(e) {
    const key = '/__bpl-img/' + e.sha; let store = null;
    try { store = await caches.open('bpl-img'); const hit = await store.match(key); if (hit) return hit.blob(); } catch (err) {}
    const r = await ghRes('/git/blobs/' + e.sha, { raw: true });
    const blob = new Blob([await r.blob()], { type: MIME[e.f.split('.').pop()] || 'image/jpeg' });
    try { store && await store.put(key, new Response(blob)); } catch (err) {}
    return blob;
  }
  function pump() {
    while (active < 4 && queue.length) {
      const e = queue.shift(); active++;
      loadBlob(e).then(b => { urls[e.sha] = URL.createObjectURL(b); }, () => { delete queued[e.sha]; }).then(() => {
        active--; pump();
        clearTimeout(tick); tick = setTimeout(() => window.dispatchEvent(new Event('bpl-img')), 60);
      });
    }
  }
  function srcOf(e) {
    if (urls[e.sha]) return urls[e.sha];
    if (!queued[e.sha]) { queued[e.sha] = 1; queue.push(e); pump(); }
    return BLANK;
  }
  const imgMap = idx => { const o = {}; Object.keys(idx || {}).forEach(no => { const e = idx[no]; o[no] = { t: e.t, get src() { return srcOf(e); } }; }); return o; };

  // ---------- view ----------
  const keep = r => { try { localStorage.setItem(LS_VIEW, JSON.stringify({ layout: r.layout, idx: r.idx })); } catch (e) {} };
  const viewData = (r, online) => ({ layout: r.layout || B.defaultLayout(), imgs: imgMap(r.idx), online });
  async function viewLoad() {
    try { const r = await fetchRemote(); keep(r); return viewData(r, true); }
    catch (e) {
      if (isAuth(e) && !isLimit(e)) return { authError: true, message: e.message };
      let r = { layout: null, idx: {} }; try { r = JSON.parse(localStorage.getItem(LS_VIEW)) || r; } catch (e2) {}
      return viewData(r, false);
    }
  }
  function watch(cb, ms = 20000) {
    const poll = async () => {
      if (document.hidden) return;
      try { const was = headSha, sha = await head(); if (sha !== was) { const r = await fetchRemote(sha); keep(r); cb(viewData(r, true)); } } catch (e) {}
    };
    setInterval(poll, ms); document.addEventListener('visibilitychange', poll);
  }

  // ---------- edit: local draft ----------
  // IndexedDB holds only unpublished image changes: { src, t } = new capture, { del, t } = removal
  const raw = { all: B.img.all, set: B.img.set, del: B.img.del, clear: B.img.clear };
  let remote = { layout: null, idx: {} };
  const markDirty = () => localStorage.setItem(LS_DIRTY, '1');
  const localSave = B.save;
  B.save = l => { localSave(l); markDirty(); };

  async function imgAll() {
    const pend = await raw.all(), out = imgMap(remote.idx);
    for (const no of Object.keys(pend)) { const p = pend[no]; if (p.del) delete out[no]; else out[no] = { src: p.src, t: p.t }; }
    return out;
  }
  B.img.all = imgAll;
  B.img.set = async (no, v) => { await raw.set(no, { src: v.src, t: v.t }); markDirty(); };
  B.img.del = async no => { if (remote.idx[no]) await raw.set(no, { del: true, t: Date.now() }); else await raw.del(no); markDirty(); };

  const toDataURL = blob => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
  B.exportFile = async layout => {
    const pend = await raw.all(), images = {};
    for (const no of Object.keys(remote.idx)) { try { images[no] = { src: await toDataURL(await loadBlob(remote.idx[no])), t: remote.idx[no].t }; } catch (e) {} }
    for (const no of Object.keys(pend)) { if (pend[no].del) delete images[no]; else images[no] = { src: pend[no].src, t: pend[no].t }; }
    const blob = new Blob([JSON.stringify({ app: 'bpl-cctv-layout', version: 1, layout, images })], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'bpl-layout-' + new Date().toISOString().slice(0, 10) + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  B.importFile = async file => {
    const data = JSON.parse(await file.text());
    if (!data.layout || !Array.isArray(data.layout.elements)) throw new Error('ไฟล์ไม่ถูกต้อง');
    data.layout = B.paper(data.layout); B.save(data.layout);
    if (data.images) {
      await raw.clear(); const t = Date.now();
      for (const no of Object.keys(remote.idx)) if (!data.images[no]) await raw.set(no, { del: true, t });
      for (const no of Object.keys(data.images)) { const v = data.images[no]; if (v && String(v.src).startsWith('data:')) await raw.set(no, { src: v.src, t: v.t || t }); }
    }
    return data.layout;
  };

  async function editLoad() {
    let online = true;
    try { remote = await fetchRemote(); } catch (e) { if (isAuth(e) && !isLimit(e)) return { authError: true, message: e.message }; online = false; }
    let local = null; try { const s = localStorage.getItem(LS); if (s) local = B.paper(JSON.parse(s)); } catch (e) {}
    const draft = localStorage.getItem(LS_DIRTY) === '1', rl = remote.layout;
    // newer copy wins; a local draft older than what is online is left for the editor to resolve (stale)
    const stale = !!(rl && local && draft && (local.updated || 0) < (rl.updated || 0));
    const layout = !rl ? (local || B.defaultLayout()) : !local ? rl : ((local.updated || 0) >= (rl.updated || 0) || draft) ? local : rl;
    if (layout === rl) adopt(rl);
    const pend = await raw.all();
    return { layout, stale, remoteUpdated: rl ? rl.updated : null, online, imgs: await imgAll(), dirty: draft || !rl || Object.keys(pend).length > 0 };
  }
  function adopt(l) { localSave(l); localStorage.setItem(LS_BASE, String(l.updated || 0)); localStorage.removeItem(LS_DIRTY); }
  async function useRemote() {
    adopt(remote.layout);
    if (Object.keys(await raw.all()).length) markDirty();
    return remote.layout;
  }
  const defaultLayout = async () => { const l = await readJSON('default-layout.json', cfg().branch); return l && B.paper(l); };

  // ---------- edit: publish (one commit: layout + image index + changed images) ----------
  const fileOf = no => String(no).trim().replace(/[^A-Za-z0-9_-]/g, '_') || '_';
  const EXT = { jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif' };
  async function publish(layout, opt = {}) {
    const c = cfg();
    if (!hasToken()) { const e = new Error('ยังไม่ได้ตั้งค่า GitHub token'); e.code = 'NO_TOKEN'; throw e; }
    const pend = await raw.all(), todo = Object.keys(pend);
    etag = ''; const sha = await head(), commit = await gh('/git/commits/' + sha);
    const [headLayout, headIdx] = await Promise.all([readJSON('layout.json', sha), readJSON('images.json', sha)]);
    const base = +localStorage.getItem(LS_BASE) || 0, idx = headIdx || {};
    if (!opt.force && headLayout && (headLayout.updated || 0) > base) { const e = new Error('มีการบันทึกจากเครื่องอื่น'); e.code = 'CONFLICT'; e.remoteUpdated = headLayout.updated; throw e; }

    const entry = (path, rest) => Object.assign({ path, mode: '100644', type: 'blob' }, rest);
    const itree = [], file = (path, rest) => itree.push(entry(path, rest));
    const done = []; let left = 0;
    for (const no of todo) {
      const p = pend[no], old = idx[no];
      if (p.del) { if (old) { file(old.f, { sha: null }); delete idx[no]; } }
      else {
        const m = /^data:image\/(\w+);base64,(.*)$/.exec(p.src);
        if (m) {
          const f = fileOf(no) + '.' + (EXT[m[1]] || 'jpg'); let blob;
          // GitHub throttles bursts of uploads: commit what went through, the rest stays pending for the next save
          try { blob = await gh('/git/blobs', { method: 'POST', body: { content: m[2], encoding: 'base64' } }); }
          catch (e) { if (isLimit(e) && done.length) { left = todo.length - done.length; break; } throw e; }
          if (old && old.f !== f) file(old.f, { sha: null });
          file(f, { sha: blob.sha }); idx[no] = { f, t: p.t, sha: blob.sha }; urls[blob.sha] = p.src;
        }
      }
      done.push(no); opt.onProgress && opt.onProgress(done.length, todo.length);
    }
    if (itree.length) {
      let ihead = null; try { ihead = (await gh('/git/ref/heads/' + IMG_BRANCH)).object.sha; } catch (e) { if (e.status !== 404) throw e; }
      const ibase = ihead ? (await gh('/git/commits/' + ihead)).tree.sha : null;
      const have = new Set(ibase ? (await gh('/git/trees/' + ibase)).tree.map(x => x.path) : []);
      const list = itree.filter(x => x.sha !== null || have.has(x.path)).concat(entry('README.md', { content: 'ภาพจากกล้อง — branch นี้ไม่มีประวัติ ภาพที่ถูกแทนที่หรือลบจะถูกทิ้ง\n' }));
      const it = await gh('/git/trees', { method: 'POST', body: ibase ? { base_tree: ibase, tree: list } : { tree: list } });
      const ic = await gh('/git/commits', { method: 'POST', body: { message: 'images', tree: it.sha, parents: [] } });
      if (ihead) await gh('/git/refs/heads/' + IMG_BRANCH, { method: 'PATCH', body: { sha: ic.sha, force: true } });
      else await gh('/git/refs', { method: 'POST', body: { ref: 'refs/heads/' + IMG_BRANCH, sha: ic.sha } });
    }
    const out = Object.assign({}, layout, { updated: Date.now() });
    const tree = [entry('layout.json', { content: JSON.stringify(out) }), entry('images.json', { content: JSON.stringify(idx) })];
    const t = await gh('/git/trees', { method: 'POST', body: { base_tree: commit.tree.sha, tree } });
    const cm = await gh('/git/commits', { method: 'POST', body: { message: 'อัปเดตเลเอ้า ' + new Date(out.updated).toLocaleString('th-TH'), tree: t.sha, parents: [sha] } });
    await gh('/git/refs/heads/' + c.branch, { method: 'PATCH', body: { sha: cm.sha } });

    remote = { layout: out, idx };
    const now = await raw.all();
    for (const no of done) if (now[no] && now[no].t === pend[no].t) await raw.del(no);
    adopt(out); if (left) markDirty();
    return { layout: out, left };
  }

  B.cloud = { cfg, setCfg, hasToken, probe, gate, logout, viewLoad, watch, editLoad, useRemote, defaultLayout, publish };
})();
