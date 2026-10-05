/* BPL CCTV Layout — online sync through a private GitHub data repo (see config.js)
   Nothing is readable without a token: a read-only token opens view, a read/write one opens edit.
   People sign in with an ID + password that decrypts their token (see "sign-in" below).
   branch main   : sheets.json (list of sheets + which one the floor sees), one layout file per sheet
                   (layout.json for the first sheet, sheets/<id>.json for the rest), images.json (index)
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
    const headers = Object.assign({ Accept: opt.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, opt.headers || {});
    if (!opt.anon) headers.Authorization = 'Bearer ' + (opt.token || c.token);
    const r = await fetch(`https://api.github.com/repos/${c.owner}/${opt.repo || c.repo}${path}`, { method: opt.method || 'GET', cache: 'no-store', headers, body: opt.body ? JSON.stringify(opt.body) : undefined });
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
  const logout = () => { setCfg({ token: '', role: '', slot: '', stamp: '' }); localStorage.removeItem(LS_VIEW); try { caches.delete('bpl-img').then(gate, gate); } catch (e) { gate(); } };

  // ---------- sign-in with ID + password ----------
  // access.json (public repo, see config.js) holds each GitHub token encrypted with a key derived from
  // "id\npassword". The IDs are listed on the sign-in page, so the password alone is the secret and
  // the slow key derivation is what stands between a downloaded access.json and a guess. A device stays
  // signed in until its sign-in's password changes (the entry's salt is its stamp). Changing a password only
  // re-encrypts the same token; to lock out someone who already signed in, regenerate the token on GitHub.
  const ACCESS = () => (window.BPL_ACCESS || {}).repo || 'bpl-cctv-access', KDF_ITER = 2000000, PW_MIN = 6;
  const enc = new TextEncoder(), b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf))), unb64 = s => Uint8Array.from(atob(s), ch => ch.charCodeAt(0));
  const b64text = s => b64(enc.encode(s));
  const secretOf = (id, pw) => String(id).trim().toLowerCase() + '\n' + pw;
  async function keyOf(secret, salt, iter) {
    const k = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, k, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function seal(secret, token) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyOf(secret, salt, KDF_ITER), enc.encode(token));
    return { salt: b64(salt), iv: b64(iv), iter: KDF_ITER, ct: b64(ct) };
  }
  async function unseal(secret, e) {
    try { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(e.iv) }, await keyOf(secret, unb64(e.salt), e.iter), unb64(e.ct))); } catch (err) { return null; }
  }
  async function accessGet(auth) {
    try { return JSON.parse(await gh('/contents/access.json', { repo: ACCESS(), raw: true, anon: !auth })); }
    catch (e) { const r = await fetch(`https://raw.githubusercontent.com/${cfg().owner}/${ACCESS()}/main/access.json`, { cache: 'no-store' }); if (!r.ok) throw e; return r.json(); }
  }
  // sign-in page: the IDs to offer, view first
  const accessList = async () => { const users = (await accessGet()).users || {}; return ['view', 'edit'].filter(s => users[s]).map(s => ({ slot: s, id: users[s].id })); };
  // -> { token, stamp }, or null when the password is wrong
  async function login(slot, pw) {
    const u = ((await accessGet()).users || {})[slot], token = u ? await unseal(secretOf(u.id, pw), u) : null;
    return token ? { token, stamp: u.salt } : null;
  }
  // false once the password this device signed in with has been changed; unknown (offline) counts as still valid
  async function accessFresh() {
    const s = saved(); if (!s.slot || !s.stamp) return true;
    try { const u = ((await accessGet()).users || {})[s.slot]; return !!u && u.salt === s.stamp; } catch (e) { return true; }
  }
  async function putFile(repo, path, text, message) {
    let sha; try { sha = (await gh('/contents/' + path, { repo })).sha; } catch (e) { if (e.status !== 404) throw e; }
    await gh('/contents/' + path, { repo, method: 'PUT', body: { message, content: b64text(text), sha } });
  }
  const viewToken = async () => { const f = await readJSON('view-token.json', cfg().branch); return (f && f.token) || ''; };
  const accessInfo = async () => { const users = (await accessGet(true)).users || {}; return { view: users.view ? users.view.id : '', edit: users.edit ? users.edit.id : '', viewToken: !!(await viewToken()) }; };
  // edit session only. o = { viewId, viewPw, viewToken, editId, editPw }; an empty password leaves that sign-in unchanged
  async function setAccess(o) {
    const fail = m => { throw new Error(m); }, c = cfg();
    const pasted = (o.viewToken || '').trim();
    if (!o.viewPw && !o.editPw) fail(pasted ? 'ใส่รหัสผ่านหน้างานด้วย เมื่อเปลี่ยน token หน้างาน' : 'ยังไม่ได้ใส่รหัสผ่านใหม่');
    if (pasted && !o.viewPw) fail('ใส่รหัสผ่านหน้างานด้วย เมื่อเปลี่ยน token หน้างาน');
    if (o.viewPw && (!o.viewId.trim() || o.viewPw.length < PW_MIN)) fail('หน้างาน: ต้องมีไอดี และรหัสผ่านอย่างน้อย ' + PW_MIN + ' ตัว');
    if (o.editPw && (!o.editId.trim() || o.editPw.length < PW_MIN)) fail('หลังบ้าน: ต้องมีไอดี และรหัสผ่านอย่างน้อย ' + PW_MIN + ' ตัว');
    if (o.viewPw && o.editPw && o.viewPw === o.editPw) fail('รหัสผ่านของหน้างานกับหลังบ้านต้องไม่เหมือนกัน');
    const users = (await accessGet(true)).users || {};
    if (o.viewPw) {
      const t = pasted || await viewToken(); if (!t) fail('ครั้งแรกต้องวาง token หน้างาน (Contents: Read-only) ด้วย');
      if (pasted) {
        // the floor staff's token must be able to read and must not be able to write
        try { await gh('', { token: t }); } catch (e) { fail('token หน้างานใช้ไม่ได้ (' + e.message + ')'); }
        let writes = true; try { await gh('/git/blobs', { token: t, method: 'POST', body: { content: '', encoding: 'utf-8' } }); } catch (e) { writes = false; }
        if (writes) fail('token หน้างานนี้แก้ไขข้อมูลได้ — ต้องใช้ token ที่ตั้ง Contents เป็น Read-only');
        await putFile(c.repo, 'view-token.json', JSON.stringify({ token: t }), 'view token');
      }
      users.view = Object.assign(await seal(secretOf(o.viewId, o.viewPw), t), { id: o.viewId.trim() });
    }
    if (o.editPw) users.edit = Object.assign(await seal(secretOf(o.editId, o.editPw), c.token), { id: o.editId.trim() });
    try { await putFile(ACCESS(), 'access.json', JSON.stringify({ v: 1, users }), 'access'); }
    catch (e) { fail(isAuth(e) ? 'token หลังบ้านยังไม่มีสิทธิ์เขียน repo ' + ACCESS() + ' (ต้องเลือก repo นี้และให้ Contents: Read and write)' : e.message); }
    if (o.editPw) setCfg({ slot: 'edit', stamp: users.edit.salt });   // this device keeps its own session
  }

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
  // ---------- sheets ----------
  // A data repo from before sheets existed has no sheets.json: it is one sheet, 'main', stored in layout.json.
  // Captures are keyed by camera number and shared by every sheet.
  const LS_SHEET = 'bpl.sheet', MAIN = 'main';
  const sheetFile = id => id === MAIN ? 'layout.json' : 'sheets/' + id + '.json';
  const key = (base, id) => id === MAIN ? base : base + ':' + id;   // per-sheet draft keys in localStorage
  let sheetId = MAIN;
  async function readSheets(sha) {
    const s = await readJSON('sheets.json', sha);
    return s && Array.isArray(s.sheets) && s.sheets.length ? s : { active: MAIN, sheets: [{ id: MAIN, name: '', updated: 0 }] };
  }
  // want = sheet to open; anything unknown falls back to the sheet the floor sees
  async function fetchRemote(sha, want) {
    sha = sha || await head();
    const [sheets, idx] = await Promise.all([readSheets(sha), readJSON('images.json', sha)]);
    const sheet = want && sheets.sheets.some(s => s.id === want) ? want : sheets.active;
    const layout = await readJSON(sheetFile(sheet), sha), me = sheets.sheets.find(s => s.id === sheet);
    if (layout && me) { me.name = me.name || layout.name || ''; me.updated = me.updated || layout.updated || 0; }
    return { sha, sheets, sheet, layout: layout && B.paper(layout), idx: idx || {} };
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
  const viewData = (r, online) => ({ layout: r.layout || B.defaultLayout(), imgs: imgMap(r.idx), online, preview: !!(r.sheets && r.sheet !== r.sheets.active) });
  // an editor may look at any sheet (?sheet=id); floor staff always get the active one
  let viewWant = '';
  async function viewLoad(want) {
    viewWant = cfg().role === 'edit' ? (want || '') : '';
    try { const r = await fetchRemote(null, viewWant); if (!viewWant) keep(r); return viewData(r, true); }
    catch (e) {
      if (isAuth(e) && !isLimit(e)) return { authError: true, message: e.message };
      let r = { layout: null, idx: {} }; try { r = JSON.parse(localStorage.getItem(LS_VIEW)) || r; } catch (e2) {}
      return viewData(r, false);
    }
  }
  function watch(cb, ms = 20000) {
    const poll = async () => {
      if (document.hidden) return;
      try { const was = headSha, sha = await head(); if (sha !== was) { const r = await fetchRemote(sha, viewWant); if (!viewWant) keep(r); cb(viewData(r, true)); } } catch (e) {}
    };
    setInterval(poll, ms); document.addEventListener('visibilitychange', poll);
    setInterval(async () => { if (!(await accessFresh())) logout(); }, 600000);
  }

  // ---------- edit: local draft ----------
  // IndexedDB holds only unpublished image changes: { src, t } = new capture, { del, t } = removal
  const raw = { all: B.img.all, set: B.img.set, del: B.img.del, clear: B.img.clear };
  let remote = { layout: null, idx: {}, sheets: null };
  const markDirty = () => localStorage.setItem(key(LS_DIRTY, sheetId), '1');
  const localSave = l => localStorage.setItem(key(LS, sheetId), JSON.stringify(l));
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
    const want = localStorage.getItem(LS_SHEET) || '';
    try { remote = await fetchRemote(null, want); sheetId = remote.sheet; } catch (e) { if (isAuth(e) && !isLimit(e)) return { authError: true, message: e.message }; online = false; sheetId = want || MAIN; }
    let local = null; try { const s = localStorage.getItem(key(LS, sheetId)); if (s) local = B.paper(JSON.parse(s)); } catch (e) {}
    const draft = localStorage.getItem(key(LS_DIRTY, sheetId)) === '1', rl = remote.layout;
    // newer copy wins; a local draft older than what is online is left for the editor to resolve (stale)
    const stale = !!(rl && local && draft && (local.updated || 0) < (rl.updated || 0));
    const layout = !rl ? (local || B.defaultLayout()) : !local ? rl : ((local.updated || 0) >= (rl.updated || 0) || draft) ? local : rl;
    if (layout === rl) adopt(rl);
    const pend = await raw.all();
    return { layout, stale, remoteUpdated: rl ? rl.updated : null, online, imgs: await imgAll(), dirty: draft || !rl || Object.keys(pend).length > 0, sheet: sheetId, sheets: remote.sheets };
  }
  function adopt(l) { localSave(l); localStorage.setItem(key(LS_BASE, sheetId), String(l.updated || 0)); localStorage.removeItem(key(LS_DIRTY, sheetId)); }
  async function useRemote() {
    adopt(remote.layout);
    if (Object.keys(await raw.all()).length) markDirty();
    return remote.layout;
  }
  const defaultLayout = async () => { const l = await readJSON('default-layout.json', cfg().branch); return l && B.paper(l); };

  // ---------- edit: sheets ----------
  const entry = (path, rest) => Object.assign({ path, mode: '100644', type: 'blob' }, rest);
  // one commit on main; content null removes the file. -> the sheet list as of that commit
  async function commitSheets(change, message) {
    etag = ''; const sha = await head(), commit = await gh('/git/commits/' + sha), sheets = await readSheets(sha);
    const main = sheets.sheets.find(s => s.id === MAIN);
    if (main && !main.name) { const l = await readJSON('layout.json', sha); main.name = (l && l.name) || 'แผ่นหลัก'; main.updated = (l && l.updated) || 0; }
    const files = change(sheets) || [];
    const tree = files.map(f => entry(f.path, f.content === null ? { sha: null } : { content: f.content })).concat(entry('sheets.json', { content: JSON.stringify(sheets) }));
    const t = await gh('/git/trees', { method: 'POST', body: { base_tree: commit.tree.sha, tree } });
    const cm = await gh('/git/commits', { method: 'POST', body: { message, tree: t.sha, parents: [sha] } });
    await gh('/git/refs/heads/' + cfg().branch, { method: 'PATCH', body: { sha: cm.sha } });
    remote.sheets = sheets; return sheets;
  }
  // new sheet, blank or a copy of `from`; this device switches to it on its next load
  async function sheetCreate(name, from) {
    const id = 's' + Date.now().toString(36), now = Date.now();
    const layout = Object.assign({}, from || B.defaultLayout(), { name, updated: now });
    const sheets = await commitSheets(s => { s.sheets.push({ id, name, updated: now }); return [{ path: sheetFile(id), content: JSON.stringify(layout) }]; }, 'แผ่นงานใหม่: ' + name);
    localStorage.setItem(LS_SHEET, id);
    return sheets;
  }
  const sheetOpen = id => localStorage.setItem(LS_SHEET, id);
  // choose the sheet the floor sees
  const sheetActivate = id => commitSheets(s => { if (!s.sheets.some(x => x.id === id)) throw new Error('ไม่พบแผ่นงานนี้'); s.active = id; }, 'หน้างานเห็นแผ่น: ' + id);
  async function sheetDelete(id) {
    const sheets = await commitSheets(s => {
      if (s.active === id) throw new Error('ลบแผ่นที่หน้างานเห็นอยู่ไม่ได้ ให้เลือกแผ่นอื่นให้หน้างานก่อน');
      if (s.sheets.length < 2) throw new Error('ต้องเหลืออย่างน้อย 1 แผ่น');
      s.sheets = s.sheets.filter(x => x.id !== id); return [{ path: sheetFile(id), content: null }];
    }, 'ลบแผ่นงาน: ' + id);
    [LS, LS_DIRTY, LS_BASE].forEach(b => localStorage.removeItem(key(b, id)));
    if (id === sheetId) localStorage.removeItem(LS_SHEET);
    return sheets;
  }

  // ---------- edit: publish (one commit: layout + image index + changed images) ----------
  const fileOf = no => String(no).trim().replace(/[^A-Za-z0-9_-]/g, '_') || '_';
  const EXT = { jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif' };
  async function publish(layout, opt = {}) {
    const c = cfg();
    if (!hasToken()) { const e = new Error('ยังไม่ได้ตั้งค่า GitHub token'); e.code = 'NO_TOKEN'; throw e; }
    const pend = await raw.all(), todo = Object.keys(pend);
    etag = ''; const sha = await head(), commit = await gh('/git/commits/' + sha);
    const [headLayout, headIdx, sheets] = await Promise.all([readJSON(sheetFile(sheetId), sha), readJSON('images.json', sha), readSheets(sha)]);
    const base = +localStorage.getItem(key(LS_BASE, sheetId)) || 0, idx = headIdx || {};
    if (!opt.force && headLayout && (headLayout.updated || 0) > base) { const e = new Error('มีการบันทึกจากเครื่องอื่น'); e.code = 'CONFLICT'; e.remoteUpdated = headLayout.updated; throw e; }

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
    let me = sheets.sheets.find(s => s.id === sheetId); if (!me) sheets.sheets.push(me = { id: sheetId });
    me.name = out.name || ''; me.updated = out.updated;
    const tree = [entry(sheetFile(sheetId), { content: JSON.stringify(out) }), entry('images.json', { content: JSON.stringify(idx) }), entry('sheets.json', { content: JSON.stringify(sheets) })];
    const t = await gh('/git/trees', { method: 'POST', body: { base_tree: commit.tree.sha, tree } });
    const cm = await gh('/git/commits', { method: 'POST', body: { message: 'อัปเดตเลเอ้า ' + new Date(out.updated).toLocaleString('th-TH'), tree: t.sha, parents: [sha] } });
    await gh('/git/refs/heads/' + c.branch, { method: 'PATCH', body: { sha: cm.sha } });

    remote = { layout: out, idx, sheets };
    const now = await raw.all();
    for (const no of done) if (now[no] && now[no].t === pend[no].t) await raw.del(no);
    adopt(out); if (left) markDirty();
    return { layout: out, left, sheets };
  }

  B.cloud = { cfg, setCfg, hasToken, probe, gate, logout, login, accessList, accessFresh, accessInfo, setAccess, PW_MIN, viewLoad, watch, editLoad, useRemote, defaultLayout, publish, sheetCreate, sheetOpen, sheetActivate, sheetDelete };
})();
