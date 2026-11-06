/* GymLog core: pure logic + Store + adapters + Auth.
 * UMD: works in the browser (window.GL) and in node (require) for tests.
 * No member names, PINs or secrets live in this file. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GL = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BODY_PARTS = ['이두', '삼두', '가슴', '어깨', '등', '복근', '하체', '기타']; // 가슴 needs migration-002 on the server (see Store.supportsChest)
  var MEMO_MAX = 200;
  var SEED_EXERCISES = [
    { name: '트라이셉스벤치프레스', body_part: '삼두' },
    { name: 'W바', body_part: '이두' },
    { name: '내측장두케이블', body_part: '삼두' },
    { name: '이두머신', body_part: '이두' },
    { name: '밀리터리 프레스 머신', body_part: '어깨' },
    { name: '원판', body_part: '어깨' }
  ];
  var TABLES = ['members', 'exercises', 'workouts', 'sets'];
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  // ------------------------------------------------------------------
  // ENTRY FORMAT — the ONE place that defines what a pasted line means (owner's rules, round 7).
  // Tokens separated by " - " are SETS, in order, one set each:
  //   웜업 (or a listed synonym)  = one warm-up set, no weight (a number may follow: `웜업 40`)
  //   a number                    = one WORKING set at that weight
  //   (a,b) right after a number  = DROPS: weight reduced without rest, continuing the SAME set: 25(20,10)
  //   a trailing dash (`7.5 -`)   = just that one set (the empty token is ignored)
  // ------------------------------------------------------------------
  var MAX_NUM = 100000; // explicit domain limit for weights/drops (rejects absurd or non-finite digit strings)
  function okNum(n) { return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= MAX_NUM; }
  var NUM = '(\\d+(?:\\.\\d+)?)';
  var WARMUP_WORDS = ['웜업', '웝업', '워밍업', '워업'];
  var WARM_RE = new RegExp('^(' + WARMUP_WORDS.join('|') + ')(?:\\s+' + NUM + ')?$');
  var WORK_RE = new RegExp('^' + NUM + '(?:\\s*\\(\\s*(' + NUM + '(?:\\s*,\\s*' + NUM + ')*)\\s*\\))?$');

  function parseSetLine(text) {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'empty' };
    if (/^[-\s]*$/.test(text)) return { ok: false, error: 'only dashes' };
    var tokens = text.trim().split(/\s+-(?:\s+|$)/).map(function (x) { return x.trim(); }).filter(function (x) { return x; });
    var sets = [];
    for (var i = 0; i < tokens.length; i++) {
      var tk = tokens[i], m = WARM_RE.exec(tk);
      if (m) {
        if (m[2] !== undefined && !okNum(Number(m[2]))) return { ok: false, error: 'number out of range "' + tk.slice(0, 20) + '"' };
        sets.push({ is_warmup: true, weight: m[2] === undefined ? null : Number(m[2]), drops: null, note: '' }); continue;
      }
      m = WORK_RE.exec(tk);
      if (m) {
        var drops = m[2] === undefined ? null : m[2].split(',').map(function (d) { return Number(d.trim()); });
        if (!okNum(Number(m[1])) || (drops && !drops.every(okNum))) return { ok: false, error: 'number out of range "' + tk.slice(0, 20) + '"' };
        sets.push({ is_warmup: false, weight: Number(m[1]), drops: drops, note: '' }); continue;
      }
      return { ok: false, error: (/^[^\d()\-,.\s]+$/.test(tk) ? 'unknown word "' + tk + '"' : 'cannot read "' + tk + '"') };
    }
    if (!sets.length) return { ok: false, error: 'empty' };
    return { ok: true, sets: sets };
  }

  function parseLines(text) {
    var ok = [], errors = [];
    String(text || '').split(/\r?\n/).forEach(function (line, i) {
      if (!line.trim()) return;
      var r = parseSetLine(line);
      if (r.ok) r.sets.forEach(function (x) { ok.push(x); }); else errors.push({ line: i + 1, text: line, error: r.error });
    });
    return { ok: ok, errors: errors };
  }

  function fmtNum(n) { return String(n); } // exact: never rounds away precision the parser accepted (domain is capped by MAX_NUM)

  // one set in the memo format: `웜업`, `웜업 40`, `60`, `25(20,10)`
  function formatSet(s) {
    var hasW = s.weight !== null && s.weight !== undefined;
    if (s.is_warmup) return '웜업' + (hasW ? ' ' + fmtNum(s.weight) : '');
    var out = hasW ? fmtNum(s.weight) : '';
    if (s.drops && s.drops.length) out += '(' + s.drops.map(fmtNum).join(',') + ')';
    return out;
  }
  function formatSets(list) { return list.map(formatSet).join(' - '); }
  // weight chips (+2.5/+5/-2.5): `cur` is the field text; empty/unreadable -> `fallback` (or 0). Never below 0 or above MAX_NUM.
  function nudge(cur, delta, fallback) {
    var t = String(cur === undefined || cur === null ? '' : cur).trim(), base = /^\d+(\.\d+)?$/.test(t) ? Number(t) : (fallback === null || fallback === undefined ? 0 : Number(fallback));
    var v = Math.round((base + delta) * 1000) / 1000;
    return fmtNum(Math.min(MAX_NUM, Math.max(0, v)));
  }

  // Validates structured form fields (UI form). Returns {ok,value}|{ok:false,error}.
  // A working set needs a weight; a warm-up may have none. drops: comma text or an array of numbers >= 0.
  function validateSetFields(f) {
    function num(v) {
      if (v === null || v === undefined || String(v).trim() === '') return null;
      var s = String(v).trim().replace(',', '.');
      if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
      return Number(s);
    }
    var warm = !!f.is_warmup, w = num(f.weight);
    if (w !== null && !okNum(w)) return { ok: false, error: 'weight' };
    if (w === null && !warm) return { ok: false, error: 'weight' };
    var drops = null;
    if (Array.isArray(f.drops) || (f.drops !== null && f.drops !== undefined && String(f.drops).trim() !== '')) {
      var parts = Array.isArray(f.drops) ? f.drops : String(f.drops).split(',');
      drops = [];
      for (var i = 0; i < parts.length; i++) {
        var raw = typeof parts[i] === 'number' ? String(parts[i]) : String(parts[i]).trim().replace(',', '.');
        if (!/^\d+(\.\d+)?$/.test(raw)) return { ok: false, error: 'drops' };
        if (!okNum(Number(raw))) return { ok: false, error: 'drops' };
        drops.push(Number(raw));
      }
      if (!drops.length) drops = null;
      if (drops && warm) return { ok: false, error: 'drops' }; // drops belong to working sets
    }
    return { ok: true, value: { is_warmup: warm, weight: w, drops: drops, note: String(f.note || '').trim() } };
  }

  // ------------------------------------------------------------------
  // Stats
  // ------------------------------------------------------------------
  function dayStats(sets, opts) {
    var inc = !!(opts && opts.includeWarmup);
    var used = sets.filter(function (s) {
      return !s.deleted && Number.isFinite(s.weight) && (inc || !s.is_warmup);
    });
    if (!used.length) return null; // empty day => no point (never 0)
    var sum = 0, max = -Infinity;
    used.forEach(function (s) { sum += s.weight; if (s.weight > max) max = s.weight; });
    return { count: used.length, avg: sum / used.length, max: max };
  }

  function groupByBodyPart(exercises) {
    var g = {};
    BODY_PARTS.forEach(function (b) { g[b] = []; });
    exercises.forEach(function (e) {
      if (!g[e.body_part]) throw new Error('invalid body_part: ' + e.body_part);
      g[e.body_part].push(e);
    });
    return g;
  }

  function assertBodyPart(bp) {
    if (BODY_PARTS.indexOf(bp) < 0) throw new Error('invalid body_part');
  }

  function delta(points) {
    if (!points.length) return null;
    var first = points[0], latest = points[points.length - 1];
    return { first: first, latest: latest, diff: points.length > 1 ? latest.avg - first.avg : null };
  }

  // ------------------------------------------------------------------
  // Adapters (async interface: init, list, put, clear)
  // ------------------------------------------------------------------
  function MemoryStorage() {
    this.m = new Map();
    Object.defineProperty(this, 'length', { get: function () { return this.m.size; } });
  }
  MemoryStorage.prototype.getItem = function (k) { return this.m.has(k) ? this.m.get(k) : null; };
  MemoryStorage.prototype.setItem = function (k, v) { this.m.set(k, String(v)); };
  MemoryStorage.prototype.removeItem = function (k) { this.m.delete(k); };
  MemoryStorage.prototype.key = function (i) { return Array.from(this.m.keys())[i] || null; };

  function LocalAdapter(storage) {
    this.s = storage;
    this.failNext = 0; // test hook: number of upcoming put() calls that throw
  }
  LocalAdapter.prototype.init = function () { return Promise.resolve(); };
  LocalAdapter.prototype.list = function (table) {
    var prefix = 'gl:v1:' + table + ':', out = [];
    for (var i = 0; i < this.s.length; i++) {
      var k = this.s.key(i);
      if (k && k.indexOf(prefix) === 0) out.push(JSON.parse(this.s.getItem(k)));
    }
    return Promise.resolve(out);
  };
  LocalAdapter.prototype.put = function (table, row) {
    if (this.failNext > 0) { this.failNext--; return Promise.reject(new Error('simulated write failure')); }
    try { this.s.setItem('gl:v1:' + table + ':' + row.id, JSON.stringify(row)); }
    catch (e) { return Promise.reject(e); }
    return Promise.resolve();
  };
  LocalAdapter.prototype.clear = function () {
    var del = [];
    for (var i = 0; i < this.s.length; i++) {
      var k = this.s.key(i);
      if (k && k.indexOf('gl:v1:') === 0) del.push(k);
    }
    del.forEach(function (k) { this.s.removeItem(k); }, this);
    return Promise.resolve();
  };

  // ------------------------------------------------------------------
  // Supabase backend: plain fetch against /auth/v1 and /rest/v1 (no supabase-js, no CDN).
  // ------------------------------------------------------------------
  var TOK_KEY = 'gl:auth'; // {access_token, refresh_token, expires_at(sec)}. The PIN is never stored.
  var COLS = { // exact server columns (schema is fixed); anything else (e.g. local updated_by) is dropped
    members: ['id', 'name', 'archived'],
    exercises: ['id', 'name', 'body_part', 'archived', 'memo'], // memo exists only after migration-002: it is sent only when set/changed, and only if the server rows carry it
    workouts: ['id', 'member_id', 'date', 'note', 'deleted'],
    sets: ['id', 'workout_id', 'exercise_id', 'position', 'is_warmup', 'weight', 'drops', 'note', 'deleted', 'updated_at']
  };
  function codeErr(code, msg, extra) { var e = new Error(msg || code); e.code = code; if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; }); return e; }

  function SbClient(cfg, kv, opts) {
    opts = opts || {};
    if (!cfg || !cfg.supabaseUrl || !cfg.supabaseKey) throw new Error('missing supabase config');
    this.url = String(cfg.supabaseUrl).replace(/\/+$/, '');
    this.key = cfg.supabaseKey;
    this.kv = kv;
    this.fetchFn = opts.fetch || function () { return globalThis.fetch.apply(globalThis, arguments); };
    this.now = opts.now || function () { return Date.now(); };
    this.onAuthLost = opts.onAuthLost || null;
    this.refreshing = null;
  }
  SbClient.prototype.tokens = function () {
    var raw = this.kv.getItem(TOK_KEY);
    if (!raw) return null;
    try { var t = JSON.parse(raw); return t && t.access_token && t.refresh_token ? t : null; } catch (e) { return null; }
  };
  SbClient.prototype.hasTokens = function () { return !!this.tokens(); };
  SbClient.prototype.clearTokens = function () { this.kv.removeItem(TOK_KEY); };
  SbClient.prototype._saveTokens = function (j) {
    if (!j || !j.access_token || !j.refresh_token) throw codeErr('HTTP', 'malformed token response');
    this.kv.setItem(TOK_KEY, JSON.stringify({
      access_token: j.access_token, refresh_token: j.refresh_token,
      expires_at: Math.floor(this.now() / 1000) + (Number(j.expires_in) > 0 ? Number(j.expires_in) : 3600)
    }));
  };
  SbClient.prototype._send = async function (method, path, o, access) {
    o = o || {};
    var h = Object.assign({ apikey: this.key }, o.headers || {});
    if (access) h.Authorization = 'Bearer ' + access;
    try { return await this.fetchFn(this.url + path, { method: method, headers: h, body: o.body }); }
    catch (e) { throw codeErr('NET', 'network error: ' + (e && e.message || e)); }
  };
  SbClient.prototype.signIn = async function (email, password) {
    var r = await this._send('POST', '/auth/v1/token?grant_type=password', {
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email, password: password })
    });
    if (!r.ok) throw codeErr(r.status >= 400 && r.status < 500 ? 'BAD' : 'HTTP', 'sign-in failed: HTTP ' + r.status);
    var j; try { j = await r.json(); } catch (e) { throw codeErr('HTTP', 'sign-in: bad response'); }
    this._saveTokens(j);
  };
  SbClient.prototype._lost = function () {
    this.clearTokens();
    if (this.onAuthLost) { try { this.onAuthLost(); } catch (e) { /* UI errors never mask the auth error */ } }
  };
  // One refresh at a time (refresh tokens rotate). `stale` = access token the caller used; if it already changed, skip.
  SbClient.prototype._refresh = function (stale) {
    var self = this;
    if (this.refreshing) return this.refreshing;
    var cur = this.tokens();
    if (!cur) return Promise.reject(codeErr('AUTH', 'not logged in'));
    if (stale && cur.access_token !== stale) return Promise.resolve();
    var p = (async function () {
      var r = await self._send('POST', '/auth/v1/token?grant_type=refresh_token', {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: cur.refresh_token })
      });
      if (r.status >= 400 && r.status < 500) { self._lost(); throw codeErr('AUTH', 'session expired'); }
      if (!r.ok) throw codeErr('HTTP', 'refresh failed: HTTP ' + r.status); // server trouble: keep tokens, retry later
      var j; try { j = await r.json(); } catch (e) { throw codeErr('HTTP', 'refresh: bad response'); }
      self._saveTokens(j);
    })();
    this.refreshing = p;
    var clear = function () { self.refreshing = null; };
    p.then(clear, clear);
    return p;
  };
  // Authenticated REST call: refresh before expiry, and once on 401 (then retry once).
  SbClient.prototype.rest = async function (method, path, o) {
    var t = this.tokens();
    if (!t) throw codeErr('AUTH', 'not logged in');
    if (t.expires_at - 60 <= Math.floor(this.now() / 1000)) { await this._refresh(t.access_token); t = this.tokens(); if (!t) throw codeErr('AUTH', 'not logged in'); }
    var r = await this._send(method, path, o, t.access_token);
    if (r.status === 401) {
      await this._refresh(t.access_token);
      t = this.tokens(); if (!t) throw codeErr('AUTH', 'not logged in');
      r = await this._send(method, path, o, t.access_token);
      if (r.status === 401) { this._lost(); throw codeErr('AUTH', 'session rejected'); }
    }
    return r;
  };

  function SupabaseAdapter(client) { this.c = client; this.remote = true; }
  SupabaseAdapter.prototype.init = function () {
    return this.c.hasTokens() ? Promise.resolve() : Promise.reject(codeErr('AUTH', 'not logged in'));
  };
  // Pages with Range headers; follows Content-Range so a server page cap below 1000 still loads everything.
  SupabaseAdapter.prototype.list = async function (table) {
    var PAGE = 1000, from = 0, out = [];
    var filter = table === 'sets' ? '&deleted=eq.false' : ''; // workouts: deleted days are loaded too, so re-opening one is an explicit revive (PATCH), never a creation
    for (;;) {
      var r = await this.c.rest('GET', '/rest/v1/' + table + '?select=*&order=id.asc' + filter,
        { headers: { 'Range-Unit': 'items', Range: from + '-' + (from + PAGE - 1), Prefer: 'count=exact' } });
      if (r.status === 416) break; // range past the end
      if (!r.ok) throw codeErr('HTTP', 'read ' + table + ' failed: HTTP ' + r.status, { status: r.status });
      var rows = await r.json();
      if (!Array.isArray(rows)) throw codeErr('HTTP', 'read ' + table + ': bad response');
      out = out.concat(rows);
      var m = /(\d+)-(\d+)\/(\d+|\*)/.exec(r.headers.get('content-range') || '');
      if (!rows.length) break;
      if (m && m[3] !== '*') { if (Number(m[2]) + 1 >= Number(m[3])) break; from = Number(m[2]) + 1; }
      else { if (rows.length < PAGE) break; from += rows.length; }
    }
    return out;
  };
  function isPermanent(status) { return status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429; }
  function pickCols(table, row) {
    var o = {}; COLS[table].forEach(function (c) { if (row[c] !== undefined) o[c] = row[c]; });
    return o;
  }
  // A brand-new row omits a null `drops` (the server default is null), so plain sets also work before the drops column exists.
  function newRowBody(table, row) { var b = pickCols(table, row); if (table === 'sets' && b.drops === null) delete b.drops; return b; }
  // `changed` = columns the user changed on an EXISTING row: only those are PATCHed (never a whole-row overwrite, never
  // `deleted:false` unless that is the change). null = brand-new row -> full upsert. If the PATCH matches no row on the
  // server (it only ever existed offline) fall through to the upsert so FK order and history stay intact.
  SupabaseAdapter.prototype.put = async function (table, row, changed, extra) {
    if (!COLS[table]) throw new Error('unknown table ' + table);
    var J = { 'Content-Type': 'application/json' };
    function fail(r) { return codeErr('HTTP', 'write ' + table + ' failed: HTTP ' + r.status, { status: r.status, permanent: isPermanent(r.status) }); }
    if (changed) {
      var only = {}; changed.forEach(function (c) { only[c] = row[c]; });
      var patch = pickCols(table, only);
      if (!Object.keys(patch).length) return; // nothing the server stores changed
      var pr = await this.c.rest('PATCH', '/rest/v1/' + table + '?id=eq.' + encodeURIComponent(row.id),
        { headers: Object.assign({ Prefer: 'return=representation' }, J), body: JSON.stringify(patch) });
      if (!pr.ok) throw fail(pr);
      var hit; try { hit = await pr.json(); } catch (e) { hit = null; }
      if (Array.isArray(hit) && hit.length) return;
    }
    var r = await this.c.rest('POST', '/rest/v1/' + table + '?on_conflict=id',
      { headers: Object.assign({ Prefer: 'resolution=ignore-duplicates,return=minimal' }, J), body: JSON.stringify(newRowBody(table, row)) }); // creation is INSERT-ONLY: it can never overwrite an existing row
    if (!r.ok) throw fail(r);
    if (!changed && extra && extra.length) { // columns edited while the creation was still pending (the insert may have been ignored or may have carried them)
      var only2 = {}; extra.forEach(function (c) { only2[c] = row[c]; });
      var patch2 = pickCols(table, only2);
      if (Object.keys(patch2).length) {
        var er = await this.c.rest('PATCH', '/rest/v1/' + table + '?id=eq.' + encodeURIComponent(row.id), { headers: Object.assign({ Prefer: 'return=minimal' }, J), body: JSON.stringify(patch2) });
        if (!er.ok) throw fail(er);
      }
    }
  };
  // The server has no DELETE privilege; never attempt a remote wipe.
  SupabaseAdapter.prototype.clear = function () { return Promise.reject(new Error('remote wipe is not supported')); };

  // ------------------------------------------------------------------
  // Exercise photos (migration-003, OPTIONAL): a separate table exercise_photos(exercise_id pk, thumb data-URL, updated_at, removed).
  // Deliberately NOT part of Store/outbox/snapshot: a missing table, a failed upload or a full cache can never touch logging data.
  // state: 'unknown' (not asked yet / network trouble) | 'ok' | 'off' (table missing or not granted -> feature hidden, no errors).
  // ------------------------------------------------------------------
  var PHOTO_MAX_CHARS = 150000, PHOTO_PREFIX = 'data:image/jpeg;base64,';
  function fitSize(w, h, max) {
    w = Number(w); h = Number(h);
    if (!(w > 0 && h > 0)) throw new Error('bad image size');
    var k = Math.min(1, max / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
  }
  function validThumb(t) { return typeof t === 'string' && t.indexOf(PHOTO_PREFIX) === 0 && t.length > PHOTO_PREFIX.length && t.length <= PHOTO_MAX_CHARS; }
  function MemCache() { this.m = {}; }
  MemCache.prototype.all = function () { var self = this; return Promise.resolve(Object.keys(this.m).map(function (k) { return self.m[k]; })); };
  MemCache.prototype.put = function (rec) { this.m[rec.exercise_id] = rec; return Promise.resolve(); };
  function PhotoStore(client, cache) { this.c = client; this.cache = cache || new MemCache(); this.state = 'unknown'; this.recs = {}; this.ready = null; }
  PhotoStore.prototype.init = function () { // show what is cached at once (also offline); a broken cache is just an empty cache
    var self = this;
    this.ready = this.ready || Promise.resolve().then(function () { return self.cache.all(); }).then(function (list) { (list || []).forEach(function (r) { if (r && r.exercise_id) self.recs[r.exercise_id] = r; }); }, function () { /* cache unavailable */ });
    return this.ready;
  };
  PhotoStore.prototype.url = function (exId) { var r = this.recs[exId]; return r && !r.removed && validThumb(r.thumb) ? r.thumb : null; };
  PhotoStore.prototype.available = function () { return this.state === 'ok'; };
  PhotoStore.prototype._keep = function (rec) { this.recs[rec.exercise_id] = rec; return Promise.resolve(this.cache.put(rec)).catch(function () { /* cache full: keep in memory only */ }); };
  // Returns true when something changed (so the UI re-renders). Never throws.
  PhotoStore.prototype.sync = async function () {
    var self = this, changed = false;
    try {
      await this.init();
      var r = await this.c.rest('GET', '/rest/v1/exercise_photos?select=exercise_id,updated_at,removed&order=exercise_id.asc');
      if (r.status === 404 || r.status === 403) { this.state = 'off'; return false; } // migration not applied (PGRST205) / not granted
      if (!r.ok) return false; // network or server trouble: keep whatever state we had
      var rows = await r.json(); if (!Array.isArray(rows)) return false;
      this.state = 'ok';
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i], have = this.recs[row.exercise_id];
        if (have && have.updated_at === row.updated_at && !!have.removed === !!row.removed) continue;
        if (row.removed) { await this._keep({ exercise_id: row.exercise_id, thumb: '', updated_at: row.updated_at, removed: true }); changed = true; continue; }
        var g = await this.c.rest('GET', '/rest/v1/exercise_photos?exercise_id=eq.' + encodeURIComponent(row.exercise_id) + '&select=exercise_id,thumb,updated_at,removed');
        if (!g.ok) continue;
        var one = await g.json(); if (!Array.isArray(one) || !one.length || !validThumb(one[0].thumb)) continue;
        await this._keep({ exercise_id: one[0].exercise_id, thumb: one[0].thumb, updated_at: one[0].updated_at, removed: !!one[0].removed }); changed = true;
      }
    } catch (e) { /* offline etc.: the feature simply keeps what it has */ }
    return changed;
  };
  PhotoStore.prototype._write = async function (exId, body) { // update; if no row yet, insert-only create (never overwrites), then update again
    var J = { 'Content-Type': 'application/json' }, q = '?exercise_id=eq.' + encodeURIComponent(exId);
    function chk(r) { if (!r.ok) throw codeErr('HTTP', 'photo write failed: HTTP ' + r.status, { status: r.status }); return r; }
    async function patch(c) { var r = chk(await c.rest('PATCH', '/rest/v1/exercise_photos' + q, { headers: Object.assign({ Prefer: 'return=representation' }, J), body: JSON.stringify(body) })); var h = await r.json(); return Array.isArray(h) && h.length > 0; }
    if (await patch(this.c)) return;
    if (!body.thumb) return; // removing a photo that does not exist: nothing to do
    chk(await this.c.rest('POST', '/rest/v1/exercise_photos?on_conflict=exercise_id', { headers: Object.assign({ Prefer: 'resolution=ignore-duplicates,return=minimal' }, J), body: JSON.stringify({ exercise_id: exId, thumb: body.thumb, removed: false }) }));
    await patch(this.c); // the insert may have been ignored (someone else created it first): make ours the current one
  };
  // Explicit user actions: they throw on failure so the UI can say so. Nothing is queued and logging is never affected.
  PhotoStore.prototype.set = async function (exId, thumb, nowIso) {
    if (this.state !== 'ok') throw new Error('photos unavailable');
    if (!validThumb(thumb)) throw new Error('bad photo');
    var at = nowIso || new Date().toISOString();
    await this._write(exId, { thumb: thumb, removed: false, updated_at: at });
    await this._keep({ exercise_id: exId, thumb: thumb, updated_at: at, removed: false });
  };
  PhotoStore.prototype.remove = async function (exId, nowIso) {
    if (this.state !== 'ok') throw new Error('photos unavailable');
    var at = nowIso || new Date().toISOString();
    await this._write(exId, { removed: true, updated_at: at });
    await this._keep({ exercise_id: exId, thumb: '', updated_at: at, removed: true });
  };

  function nfcTrim(name) { return String(name === null || name === undefined ? '' : name).normalize('NFC').trim(); }
  async function emailFor(name) {
    var buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(nfcTrim(name)));
    var hex = Array.prototype.map.call(new Uint8Array(buf), function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
    return hex.slice(0, 16) + '@gymlog.app';
  }

  // Same interface as LocalAuth. login() verifies name+PIN on the server, loads data, and maps the name to a members row.
  function SupabaseAuth(client, store, kv) { this.c = client; this.store = store; this.kv = kv; this.remote = true; }
  SupabaseAuth.prototype.hasSession = function () { return this.c.hasTokens(); };
  SupabaseAuth.prototype.login = async function (name, pin) {
    if (!/^\d{4}$/.test(String(pin === null || pin === undefined ? '' : pin))) throw codeErr('PIN', 'PIN must be 4 digits');
    var n = nfcTrim(name);
    if (!n) throw codeErr('BAD', 'empty name');
    await this.c.signIn(await emailFor(n), 'gym' + pin);
    try { await this.store.load(); }
    catch (e) { this.c.clearTokens(); throw e; }
    var m = this.store.members().filter(function (x) { return nfcTrim(x.name) === n; })[0];
    if (!m) { this.c.clearTokens(); this.kv.removeItem('gl:session'); throw codeErr('NO_MEMBER', 'no member row for this name'); }
    this.kv.setItem('gl:session', m.id);
    return m;
  };
  SupabaseAuth.prototype.current = function () {
    if (!this.c.hasTokens()) return null;
    var id = this.kv.getItem('gl:session');
    var m = id ? this.store.member(id) : null;
    return m && !m.archived ? m : null;
  };
  SupabaseAuth.prototype.logout = function () { this.c.clearTokens(); this.kv.removeItem('gl:session'); }; // queued writes stay on the device

  // ------------------------------------------------------------------
  // Store
  // ------------------------------------------------------------------
  function defaultUid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    // no randomUUID (insecure context): still a valid UUID v4 because the server column is uuid
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });
  }
  function flagOf(table) { return (table === 'members' || table === 'exercises') ? 'archived' : 'deleted'; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function sortById(a) { return a.slice().sort(function (x, y) { return x.id < y.id ? -1 : x.id > y.id ? 1 : 0; }); }

  // Synchronous SHA-256 (hex). Used to derive a workout id from (member, date) so two clients creating the same day
  // upsert the SAME row.
  var SHA_K = [], SHA_H = [];
  (function () {
    var n = 2, i = 0;
    while (SHA_K.length < 64) {
      var prime = true; for (var d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
      if (prime) { if (i < 8) SHA_H.push(Math.floor((Math.sqrt(n) % 1) * 4294967296) >>> 0); SHA_K.push(Math.floor((Math.cbrt(n) % 1) * 4294967296) >>> 0); i++; }
      n++;
    }
  })();
  function sha256Hex(str) {
    var m = unescape(encodeURIComponent(String(str))), bytes = [], i, j;
    for (i = 0; i < m.length; i++) bytes.push(m.charCodeAt(i));
    var bitLen = bytes.length * 8; bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (i = 7; i >= 0; i--) bytes.push(i >= 4 ? 0 : (bitLen >>> (i * 8)) & 255);
    var H = SHA_H.slice(), W = new Array(64);
    function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
    for (var off = 0; off < bytes.length; off += 64) {
      for (i = 0; i < 16; i++) W[i] = ((bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) | (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3]) >>> 0;
      for (i = 16; i < 64; i++) {
        var s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3), s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d2 = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25), ch = (e & f) ^ (~e & g), t1 = (h + S1 + ch + SHA_K[i] + W[i]) >>> 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22), mj = (a & b) ^ (a & c) ^ (b & c), t2 = (S0 + mj) >>> 0;
        h = g; g = f; f = e; e = (d2 + t1) >>> 0; d2 = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H = [(H[0] + a) >>> 0, (H[1] + b) >>> 0, (H[2] + c) >>> 0, (H[3] + d2) >>> 0, (H[4] + e) >>> 0, (H[5] + f) >>> 0, (H[6] + g) >>> 0, (H[7] + h) >>> 0];
    }
    return H.map(function (x) { return ('00000000' + x.toString(16)).slice(-8); }).join('');
  }
  function workoutId(memberId, date) {
    var h = sha256Hex(memberId + ':' + date);
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-5' + h.slice(13, 16) + '-' + ((parseInt(h.charAt(16), 16) & 3) | 8).toString(16) + h.slice(17, 20) + '-' + h.slice(20, 32);
  }
  function validDate(s) {
    if (!DATE_RE.test(s || '')) return false;
    var p = s.split('-').map(Number), d = new Date(p[0], p[1] - 1, p[2]);
    return d.getFullYear() === p[0] && d.getMonth() === p[1] - 1 && d.getDate() === p[2];
  }
  function newStamp() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
  function keyOf(table, id) { return table + ':' + id; }
  function stable(o) { return JSON.stringify(Object.keys(o).sort().map(function (k) { return [k, o[k]]; })); }
  function diffCols(oldRow, row) {
    return Object.keys(row).filter(function (k) { return JSON.stringify(oldRow[k]) !== JSON.stringify(row[k]); });
  }
  function unionCols(a, b) { // null = "whole row" (a brand-new row) and absorbs everything
    if (a === null || b === null) return null;
    return a.concat(b.filter(function (c) { return a.indexOf(c) < 0; }));
  }

  function Store(adapter, opts) {
    opts = opts || {};
    this.a = adapter;
    this.kv = opts.kv || new MemoryStorage();
    this.now = opts.now || function () { return new Date().toISOString(); };
    this.uid = opts.uid || defaultUid;
    this.user = opts.user || null; // member id doing the edits (updated_by)
    this.t = {};
    TABLES.forEach(function (n) { this.t[n] = new Map(); }, this);
    this.pending = []; // {table,id,row,rev,changed,stamp}; changed=null -> brand-new row (full upsert), else the changed columns only
    this.status = 'saved'; // saved | saving | failed | rejected (nothing unsent, but the server refused something)
    this.lastError = null;
    this.memoryOnly = false; // a local-storage write failed: unsent changes exist only in memory
    this._memFail = { pending: false, rejected: false }; // per destination; memoryOnly = any of them
    this.listeners = [];
    this.flushing = null;
    this.rejected = []; // {table,row,changed,status,error}: the server permanently refused it; durable, visible, retryable
    this.offline = false; // opened from the local snapshot because the server was unreachable
    // Single-writer lease (remote mode): only ONE tab per storage may write; others are read-only and the Store refuses writes.
    this.leaseOn = !!opts.lease; this.leaseId = newStamp(); this.leaseNow = opts.leaseNow || Date.now;
    this.leaseDelay = opts.leaseDelay === undefined ? 80 : opts.leaseDelay; this.leaseTtl = 8000;
    this.writer = !this.leaseOn;
    this.gen = 0; // ownership/load generation: bumped when the lease is lost or a load adopts the queue; async completions from an older one do nothing
    this._ver = 0; // bumps on every local change / completed write (lets refresh() detect a race)
  }

  Store.prototype.on = function (fn) { this.listeners.push(fn); };
  Store.prototype._emit = function () {
    var info = { status: this.status, pending: this.pending.length, error: this.lastError, rejected: this.rejected.length, offline: this.offline, memoryOnly: this.memoryOnly };
    this.listeners.forEach(function (fn) { try { fn(info); } catch (e) { /* listener errors never break saving */ } });
  };
  Store.prototype._idleStatus = function () { return this.pending.length ? 'saving' : this.rejected.length ? 'rejected' : 'saved'; };
  function readList(kv, key) {
    var raw = kv.getItem(key);
    if (!raw) return [];
    try { var a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  // The durable outbox belongs to the single writer (see the lease below): it is simply the current queue.
  Store.prototype._persistPending = function () {
    if (!this._owns()) return; // never clobber the outbox of the tab that now owns it
    try {
      this.kv.setItem('gl:pending', JSON.stringify(this.pending.map(function (p) { return { table: p.table, row: p.row, changed: p.changed, extra: p.extra, stamp: p.stamp }; })));
      this._mem('pending', false);
    } catch (e) {
      this.lastError = 'local-persist: ' + e.message;
      this._mem('pending', true);
      this.status = 'failed';
    }
  };
  Store.prototype._mem = function (dest, bad) { this._memFail[dest] = bad; this.memoryOnly = this._memFail.pending || this._memFail.rejected; };
  // Refused writes are durable too (shown after a reload with a badge, retry/edit possible).
  Store.prototype._persistRejected = function () {
    if (!this._owns()) return;
    try {
      this.kv.setItem('gl:rejected', JSON.stringify(this.rejected));
      this._mem('rejected', false);
    } catch (e) { this.lastError = 'local-persist: ' + e.message; this._mem('rejected', true); this.status = 'failed'; }
  };
  Store.prototype.isRejected = function (table, id) { return this.rejected.some(function (r) { return r.table === table && r.row.id === id; }); };
  // Offline start: a copy of the server tables from the last successful load/refresh.
  Store.prototype._saveSnap = function (lists) {
    try { this.kv.setItem('gl:snap', JSON.stringify({ at: this.now(), t: lists })); } catch (e) { /* too big / quota: just no offline start */ }
  };
  Store.prototype._readSnap = function () {
    var raw = this.kv.getItem('gl:snap');
    if (!raw) return null;
    try { var s = JSON.parse(raw); return s && s.t && TABLES.every(function (n) { return Array.isArray(s.t[n]); }) ? s.t : null; } catch (e) { return null; }
  };

  // ---- single-writer lease: localStorage key gl:lease = {id, ts}; owner renews every ~2s, free when older than 8s ----
  Store.prototype._leaseRead = function () {
    try { var l = JSON.parse(this.kv.getItem('gl:lease')); return l && typeof l.id === 'string' ? l : null; } catch (e) { return null; }
  };
  Store.prototype._leaseFree = function () {
    var l = this._leaseRead(), now = this.leaseNow();
    return !l || l.id === this.leaseId || typeof l.ts !== 'number' || now - l.ts >= this.leaseTtl || l.ts > now + this.leaseTtl; // future ts (clock skew) = expired
  };
  Store.prototype._leaseWrite = function () { try { this.kv.setItem('gl:lease', JSON.stringify({ id: this.leaseId, ts: this.leaseNow() })); return true; } catch (e) { return false; } };
  // Claim: write, wait a moment, read back - a simultaneous starter that wrote later wins, the other sees that and stays read-only.
  Store.prototype._claim = async function () {
    if (!this._leaseFree() || !this._leaseWrite()) return false;
    var d = this.leaseDelay; if (d > 0) await new Promise(function (r) { setTimeout(r, d); }); else await Promise.resolve();
    var l = this._leaseRead(); return !!(l && l.id === this.leaseId);
  };
  Store.prototype._holdsLease = function () { if (!this.leaseOn) return true; var l = this._leaseRead(); return !!(l && l.id === this.leaseId); };
  // Another tab owns the outbox now: drop our in-memory copy WITHOUT touching storage (the new writer adopted it).
  Store.prototype._lostLease = function () {
    this.gen++; this.flushing = null; // old callbacks are void, and a later flush() must not reuse the old in-flight promise
    this.writer = false; this.pending = []; this.rejected = []; this.status = 'saved'; this._emit();
  };
  // The persistence fence: true only when this store is the writer per the ACTUAL lease in storage (not the cached flag).
  // If the lease is no longer ours it demotes the store and returns false.
  Store.prototype._owns = function () {
    if (!this.leaseOn) return true;
    if (!this.writer) return false;
    if (this._holdsLease()) return true;
    this._lostLease(); return false;
  };
  // An async completion is stale when the generation moved on or the lease is no longer ours.
  Store.prototype._stale = function (gen) { return gen !== this.gen || !this._owns(); };
  Store.prototype.releaseLease = function () {
    if (this.leaseOn && this._holdsLease()) { try { this.kv.removeItem('gl:lease'); } catch (e) { /* best effort */ } }
    if (this.leaseOn) this.writer = false;
  };
  // Called every ~2-3s. Writer: renew (or notice the loss). Reader: when the lease is free, take over via load()
  // (durable outbox + fresh data BEFORE writes are enabled). Resolves true when this call made us the writer.
  Store.prototype.leaseTick = async function () {
    if (!this.leaseOn) return false;
    if (this.writer) {
      if (this._holdsLease()) this._leaseWrite(); else this._lostLease();
      return false;
    }
    if (this._ldp || !this._leaseFree()) return false;
    await this.load();
    return this.writer;
  };

  // one load at a time (login, boot and the lease takeover may all ask)
  Store.prototype.load = function () {
    var self = this;
    if (this._ldp) return this._ldp;
    this._ldp = this._load().then(function (r) { self._ldp = null; return r; }, function (e) { self._ldp = null; throw e; });
    return this._ldp;
  };
  Store.prototype._load = async function () {
    var got = !this.leaseOn || this.writer || await this._claim();
    await this.a.init();
    var lists = {}, self = this;
    try {
      for (var i = 0; i < TABLES.length; i++) lists[TABLES[i]] = await this.a.list(TABLES[i]);
      this.offline = false;
      this._saveSnap(lists);
    } catch (e) {
      var snap = e && e.code === 'NET' ? this._readSnap() : null; // never fall back on auth errors
      if (!snap) throw e;
      lists = snap; this.offline = true;
    }
    TABLES.forEach(function (n) { self.t[n] = new Map(lists[n].map(function (r) { return [r.id, r]; })); });
    this.writer = got; if (got) this.gen++; // only now (nothing awaited from here to the end of adoption) are writes enabled
    if (!this.writer) { this.status = 'saved'; this._emit(); return; } // read-only tab: server data only, the outbox belongs to the writer
    // unsent work from earlier sessions (a dead tab's outbox is adopted here, once)
    readList(this.kv, 'gl:pending').forEach(function (p) {
      if (!p || !p.table || !p.row || !self.t[p.table]) return;
      // a login after a session loss reloads in the same page: never queue (or overwrite) what is already in memory
      if (self.pending.some(function (x) { return x.table === p.table && x.id === p.row.id; })) return;
      self.t[p.table].set(p.row.id, p.row);
      self.pending.push({ table: p.table, id: p.row.id, row: p.row, rev: 0, changed: p.changed === undefined ? null : p.changed, extra: p.extra, stamp: p.stamp || newStamp() });
    });
    this.pending.forEach(function (p) { self.t[p.table].set(p.id, p.row); });
    // refused work from earlier sessions stays visible
    readList(this.kv, 'gl:rejected').forEach(function (r) {
      if (!r || !r.table || !r.row || !self.t[r.table]) return;
      if (self.pending.some(function (x) { return x.table === r.table && x.id === r.row.id; })) return;
      self.t[r.table].set(r.row.id, r.row); // (a second load in the same page must keep refused rows visible too)
      if (!self.isRejected(r.table, r.row.id)) self.rejected.push(r);
    });
    this.status = this._idleStatus(); this._emit();
    if (this.pending.length) { this.status = 'saving'; this._emit(); await this.flush(); }
  };

  // Re-read the server (friend's new entries). Local unsent changes always win; if anything local changed while
  // reading, the result is discarded (the next refresh picks it up). Resolves true when visible data changed.
  Store.prototype.refresh = async function () {
    var ver = this._ver, fresh = {}, self = this;
    for (var i = 0; i < TABLES.length; i++) fresh[TABLES[i]] = await this.a.list(TABLES[i]);
    if (ver !== this._ver) return false;
    var changed = this.offline;
    this.offline = false;
    TABLES.forEach(function (t) {
      var m = new Map(fresh[t].map(function (r) { return [r.id, r]; }));
      self.rejected.forEach(function (r) { if (r.table === t) m.set(r.row.id, r.row); }); // keep refused rows visible
      self.pending.forEach(function (p) { if (p.table === t) m.set(p.id, p.row); });
      var old = self.t[t];
      if (old.size !== m.size) changed = true;
      else m.forEach(function (r, id) { if (!old.has(id) || stable(old.get(id)) !== stable(r)) changed = true; });
      self.t[t] = m;
    });
    this._saveSnap(fresh);
    if (changed) this._emit();
    return changed;
  };

  // `changed`: columns that differ from the row we last knew. Only those are sent for an existing row, so a stale
  // form can never overwrite another client's other fields or resurrect a row they deleted. New rows send everything.
  Store.prototype._commit = function (table, row, stamp) {
    if (this.leaseOn && this.writer && !this._holdsLease()) this._lostLease(); // we were suspended and someone took over
    if (!this.writer) throw new Error('read-only: another window is the writer');
    row = clone(row);
    if (stamp !== false) { row.updated_at = this.now(); row.updated_by = this.user; }
    var old = this.t[table].get(row.id), changedNow = old ? diffCols(old, row) : null;
    this.t[table].set(row.id, row);
    var k = keyOf(table, row.id);
    var refused = this.rejected.filter(function (r) { return keyOf(r.table, r.row.id) === k; })[0];
    if (refused) { // edited again: gets a fresh attempt, and carries every column the server has not accepted yet
      changedNow = unionCols(refused.changed === undefined ? null : refused.changed, changedNow);
      this.rejected = this.rejected.filter(function (r) { return keyOf(r.table, r.row.id) !== k; });
      this._persistRejected();
    }
    var hit = this.pending.filter(function (p) { return p.table === table && p.id === row.id; })[0];
    if (hit) {
      if (hit.changed === null && changedNow) hit.extra = unionCols(hit.extra || [], changedNow); // an edit of a still-pending creation: sent as a PATCH after the insert-only POST
      hit.row = row; hit.rev++; hit.stamp = newStamp(); hit.changed = unionCols(hit.changed, changedNow);
    }
    else this.pending.push({ table: table, id: row.id, row: row, rev: 0, changed: changedNow, stamp: newStamp() });
    this._ver++;
    this._persistPending();
    if (!this.memoryOnly) this.status = 'saving';
    this._emit();
    return row;
  };

  // Sequential per-row writes. Resolves true when queue is empty, false when a write failed (data stays queued).
  Store.prototype._run = async function () {
    if (this.leaseOn && !this.writer) return true; // read-only: nothing to send, the writer owns the outbox
    var gen = this.gen;
    this.status = this.pending.length ? (this.memoryOnly ? 'failed' : 'saving') : this._idleStatus();
    this._emit();
    while (this.pending.length) {
      if (this._stale(gen)) return true; // never send once another tab owns the outbox
      var item = this.pending[0], rev = item.rev;
      try { await this.a.put(item.table, item.row, item.changed, item.extra); }
      catch (e) {
        if (this._stale(gen)) return true; // ownership changed while the request was out: touch nothing
        if (e && e.permanent && item.rev === rev) { // never block the queue behind a row the server will not take
          this.pending.splice(this.pending.indexOf(item), 1); this._ver++;
          this.rejected.push({ table: item.table, row: item.row, changed: item.changed, extra: item.extra, status: e.status, error: String(e.message || e) });
          this._persistPending(); this._persistRejected();
          this.lastError = String(e.message || e);
          continue;
        }
        if (e && e.permanent) continue; // a newer version of this row was queued meanwhile: try that one
        this.status = 'failed'; this.lastError = String(e && e.message || e); this._emit(); return false;
      }
      if (this._stale(gen)) return true; // (a stale response must not remove, persist or report anything)
      this._ver++;
      if (item.rev === rev) { var ix = this.pending.indexOf(item); if (ix >= 0) this.pending.splice(ix, 1); } // exact operation identity, never shift(); else a newer version was queued meanwhile: write it next
      this._persistPending();
    }
    if (!this.pending.length) this._mem('pending', false); // nothing unsent is left in the queue (refused rows keep their own flag)
    if (!this.rejected.length) this._mem('rejected', false);
    this.lastError = this.rejected.length ? this.lastError : null; this.status = this._idleStatus();
    if (!this.rejected.length && !this.offline && this.a.remote) { // everything is on the server: keep the offline-start snapshot current
      var lists = {}, self = this; TABLES.forEach(function (t) { lists[t] = Array.from(self.t[t].values()); }); this._saveSnap(lists);
    }
    this._emit();
    return true;
  };
  Store.prototype.flush = function () {
    var self = this;
    if (this.flushing) return this.flushing;
    // the in-flight marker is set AFTER _run() is created and cleared only in .then, so an empty-queue
    // run (which finishes synchronously) can never leave a stale marker behind
    var p = this._run().then(function (r) { if (self.flushing === p) self.flushing = null; return r; }, function (e) { if (self.flushing === p) self.flushing = null; throw e; });
    this.flushing = p;
    return p;
  };
  // Put every refused row back in the queue (after the cause was fixed) and send again.
  Store.prototype.retryRejected = async function () {
    if (!this._owns()) return false; // a stale former holder must not touch either queue
    var self = this, back = this.rejected; this.rejected = [];
    back.forEach(function (r) {
      self.pending.push({ table: r.table, id: r.row.id, row: r.row, rev: 0, changed: r.changed === undefined ? null : r.changed, extra: r.extra, stamp: newStamp() });
    });
    this._persistRejected(); this._persistPending(); this.status = this._idleStatus(); this._emit();
    var ok = await this.flush();
    return ok && !this.rejected.length;
  };
  Store.prototype.retry = function () { return this.flush(); };
  Store.prototype.idle = async function () { while (this.flushing) await this.flushing; };

  // ---- reads ----
  Store.prototype._all = function (table, includeFlagged) {
    var f = flagOf(table);
    return Array.from(this.t[table].values()).filter(function (r) { return includeFlagged || !r[f]; });
  };
  Store.prototype.members = function (inc) {
    return this._all('members', inc).sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
  };
  Store.prototype.exercises = function (inc) {
    return this._all('exercises', inc).sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
  };
  Store.prototype.member = function (id) { return this.t.members.get(id) || null; };
  Store.prototype.exercise = function (id) { return this.t.exercises.get(id) || null; };
  // Legacy data may hold several workouts for one (member,date). The deterministic one wins as "the" day; every read
  // below merges all live workouts of that day so no set is ever hidden.
  Store.prototype._dayWorkouts = function (memberId, date) {
    return this._all('workouts').filter(function (w) { return w.member_id === memberId && w.date === date; })
      .sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
  };
  Store.prototype.workoutFor = function (memberId, date) {
    var list = this._dayWorkouts(memberId, date), id = workoutId(memberId, date);
    return list.filter(function (w) { return w.id === id; })[0] || list[0] || null;
  };
  Store.prototype._dayIds = function (wid) {
    var w = this.t.workouts.get(wid);
    if (!w || w.deleted) return [];
    return this._dayWorkouts(w.member_id, w.date).map(function (x) { return x.id; });
  };
  Store.prototype._liveSets = function () {
    var self = this;
    return this._all('sets').filter(function (s) {
      var w = self.t.workouts.get(s.workout_id);
      return w && !w.deleted;
    });
  };
  function byPos(a, b) { return a.position - b.position || (a.updated_at || '') .localeCompare(b.updated_at || '') || (a.id < b.id ? -1 : 1); }
  Store.prototype.setsForWorkout = function (wid) {
    var ids = this._dayIds(wid);
    return this._liveSets().filter(function (s) { return ids.indexOf(s.workout_id) >= 0; }).sort(byPos);
  };
  Store.prototype.blocksForWorkout = function (wid) {
    var self = this, order = [], map = {};
    this.setsForWorkout(wid).forEach(function (s) {
      var ex = self.exercise(s.exercise_id);
      if (!ex) return; // dangling reference (should not exist): never render a null exercise
      if (!map[s.exercise_id]) { map[s.exercise_id] = { exercise: ex, sets: [] }; order.push(s.exercise_id); }
      map[s.exercise_id].sets.push(s);
    });
    return order.map(function (id) { return map[id]; });
  };
  // member's live days grouped by date: {date: {ids:[workout ids], workout: canonical}}
  Store.prototype._dayGroups = function (memberId) {
    var g = {}, self = this;
    this._all('workouts').filter(function (w) { return w.member_id === memberId; }).forEach(function (w) {
      (g[w.date] = g[w.date] || { ids: [] }).ids.push(w.id);
    });
    Object.keys(g).forEach(function (d) { g[d].workout = self.workoutFor(memberId, d); });
    return g;
  };
  Store.prototype.historyDays = function (memberId) {
    var live = this._liveSets(), g = this._dayGroups(memberId);
    return Object.keys(g).map(function (d) {
      var ss = live.filter(function (s) { return g[d].ids.indexOf(s.workout_id) >= 0; });
      var ex = {}; ss.forEach(function (s) { ex[s.exercise_id] = 1; });
      return { workout: g[d].workout, date: d, exerciseCount: Object.keys(ex).length, setCount: ss.length };
    }).filter(function (d) { return d.setCount > 0; })
      .sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
  };
  Store.prototype.lastSession = function (memberId, exerciseId, beforeDate) {
    var live = this._liveSets(), g = this._dayGroups(memberId), best = null;
    Object.keys(g).forEach(function (d) {
      if (d >= beforeDate) return;
      var ss = live.filter(function (s) { return g[d].ids.indexOf(s.workout_id) >= 0 && s.exercise_id === exerciseId; });
      if (ss.length && (!best || d > best.date)) best = { date: d, sets: ss.sort(byPos) };
    });
    return best ? best.sets : [];
  };
  // Most recent EARLIER session of this exercise (this member) that has working sets -> the working sets (warm-ups skipped).
  Store.prototype._lastWorking = function (memberId, exerciseId, beforeDate) {
    var live = this._liveSets(), g = this._dayGroups(memberId), best = null;
    Object.keys(g).forEach(function (d) {
      if (d >= beforeDate) return;
      var ss = live.filter(function (s) { return g[d].ids.indexOf(s.workout_id) >= 0 && s.exercise_id === exerciseId && !s.is_warmup; });
      if (ss.length && (!best || d > best.date)) best = { date: d, sets: ss.sort(byPos) };
    });
    return best ? best.sets : [];
  };
  // "지난번" line: `50 - 60 - 60(40,20)`, '' when there is nothing to show
  Store.prototype.lastLine = function (memberId, exerciseId, beforeDate) { return formatSets(this._lastWorking(memberId, exerciseId, beforeDate)); };
  // Weight the nudge chips start from when the weight field is empty: last set of this exercise on that day, else the
  // last working set of the previous session, else null.
  Store.prototype.nudgeBase = function (memberId, exerciseId, date) {
    var w = this.workoutFor(memberId, date), today = w ? this.setsForWorkout(w.id).filter(function (s) { return s.exercise_id === exerciseId && s.weight !== null; }) : [];
    if (today.length) return today[today.length - 1].weight;
    var prev = this._lastWorking(memberId, exerciseId, date).filter(function (s) { return s.weight !== null; });
    return prev.length ? prev[prev.length - 1].weight : null;
  };
  // Copy a day (rows are created by the normal insert-only path). opts.sets=false only reports the exercise list.
  // Archived exercises are skipped. Returns {sets, exercises, exerciseIds, ids}; undoCopy(result) soft-deletes what was created.
  Store.prototype.copyDay = function (fromMember, fromDate, toMember, toDate, opts) {
    var self = this, src = this.workoutFor(fromMember, fromDate);
    if (fromMember === toMember && fromDate === toDate) throw new Error('same day');
    var blocks = src ? this.blocksForWorkout(src.id).filter(function (b) { return !b.exercise.archived; }) : [];
    if (!blocks.length) throw new Error('nothing to copy');
    var res = { sets: 0, exercises: blocks.length, exerciseIds: blocks.map(function (b) { return b.exercise.id; }), ids: [] };
    if (!(opts && opts.sets)) return res;
    var w = this.getOrCreateWorkout(toMember, toDate);
    blocks.forEach(function (b) {
      b.sets.forEach(function (s) { res.ids.push(self.addSet(w.id, b.exercise.id, { weight: s.weight, drops: s.drops, note: s.note, is_warmup: s.is_warmup }).id); res.sets++; });
    });
    return res;
  };
  Store.prototype.undoCopy = function (res) {
    var self = this;
    (res.ids || []).forEach(function (id) { var s = self.t.sets.get(id); if (s && !s.deleted) self.deleteSet(id); });
  };
  Store.prototype.recentExerciseIds = function () {
    var wd = {}, self = this, last = {};
    this._all('workouts').forEach(function (w) { wd[w.id] = w.date; });
    this._liveSets().forEach(function (s) {
      var key = wd[s.workout_id] + ' ' + (s.updated_at || '');
      if (!last[s.exercise_id] || key > last[s.exercise_id]) last[s.exercise_id] = key;
    });
    return Object.keys(last).sort(function (a, b) { return last[a] < last[b] ? 1 : -1; });
  };
  // Per-date aggregated points for one exercise across the given members.
  Store.prototype.seriesFor = function (exerciseId, o) {
    o = o || {};
    var ids = o.memberIds || null, since = o.since || null, until = o.until || null, byWid = {}, wk = {};
    this._all('workouts').forEach(function (w) {
      if (ids && ids.indexOf(w.member_id) < 0) return;
      if (since && w.date < since) return;
      if (until && w.date > until) return;
      wk[w.id] = w;
    });
    var perDate = {};
    this._liveSets().forEach(function (s) {
      if (s.exercise_id !== exerciseId || !wk[s.workout_id]) return;
      var d = wk[s.workout_id].date;
      (perDate[d] = perDate[d] || []).push(s);
    });
    return Object.keys(perDate).sort().map(function (d) {
      var st = dayStats(perDate[d], { includeWarmup: o.includeWarmup });
      return st ? { date: d, count: st.count, avg: st.avg, max: st.max } : null;
    }).filter(Boolean);
  };
  Store.prototype.bodyPartSummary = function (bp, o) {
    var self = this;
    return this.exercises(true).filter(function (e) { return e.body_part === bp; }).map(function (e) {
      var pts = self.seriesFor(e.id, o);
      if (!pts.length) return null;
      var wk = {};
      self._all('workouts').forEach(function (w) { wk[w.id] = w; });
      var sess = {};
      self._liveSets().forEach(function (s) {
        var w = wk[s.workout_id];
        if (s.exercise_id !== e.id || !w) return;
        if (o && o.memberIds && o.memberIds.indexOf(w.member_id) < 0) return;
        if (o && o.since && w.date < o.since) return;
        if (o && o.until && w.date > o.until) return;
        if (!dayStats([s], o)) return;
        sess[w.member_id + '|' + w.date] = 1;
      });
      var d = delta(pts);
      return { exercise: e, sessions: Object.keys(sess).length, latestAvg: d.latest.avg, change: d.diff };
    }).filter(Boolean);
  };

  // ---- writes ----
  Store.prototype._newRow = function (table, fields) {
    var r = Object.assign({ id: this.uid() }, fields);
    return this._commit(table, r);
  };
  function cleanName(n) {
    n = String(n || '').trim();
    if (!n) throw new Error('empty name');
    return n;
  }
  Store.prototype.addMember = function (name) {
    name = cleanName(name);
    if (this.members().some(function (m) { return m.name === name; })) throw new Error('duplicate member');
    return this._newRow('members', { name: name, archived: false });
  };
  Store.prototype.renameMember = function (id, name) {
    name = cleanName(name);
    var m = this.member(id); if (!m) throw new Error('no member');
    if (this.members().some(function (x) { return x.name === name && x.id !== id; })) throw new Error('duplicate member');
    return this._commit('members', Object.assign({}, m, { name: name }));
  };
  // Feature detection (migration-002 may not be applied): the server returns every column with select=*, so rows that carry a
  // `memo` key mean the column exists (and 가슴 is allowed by the same migration). The browser-only backend always supports both.
  Store.prototype.supportsMemo = function () {
    if (!this.a.remote) return true;
    var all = this._all('exercises'); for (var i = 0; i < all.length; i++) if ('memo' in all[i]) return true;
    return false;
  };
  Store.prototype.supportsChest = Store.prototype.supportsMemo;
  Store.prototype.bodyParts = function () { var ok = this.supportsChest(); return BODY_PARTS.filter(function (b) { return ok || b !== '가슴'; }); };
  function cleanMemo(m) {
    if (m === undefined || m === null) return '';
    if (typeof m !== 'string') throw new Error('invalid memo');
    m = m.trim(); if (m.length > MEMO_MAX) throw new Error('memo too long'); return m;
  }
  // Client-side hint only (never written): first matching rule wins, so 트라이셉스벤치프레스 is 삼두, 레그컬 is 하체.
  var HINTS = [['삼두', ['트라이셉스', '푸쉬다운', '푸시다운', '킥백']], ['하체', ['레그', '스쿼트', '런지']], ['이두', ['컬']], ['어깨', ['사레레', '숄더', '레터럴']],
    ['등', ['풀업', '로우', '랫풀', '턱걸이']], ['가슴', ['벤치', '체스트', '인클라인', '펙덱', '푸쉬업', '푸시업']]];
  function suggestBodyPart(name) {
    var n = String(name || '').replace(/\s+/g, '');
    for (var i = 0; i < HINTS.length; i++) for (var j = 0; j < HINTS[i][1].length; j++) if (n.indexOf(HINTS[i][1][j]) >= 0) return HINTS[i][0];
    return null;
  }
  Store.prototype.addExercise = function (name, bodyPart, memo) {
    name = cleanName(name); assertBodyPart(bodyPart);
    if (bodyPart === '가슴' && !this.supportsChest()) throw new Error('invalid body_part');
    memo = cleanMemo(memo);
    if (memo && !this.supportsMemo()) throw new Error('memo unsupported');
    if (this.exercises().some(function (e) { return e.name === name; })) throw new Error('duplicate exercise');
    var f = { name: name, body_part: bodyPart, archived: false }; if (this.supportsMemo()) f.memo = memo;
    return this._newRow('exercises', f);
  };
  Store.prototype.updateExercise = function (id, patch) {
    var e = this.exercise(id); if (!e) throw new Error('no exercise');
    var n = Object.assign({}, e);
    if (patch.name !== undefined) {
      n.name = cleanName(patch.name);
      if (this.exercises().some(function (x) { return x.name === n.name && x.id !== id; })) throw new Error('duplicate exercise');
    }
    if (patch.body_part !== undefined) {
      assertBodyPart(patch.body_part); n.body_part = patch.body_part;
      if (patch.body_part === '가슴' && patch.body_part !== e.body_part && !this.supportsChest()) throw new Error('invalid body_part');
    }
    if (patch.memo !== undefined) {
      var m = cleanMemo(patch.memo);
      if (m !== (e.memo || '')) { if (!this.supportsMemo()) throw new Error('memo unsupported'); n.memo = m; }
    }
    return this._commit('exercises', n);
  };
  Store.prototype.seedExercisesIfFirstRun = function () {
    if (this.a.remote || this.kv.getItem('gl:seeded') || this.t.exercises.size) return false; // server data is seeded by the owner
    var self = this;
    SEED_EXERCISES.forEach(function (e) { self.addExercise(e.name, e.body_part); });
    this.kv.setItem('gl:seeded', '1');
    return true;
  };
  // One workout per (member,date): the id is derived from both, so two clients creating the same day write the SAME row.
  Store.prototype.getOrCreateWorkout = function (memberId, date) {
    if (!validDate(date)) throw new Error('bad date');
    if (!this.member(memberId)) throw new Error('no member');
    var live = this.workoutFor(memberId, date);
    if (live) return live;
    var id = workoutId(memberId, date), dead = this.t.workouts.get(id);
    if (dead) return this._commit('workouts', Object.assign({}, dead, { deleted: false })); // revive
    return this._newRow('workouts', { id: id, member_id: memberId, date: date, note: '', deleted: false });
  };
  Store.prototype.addSet = function (workoutId, exerciseId, fields) {
    var v = validateSetFields(fields);
    if (!v.ok) throw new Error('invalid set: ' + v.error);
    if (!this.exercise(exerciseId)) throw new Error('no exercise');
    var pos = this.setsForWorkout(workoutId).reduce(function (m, s) { return Math.max(m, s.position); }, 0) + 1;
    return this._newRow('sets', Object.assign({
      workout_id: workoutId, exercise_id: exerciseId, position: pos, deleted: false
    }, v.value));
  };
  // `base` = the field values the edit form was OPENED with. Only fields the user really changed relative to it are
  // applied; the rest keep the current (possibly refreshed) value, so a background refresh never turns an untouched
  // input into a change.
  Store.prototype.updateSet = function (id, fields, base) {
    var s = this.t.sets.get(id); if (!s) throw new Error('no set');
    if (base) {
      var cur = { weight: s.weight === null ? '' : s.weight, drops: s.drops && s.drops.length ? s.drops.join(',') : '', note: s.note, is_warmup: s.is_warmup }, eff = {};
      Object.keys(fields).forEach(function (k) { eff[k] = (k in base && String(base[k]) === String(fields[k])) ? cur[k] : fields[k]; });
      fields = eff;
    }
    var v = validateSetFields(fields);
    if (!v.ok) throw new Error('invalid set: ' + v.error);
    var inverse = [{ table: 'sets', prev: clone(s) }];
    this._commit('sets', Object.assign({}, s, v.value));
    return inverse;
  };
  // Soft deletes return an undo token (inverse = exact previous rows).
  Store.prototype._softDelete = function (table, rows) {
    var self = this, flag = flagOf(table), inverse = [];
    rows.forEach(function (r) {
      inverse.push({ table: table, prev: clone(r) });
      var n = clone(r); n[flag] = true; self._commit(table, n);
    });
    return inverse;
  };
  Store.prototype.deleteSet = function (id) { return this._softDelete('sets', [this.t.sets.get(id)]); };
  Store.prototype.deleteExerciseBlock = function (workoutId, exerciseId) {
    return this._softDelete('sets', this.setsForWorkout(workoutId).filter(function (s) { return s.exercise_id === exerciseId; }));
  };
  Store.prototype.deleteDay = function (wid) { var self = this; return this._softDelete('workouts', this._dayIds(wid).map(function (id) { return self.t.workouts.get(id); })); };
  Store.prototype.archiveExercise = function (id, flag) {
    var e = this.exercise(id), inverse = [{ table: 'exercises', prev: clone(e) }];
    this._commit('exercises', Object.assign({}, e, { archived: flag !== false }));
    return inverse;
  };
  Store.prototype.archiveMember = function (id, flag) {
    var m = this.member(id), inverse = [{ table: 'members', prev: clone(m) }];
    this._commit('members', Object.assign({}, m, { archived: flag !== false }));
    return inverse;
  };
  Store.prototype.undo = function (inverse) {
    var self = this;
    inverse.forEach(function (i) { self._commit(i.table, i.prev, false); }); // exact snapshot, no re-stamp
  };

  // ---- export / import ----
  Store.prototype.exportData = function () {
    var out = { app: 'gymlog', version: 2, exported_at: this.now() }, self = this;
    TABLES.forEach(function (t) { out[t] = sortById(Array.from(self.t[t].values()).map(clone)); });
    out.sets = out.sets.map(upgradeSet); // legacy 무게2 never leaves the app as a column: it is kept in the note
    return out;
  };
  // The old second weight (무게2) has no meaning any more; keep its value visible in the note so nothing is lost.
  function upgradeSet(r) {
    var n = clone(r);
    if (n.weight2 !== null && n.weight2 !== undefined) n.note = (n.note ? n.note + ' ' : '') + '무게2: ' + fmtNum(n.weight2);
    delete n.weight2;
    if (n.drops === undefined) n.drops = null;
    return n;
  }
  function validateImport(o, existing) {
    function bad(m) { throw new Error('import rejected: ' + m); }
    if (!o || typeof o !== 'object' || o.app !== 'gymlog') bad('not a gymlog backup');
    if (o.version !== 1 && o.version !== 2) bad('unsupported version');
    TABLES.forEach(function (t) { if (!Array.isArray(o[t])) bad('missing table ' + t); });
    function str(v) { return typeof v === 'string' && v.length > 0; }
    o.members.forEach(function (r) { if (!r || !str(r.id) || !str(r.name) || typeof r.archived !== 'boolean') bad('member row'); });
    o.exercises.forEach(function (r) {
      if (!r || !str(r.id) || !str(r.name) || typeof r.archived !== 'boolean') bad('exercise row');
      if (BODY_PARTS.indexOf(r.body_part) < 0) bad('exercise body_part');
      if (r.memo !== undefined && r.memo !== null && typeof r.memo !== 'string') bad('exercise memo');
    });
    o.workouts.forEach(function (r) {
      if (!r || !str(r.id) || !str(r.member_id) || !DATE_RE.test(r.date || '') || typeof r.deleted !== 'boolean') bad('workout row');
      if (!validDate(r.date)) bad('impossible date ' + r.date);
    });
    o.sets.forEach(function (r) {
      if (!r || !str(r.id) || !str(r.workout_id) || !str(r.exercise_id) || typeof r.deleted !== 'boolean') bad('set row');
      var wOk = okNum(r.weight);
      if (!wOk && !(o.version === 2 && r.weight === null && r.is_warmup === true)) bad('set weight');
      if (r.drops !== undefined && r.drops !== null && !(Array.isArray(r.drops) && r.drops.every(okNum))) bad('set drops');
      if (r.is_warmup === true && Array.isArray(r.drops) && r.drops.length) bad('warm-up with drops');
      if (r.weight2 !== null && r.weight2 !== undefined && !okNum(r.weight2)) bad('set weight2');
      if (typeof r.is_warmup !== 'boolean' || !Number.isFinite(r.position)) bad('set flags');
    });
    // duplicate ids inside one table
    TABLES.forEach(function (t) { var seen = {}; o[t].forEach(function (r) { if (seen[r.id]) bad('duplicate id in ' + t); seen[r.id] = 1; }); });
    // references must resolve against the payload plus what is already stored (merged view)
    var have = {};
    TABLES.forEach(function (t) { have[t] = {}; o[t].forEach(function (r) { have[t][r.id] = 1; }); if (existing && existing[t]) existing[t].forEach(function (id) { have[t][id] = 1; }); });
    o.workouts.forEach(function (r) { if (!have.members[r.member_id]) bad('workout refers to unknown member'); });
    o.sets.forEach(function (r) {
      if (!have.workouts[r.workout_id]) bad('set refers to unknown workout');
      if (!have.exercises[r.exercise_id]) bad('set refers to unknown exercise');
    });
  }
  // Merge-upsert by id (never overwrites the whole database). Validates everything BEFORE writing anything.
  Store.prototype.importData = async function (o) {
    if (typeof o === 'string') {
      try { o = JSON.parse(o); } catch (e) { throw new Error('import rejected: not valid JSON'); }
    }
    var self = this, existing = {};
    TABLES.forEach(function (t) { existing[t] = Array.from(self.t[t].keys()); });
    validateImport(o, existing);
    var rows = { members: o.members, exercises: o.exercises, workouts: o.workouts, sets: o.sets.map(upgradeSet) };
    TABLES.forEach(function (t) { rows[t].forEach(function (r) { self._commit(t, r, false); }); });
    await this.flush();
    return TABLES.reduce(function (acc, t) { acc[t] = o[t].length; return acc; }, {});
  };
  Store.prototype.wipeAll = async function () {
    await this.a.clear();
    var self = this;
    TABLES.forEach(function (t) { self.t[t] = new Map(); });
    this.pending = []; this.kv.removeItem('gl:pending'); this.status = 'saved'; this._emit();
  };

  // ------------------------------------------------------------------
  // Auth interface (UX only in Phase 1). Real verification = Phase 2.
  // ------------------------------------------------------------------
  function LocalAuth(store, kv) { this.store = store; this.kv = kv; }
  // Mock: accepts an existing, non-archived member name plus ANY 4-digit PIN. The PIN is never stored or compared.
  LocalAuth.prototype.login = async function (name, pin) {
    if (!/^\d{4}$/.test(String(pin || ''))) throw new Error('PIN must be 4 digits');
    var n = String(name || '').trim();
    var m = this.store.members().filter(function (x) { return x.name === n; })[0];
    if (!m) throw new Error('unknown member');
    this.kv.setItem('gl:session', m.id);
    return m;
  };
  LocalAuth.prototype.current = function () {
    var id = this.kv.getItem('gl:session');
    var m = id ? this.store.member(id) : null;
    return m && !m.archived ? m : null;
  };
  LocalAuth.prototype.logout = function () { this.kv.removeItem('gl:session'); };

  // ---- dates ----
  function todayStr(d) {
    d = d || new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  // 7/30/90-day ranges are N calendar days INCLUDING today; later dates never count.
  function rangeBounds(today, r) { return { since: r === 'all' ? null : addDays(today, -(r - 1)), until: today }; }
  function addDays(dateStr, n) {
    var p = dateStr.split('-').map(Number), d = new Date(p[0], p[1] - 1, p[2] + n);
    return todayStr(d);
  }

  return {
    BODY_PARTS: BODY_PARTS, SEED_EXERCISES: SEED_EXERCISES, parseSetLine: parseSetLine, parseLines: parseLines,
    suggestBodyPart: suggestBodyPart, PhotoStore: PhotoStore, MemCache: MemCache, fitSize: fitSize, validThumb: validThumb, PHOTO_MAX_CHARS: PHOTO_MAX_CHARS, formatSet: formatSet, formatSets: formatSets, nudge: nudge, validateSetFields: validateSetFields, dayStats: dayStats, groupByBodyPart: groupByBodyPart,
    delta: delta, MemoryStorage: MemoryStorage, LocalAdapter: LocalAdapter, SupabaseAdapter: SupabaseAdapter,
    SbClient: SbClient, SupabaseAuth: SupabaseAuth, emailFor: emailFor, Store: Store, LocalAuth: LocalAuth, sha256Hex: sha256Hex, workoutId: workoutId, rangeBounds: rangeBounds, validDate: validDate, validateImport: validateImport, todayStr: todayStr, addDays: addDays
  };
});
