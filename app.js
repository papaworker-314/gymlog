/* GymLog UI (vanilla JS, no build). UI text is Korean; comments are English.
 * The UI only talks to Store / Auth; it does not know which adapter is active. */
(function () {
  'use strict';

  // ---- the ONE place that picks the storage backend (Phase 2: SupabaseAdapter) ----
  var kv = window.localStorage;
  // Supabase when config.js says so; `?backend=local` forces the per-device LocalAdapter (used by the UI tests).
  var cfg = window.GYMLOG_CONFIG || {};
  var remote = !/[?&]backend=local\b/.test(location.search) && cfg.backend === 'supabase' && !!cfg.supabaseUrl && !!cfg.supabaseKey;
  var adapter, store, auth, client = null;
  if (remote) {
    client = new GL.SbClient(cfg, kv, { onAuthLost: function () { authLost(); } });
    adapter = new GL.SupabaseAdapter(client);
    store = new GL.Store(adapter, { kv: kv, lease: true }); // only ONE window per device may write (single-writer lease)
    auth = new GL.SupabaseAuth(client, store, kv);
  } else {
    adapter = new GL.LocalAdapter(kv);
    store = new GL.Store(adapter, { kv: kv });
    auth = new GL.LocalAuth(store, kv);
  }

  // ---- exercise photos (optional server table; remote mode only). IndexedDB cache; any failure just means "no cache". ----
  function idbCache() {
    var dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (res, rej) {
        if (!window.indexedDB) { rej(new Error('no idb')); return; }
        var rq = indexedDB.open('gymlog-photos', 1);
        rq.onupgradeneeded = function () { rq.result.createObjectStore('thumbs', { keyPath: 'exercise_id' }); };
        rq.onsuccess = function () { res(rq.result); }; rq.onerror = function () { rej(rq.error); };
      });
      return dbp;
    }
    function tx(mode, fn) { return open().then(function (db) { return new Promise(function (res, rej) { var t = db.transaction('thumbs', mode), r = fn(t.objectStore('thumbs')); t.oncomplete = function () { res(r && r.result); }; t.onerror = t.onabort = function () { rej(t.error); }; }); }); }
    return { all: function () { return tx('readonly', function (st) { return st.getAll(); }); }, put: function (rec) { return tx('readwrite', function (st) { return st.put(rec); }); } };
  }
  var photos = remote ? new GL.PhotoStore(client, idbCache()) : null;
  function showPhotos() { try { return localStorage.getItem('gl:showphotos') !== '0'; } catch (e) { return true; } }
  function photoUrl(exId) { return photos && showPhotos() ? photos.url(exId) : null; }
  function loadImage(file) {
    function viaImg() { return new Promise(function (res, rej) { var u = URL.createObjectURL(file), i = new Image(); i.onload = function () { URL.revokeObjectURL(u); res(i); }; i.onerror = function () { URL.revokeObjectURL(u); rej(new Error('decode')); }; i.src = u; }); }
    return window.createImageBitmap ? createImageBitmap(file, { imageOrientation: 'from-image' }).catch(viaImg) : viaImg();
  }
  // resize on the phone (a 12 MP photo is 2-4 MB): longest edge <= 640 px, JPEG, shrunk further until it fits the server cap
  function resizeToJpeg(file) {
    return loadImage(file).then(function (img) {
      var w = img.width || img.naturalWidth, h = img.height || img.naturalHeight, tries = [[640, 0.7], [640, 0.5], [480, 0.5], [480, 0.35]], out = null;
      for (var i = 0; i < tries.length && !out; i++) {
        var z = GL.fitSize(w, h, tries[i][0]), c = document.createElement('canvas'); c.width = z.w; c.height = z.h;
        var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, z.w, z.h); g.drawImage(img, 0, 0, z.w, z.h);
        var url = c.toDataURL('image/jpeg', tries[i][1]); if (GL.validThumb(url)) out = url;
      }
      if (img.close) img.close();
      if (!out) throw new Error('too big');
      return out;
    });
  }

  var DAYS = ['일', '월', '화', '수', '목', '금', '토'];
  // weekly cardio goal: the one default lives in gymlog-core.js (GL.CARDIO_GOAL = 2); an optional `cardioGoal` in GYMLOG_CONFIG overrides it
  var CARDIO_GOAL = Number(cfg.cardioGoal) > 0 ? Math.floor(Number(cfg.cardioGoal)) : GL.CARDIO_GOAL;
  var COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0ca678'];
  var S = {
    tab: 'log', view: null, date: GL.todayStr(), draft: [], wu: {}, bww: {}, bwMode: {}, keep: {}, rest: null, dayKey: '', focus: null, sheet: null, loginErr: '',
    g: { kind: 'str', mode: 'ex', exId: null, cExId: null, mem: 'all', wu: false, max: true, vol: false, dist: false, bp: '전체', range: 'all' }
  };
  var $app = document.getElementById('app');
  var $sheet = document.getElementById('sheet');
  var $toast = document.getElementById('toast');

  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(v) { return v === null || v === undefined ? '-' : String(Math.round(v * 10) / 10); }
  function signed(v) { return v === null ? '—' : (v > 0 ? '+' : '') + fmt(v); }
  function dateLabel(d) { var p = d.split('-').map(Number); return d + ' (' + DAYS[new Date(p[0], p[1] - 1, p[2]).getDay()] + ')'; }
  function $(id) { return document.getElementById(id); }

  // ---------------- read-only (another window holds the writer lease) ----------------
  var WRITE_ACTS = ['addset', 'same', 'copylast', 'paste', 'editset', 'saveset', 'delset', 'delblock', 'delday', 'confirmyes', 'addex', 'pick', 'newex', 'wu', 'ewu',
    'addwu', 'copyday', 'docopy', 'cleardrops', 'photodel', 'madd', 'mrename', 'marchive', 'eadd', 'esave', 'earchive', 'doimport', 'undo', 'retryrejected', 'retry', 'splityes', 'edelete', 'erestore'];
  function roNow() { return remote && !!auth.current() && !store.writer; }
  function applyRO() {
    var ro = roNow(), b = $('robanner'); if (b) b.hidden = !ro;
    Array.prototype.forEach.call(document.querySelectorAll('#app, #sheet, #toast'), function (root) {
      Array.prototype.forEach.call(root.querySelectorAll('[data-act], .entry input, .entry select, textarea'), function (el) {
        var act = el.getAttribute('data-act');
        if (act && WRITE_ACTS.indexOf(act) < 0) return;
        if (ro) { el.disabled = true; el.setAttribute('data-ro', '1'); } // (never re-enable what the screen itself disabled)
        else if (el.hasAttribute('data-ro')) { el.disabled = false; el.removeAttribute('data-ro'); }
      });
    });
  }
  // ---------------- save state + retry ----------------
  var retryTimer = null, retryDelay = 2000, shownRejected = 0;
  function kick() {
    if (remote && !client.hasTokens()) return; // logged out: queued writes wait for the next login
    store.flush().then(function (ok) {
      if (ok) {
        retryDelay = 2000;
        if (store.offline && remote) store.refresh().then(function () { render(); }).catch(function () { retryTimer = setTimeout(kick, retryDelay); });
        return;
      }
      clearTimeout(retryTimer);
      retryTimer = setTimeout(kick, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30000);
    });
  }
  window.addEventListener('online', kick);
  store.on(function (i) {
    var el = $('savestate'); if (!el) return;
    el.className = 'save ' + i.status;
    el.innerHTML = '<span class="dot"></span>' +
      (i.status === 'saved' ? '저장됨' : i.status === 'saving' ? '저장 중…' :
        i.status === 'rejected' ? '<span data-rejected="' + i.rejected + '">서버 거부 ' + i.rejected + '건 (저장 안 됨)</span> <button data-act="retryrejected">다시 보내기</button>' + (i.memoryOnly ? ' <span data-memonly="1">· 이 기기에도 저장하지 못했어요. 앱을 닫으면 사라져요</span>' : '') :
        '저장 실패 <button data-act="retry">재시도</button>' + (i.memoryOnly ? ' <span data-memonly="1">· 이 기기에 저장하지 못했어요. 앱을 닫으면 사라져요</span>' : '') + (i.rejected ? ' <span data-rejected="' + i.rejected + '">· 서버 거부 ' + i.rejected + '건</span>' : ''));
    var ob = $('offbanner'); if (ob) ob.hidden = !i.offline;
    if (i.rejected < shownRejected) shownRejected = i.rejected;
    if (i.rejected > shownRejected) { // say it once per new refusal; the data stays visible, the queue keeps going
      shownRejected = i.rejected;
      toast('서버가 일부 기록을 받아주지 않았어요 (' + i.rejected + '건). 화면에는 남아 있지만 서버에는 저장되지 않았어요.');
    }
    el.setAttribute('data-status', i.status);
  });
  // Re-render after a data change without wiping what the user already typed into OTHER cards' fields.
  function captureDrafts() {
    var d = {};
    // R12 r1: capture EXACT values, empty strings included (with P2 a re-render pre-fills kept values; a field the user cleared or edited must stay as typed)
    Array.prototype.forEach.call($app.querySelectorAll('input[id^="w-"],input[id^="r-"],input[id^="s-"],input[id^="m-"],input[id^="k-"],input[id^="n-"],textarea[id^="p-"]'), function (e) { d[e.id] = e.value; });
    return d;
  }
  function restoreDrafts(d, skipEx) {
    Object.keys(d).forEach(function (id) {
      if (skipEx && id.slice(id.indexOf('-') + 1) === skipEx) return; // the card that just saved starts clean
      var e = $(id); if (e) e.value = d[id]; // exact restore on every other card (also overrides a kept value)
    });
  }
  function changed(skipEx) { var d = captureDrafts(); render(); restoreDrafts(d, skipEx); kick(); }

  // ---------------- toast / sheet ----------------
  function toast(msg, undo) {
    var d = document.createElement('div'); d.className = 't';
    d.innerHTML = '<span>' + esc(msg) + '</span>' + (undo ? '<button data-act="undo">되돌리기</button>' : '');
    Array.prototype.forEach.call($toast.children, function (c) { if (c.firstChild.textContent === msg) c.remove(); });
    while ($toast.children.length >= 2) $toast.firstChild.remove();
    var timer = setTimeout(function () { d.remove(); }, 7000);
    if (undo) d.querySelector('button').onclick = function () { clearTimeout(timer); d.remove(); undo(); changed(); };
    $toast.appendChild(d);
  }
  function openSheet(s) { S.sheet = s; renderSheet(); applyRO(); }
  function closeSheet() { S.sheet = null; renderSheet(); }

  // ---------------- views ----------------
  function badge(ex) { return '<span class="badge' + (ex.archived ? ' archived' : '') + '">' + esc(ex.body_part) + '</span>'; }
  function memoHtml(ex, cls) { return ex.memo ? '<small class="exmemo muted ' + (cls || '') + '">' + esc(ex.memo) + '</small>' : ''; }
  function bpChips(sel) { // body part chips (required when creating); only parts the server supports are offered
    return '<div class="chips bpchips" id="bpchips">' + store.bodyParts().map(function (b) {
      return '<button type="button" class="chip' + (b === sel ? ' on' : '') + '" data-act="bpsel" data-bp="' + esc(b) + '" aria-pressed="' + (b === sel) + '">' + esc(b) + '</button>';
    }).join('') + '</div>';
  }
  function memoInput(id, val) { return store.supportsMemo() ? '<input id="' + id + '" maxlength="200" placeholder="메모 (예: 스미스 / 넓은 그립 / 가슴 중부)" autocomplete="off" value="' + esc(val || '') + '">' : ''; }
  function exName(ex) { return esc(ex.name) + (ex.archived ? ' <span class="muted">(보관됨)</span>' : ''); }

  function renderLogin() {
    var members = store.members();
    var form = '<form data-form="login"><label class="muted">이름</label><input id="lname" autocomplete="off" autocapitalize="none" placeholder="이름">' +
      '<label class="muted">PIN 4자리</label><input id="lpin" type="password" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="••••">' +
      '<div class="err" id="lerr">' + esc(S.loginErr) + '</div><button class="primary" style="width:100%">로그인</button></form>';
    if (remote) { // members are not readable before login: free-text name + PIN, no member chips
      $app.innerHTML = '<div class="login"><h1>GymLog</h1>' + form +
        '<p class="muted" style="margin-top:18px">이름과 PIN으로 로그인해요. 이 기기에 로그인이 유지됩니다.</p></div>';
      return;
    }
    $app.innerHTML = '<div class="login"><h1>GymLog</h1>' +
      (members.length ? '<div class="chips">' + members.map(function (m) { return '<button class="chip" data-act="pickname" data-name="' + esc(m.name) + '">' + esc(m.name) + '</button>'; }).join('') + '</div>' +
        '<form data-form="login"><label class="muted">이름</label><input id="lname" autocomplete="off" autocapitalize="none" placeholder="이름">' +
        '<label class="muted">PIN 4자리</label><input id="lpin" type="password" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="••••">' +
        '<div class="err" id="lerr">' + esc(S.loginErr) + '</div><button class="primary" style="width:100%">로그인</button></form>'
        : '<p class="muted">아직 멤버가 없어요. 첫 멤버를 만들어 시작하세요.</p>' +
        '<form data-form="firstmember"><input id="fname" placeholder="이름" autocomplete="off"><div class="err" id="lerr">' + esc(S.loginErr) + '</div><button class="primary" style="width:100%">멤버 만들기</button></form>') +
      '<p class="muted" style="margin-top:18px">로그인은 이 기기에서만 확인해요(1단계). 이 기기에 기억됩니다.</p></div>';
  }

  function authLost() {
    S.view = null; S.sheet = null; renderSheet();
    S.loginErr = '로그인이 만료됐어요. 다시 로그인해 주세요. (저장되지 않은 기록은 이 기기에 남아 있어요)';
    render();
  }
  function loginErrorText(e) {
    if (e && e.code === 'PIN' || /PIN/.test(e && e.message || '')) return 'PIN은 숫자 4자리예요.';
    if (e && e.code === 'NET') return '네트워크에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.';
    if (e && e.code === 'NO_MEMBER') return '이 이름으로 등록된 멤버가 없어요. 멤버 등록을 요청해 주세요.';
    if (e && e.code === 'BAD') return '이름 또는 PIN이 맞지 않아요.';
    if (e && (e.code === 'HTTP' || e.code === 'AUTH')) return '서버에 문제가 있어요. 잠시 후 다시 시도해 주세요.';
    return '등록된 멤버가 아니에요.';
  }

  // P4 화면 켜두기: per device (localStorage gl:awake), off by default; any failure = silently off
  var wakeLock = null, wakeGen = 0, wakePending = false; // R12 r1: one request at a time; a grant that arrives after "off" is released
  function awakeOn() { try { return localStorage.getItem('gl:awake') === '1'; } catch (e) { return false; } }
  function setAwake(on) { try { localStorage.setItem('gl:awake', on ? '1' : '0'); } catch (e) { /* private mode */ } }
  function acquireWake() {
    if (!awakeOn() || !('wakeLock' in navigator) || document.visibilityState === 'hidden' || wakeLock || wakePending) return;
    var g = ++wakeGen; wakePending = true;
    navigator.wakeLock.request('screen').then(function (l) {
      if (g !== wakeGen || !awakeOn()) { l.release().catch(function () { /* already released */ }); if (g === wakeGen) wakePending = false; return; } // superseded / switched off meanwhile: never keep it
      wakePending = false;
      wakeLock = l;
      if (l.addEventListener) l.addEventListener('release', function () { if (wakeLock === l) wakeLock = null; }); // the system releases it when the app is hidden
    }, function () {
      if (g !== wakeGen) return;
      wakePending = false; wakeLock = null; setAwake(false); paintAwake(); // R12 r1: only the pill changes (no render: keeps typing / IME)
    });
  }
  function releaseWake() {
    var g = ++wakeGen; // a still-pending request is now superseded: release its grant when it arrives
    wakePending = false;
    if (wakeLock) { var l = wakeLock; wakeLock = null; l.release().catch(function () { /* already released */ }); }
    return g;
  }
  function paintAwake() { var b = document.querySelector('[data-act=awake]'); if (!b) return; var on = awakeOn(); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); b.textContent = '화면 켜두기 ' + (on ? '켜짐' : '꺼짐'); }
  // P5 rest count-up: display only, memory only; updated by textContent once a second (never a re-render)
  var clock = { offset: 0 }; function nowMs() { return Date.now() + clock.offset; }
  function restText() { var sec = Math.max(0, Math.floor((nowMs() - S.rest.t) / 1000)); return '휴식 ' + Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); }
  function startRest(exId) { S.rest = { ex: exId, t: nowMs(), date: S.date, view: S.view }; }
  function restTick() {
    var el = S.rest && document.querySelector('[data-rest="' + S.rest.ex + '"]'); if (!el) return;
    if (nowMs() - S.rest.t >= 10 * 60000) { S.rest = null; el.hidden = true; el.textContent = ''; return; }
    el.textContent = restText();
  }
  setInterval(function () { if (document.visibilityState !== 'hidden') restTick(); }, 1000);
  function headerHtml(noChips) {
    var members = store.members();
    return (noChips ? '' : '<div class="stickyhead">') + '<div id="robanner" class="banner"' + (roNow() ? '' : ' hidden') + '>다른 창에서 열려 있어요. 그 창을 닫거나 잠시 기다리면 여기서 이어서 쓸 수 있어요. (지금은 보기만 가능해요)</div>' +
      '<div id="offbanner" class="banner"' + (store.offline ? '' : ' hidden') + '>오프라인이에요. 저장된 기록으로 열었고, 새 기록은 연결되면 자동으로 올라가요.</div>' +
      '<div class="top"><div id="savestate" class="save ' + store.status + '"></div>' +
      '<div class="topbtns">' + (photos && (photos.available() || Object.keys(photos.recs).length) ? '<button class="pill' + (showPhotos() ? ' on' : '') + '" data-act="eye" aria-label="사진 보기" aria-pressed="' + showPhotos() + '">' + (showPhotos() ? '사진 켜짐' : '사진 꺼짐') + '</button>' : '') +
      ('wakeLock' in navigator ? '<button class="pill' + (awakeOn() ? ' on' : '') + '" data-act="awake" aria-pressed="' + awakeOn() + '">화면 켜두기 ' + (awakeOn() ? '켜짐' : '꺼짐') + '</button>' : '') + // P4 (only with the API)
      '<button data-act="gear" aria-label="설정">⚙ 설정</button></div></div>' +
      (noChips ? '' : '<div class="memrow"><div class="chips" id="memberchips">' + members.map(function (m) {
        return '<button class="chip' + (m.id === S.view ? ' on' : '') + '" data-act="member" data-id="' + esc(m.id) + '">' + esc(m.name) + '</button>';
      }).join('') + '</div><button class="primary addexbtn" data-act="addex">＋ 운동 추가</button></div></div>'); // R14: </div> closes .stickyhead; the add button fills the rest of the member row (R11)
  }

  // legacy drops (before round 11) stay readable, muted like legacy weight2: `(드롭 20,10)`
  function dropsHtml(s) { return s.drops && s.drops.length ? ' <span class="muted legacydrop">(드롭 ' + esc(s.drops.join(',')) + ')</span>' : ''; }
  function has(v) { return v !== null && v !== undefined; }
  // one set: `60(12)` (weight bold), weightless warm-up `(15)`, cardio `30분 · 5.2km`
  function setMain(s) {
    if (has(s.seconds)) return '<b>' + esc(GL.displaySet(s)) + '</b>'; // R12 pass 2: `60초`
    if (!has(s.minutes) && !has(s.weight) && !s.is_warmup && has(s.reps)) return '<b>' + esc(s.reps) + '회</b>'; // R12 맨몸 reps-only
    if (has(s.minutes)) return '<b>' + esc(s.minutes) + '분</b>' + (has(s.distance) ? ' · ' + esc(s.distance) + 'km' : '');
    return (has(s.weight) ? '<b>' + esc(GL.formatSet({ weight: s.weight })) + '</b>' : '') + (has(s.reps) ? '<span class="reps">(' + esc(s.reps) + ')</span>' : '');
  }
  // rows saved before round 7 may still carry the old second weight: keep it visible (it has no meaning any more)
  function legacyHtml(s) { return s.weight2 !== null && s.weight2 !== undefined ? ' <span class="muted">(무게2 ' + esc(s.weight2) + ')</span>' : ''; }

  // weight chips next to the weight field (+2.5 / +5 / -2.5); empty field starts from the last weight (store.nudgeBase)
  function nudgeHtml(target, exId) {
    return '<div class="nudge">' + [['+2.5', 2.5], ['+5', 5], ['-2.5', -2.5]].map(function (c) {
      return '<button type="button" data-act="nudge" data-d="' + c[1] + '" data-target="' + target + '"' + (exId ? ' data-ex="' + esc(exId) + '"' : '') + ' aria-label="무게 ' + c[0] + '">' + c[0] + '</button>';
    }).join('') + '</div>';
  }

  function blockHtml(ex, sets, wid) {
    var cardio = GL.isCardio(ex), bw = GL.isBodyweight(ex), reps = store.supportsReps();
    var rows = sets.map(function (s, i) {
      return '<div class="setrow"><span class="idx">' + (i + 1) + '</span><button class="txt" data-act="editset" data-id="' + esc(s.id) + '">' +
        (store.isRejected('sets', s.id) ? '<span class="tag reject">서버 거부</span> ' : '') + (s.is_warmup ? '<span class="tag">웜업</span> ' : '') + setMain(s) + dropsHtml(s) + legacyHtml(s) + (s.note ? ' <span class="muted">' + esc(s.note) + '</span>' : '') + '</button>' +
        '<button class="ghost" data-act="editset" data-id="' + esc(s.id) + '" aria-label="수정">✎</button></div>';
    }).join('');
    var last = sets.length ? sets[sets.length - 1] : null;
    var prevSess = store.lastSession(S.view, ex.id, S.date), info = store.lastInfo(S.view, ex.id, S.date), lastLine = GL.lastLineText(info);
    var kp = S.keep[ex.id] || {}, kv = function (k) { return has(kp[k]) && kp[k] !== '' ? ' value="' + esc(kp[k]) + '"' : ''; }; // P2: last values stay in the fields
    var mode = S.bwMode[ex.id] || store.bwMode(S.view, ex.id); // pass 2: 횟수 | 초, default = unit of the last set
    var vol = wid && !cardio ? store.exerciseVolume(wid, ex.id) : null; // running 합계 of this block, from Store data (null for 맨몸)
    var totr = wid && bw ? store.exerciseTotalText(wid, ex.id) : ''; // R12 맨몸: 총 N회 / 총 2분 15초 instead of 합계
    var best = !cardio && !bw && vol !== null && has(info.best) && vol > info.best; // P6: today's 합계 beats every earlier session
    var restOn = S.rest && S.rest.ex === ex.id && S.rest.date === S.date && S.rest.view === S.view;
    var on = S.wu[ex.id] ? ' on' : '', X = esc(ex.id);
    var pu = photoUrl(ex.id);
    var entry = bw ? // R12 맨몸: [횟수][+무게][메모][추가]; the weight field (weighted pull-ups) is hidden until +무게
      '<div class="entry bw"><button class="bwmode" data-act="bwmode" data-ex="' + X + '" aria-label="횟수/초 바꾸기">' + (mode === 'sec' ? '초' : '횟수') + '</button>' +
        '<input id="' + (mode === 'sec' ? 's-' : 'r-') + X + '" inputmode="numeric" placeholder="' + (mode === 'sec' ? '초' : '횟수') + '" autocomplete="off" aria-label="' + (mode === 'sec' ? '초' : '횟수') + '"' + kv(mode === 'sec' ? 's' : 'r') + '>' +
        '<button class="bwbtn' + (S.bww[ex.id] ? ' on' : '') + '" data-act="bwweight" data-ex="' + X + '" aria-pressed="' + (!!S.bww[ex.id]) + '"' + (S.bww[ex.id] ? ' hidden' : '') + '>+무게</button>' +
        '<input class="w" id="w-' + X + '" inputmode="decimal" placeholder="무게" autocomplete="off" aria-label="무게"' + (S.bww[ex.id] ? kv('w') : ' hidden') + '>' +
        '<input class="note" id="n-' + X + '" placeholder="메모(선택)" autocomplete="off">' +
        '<button class="primary add" data-act="addset" data-ex="' + X + '">추가</button></div>' :
      cardio ?
      '<div class="entry cardio"><input id="m-' + X + '" inputmode="numeric" placeholder="분" autocomplete="off" aria-label="분"' + kv('m') + '>' +
        '<input id="k-' + X + '" inputmode="decimal" placeholder="거리 km (선택)" autocomplete="off" aria-label="거리 km"' + kv('k') + '>' +
        '<input class="note" id="n-' + X + '" placeholder="메모(선택)" autocomplete="off">' +
        '<button class="primary add" data-act="addset" data-ex="' + X + '">추가</button></div>' :
      '<div class="entry' + (reps ? '' : ' noreps') + '"><button class="wu' + on + '" data-act="wu" data-ex="' + X + '" aria-pressed="' + (!!S.wu[ex.id]) + '">웜업</button>' +
        '<input class="w" id="w-' + X + '" inputmode="decimal" placeholder="무게" autocomplete="off" aria-label="무게"' + kv('w') + '>' +
        (reps ? '<input id="r-' + X + '" inputmode="numeric" placeholder="횟수" autocomplete="off" aria-label="횟수"' + kv('r') + '>' : '') + // before migration-004 the reps field is hidden (R11 §6)
        '<input class="note" id="n-' + X + '" placeholder="메모(선택)" autocomplete="off">' +
        '<button class="primary add" data-act="addset" data-ex="' + X + '">추가</button></div>' + nudgeHtml('w-' + ex.id, ex.id);
    var ex1 = bw ? '(15) - (12) - (10)' : reps ? '웜업 - 60(12) - 70(10)' : '웜업 - 60 - 70';
    return '<div class="card" data-ex="' + X + '"><div class="row">' + (pu ? '<img class="exthumb" src="' + pu + '" alt="" data-act="zoom" data-ex="' + X + '">' : '') + '<h3 class="grow">' + exName(ex) + badge(ex) + '</h3>' +
      (vol !== null ? '<span class="exvol" data-exvol="' + X + '">합계 ' + esc(GL.fmtVolume(vol)) + '</span>' : '') +
      (best ? '<span class="tag besttag" data-best="' + X + '">최고 경신</span>' : '') +
      (totr ? '<span class="exvol" data-exreps="' + X + '">' + esc(totr) + '</span>' : '') +
      (restOn ? '<span class="muted rest" data-rest="' + X + '">' + restText() + '</span>' : '') +
      '<button class="ghost danger" data-act="delblock" data-ex="' + X + '" aria-label="운동 삭제">🗑</button></div>' + memoHtml(ex) +
      (lastLine ? '<div class="lastline muted" data-last="' + X + '">지난번 ' + esc(lastLine) + '</div>' : '') + rows + entry +
      '<div class="quick">' + (cardio || bw ? '' : '<button class="bigwu" data-act="addwu" data-ex="' + X + '">웜업 추가</button>') +
      '<button data-act="same" data-ex="' + X + '"' + (last ? '' : ' disabled') + '>이전 세트와 같게</button>' +
      '<button data-act="copylast" data-ex="' + X + '"' + (prevSess.length ? '' : ' disabled') + '>지난 기록 복사' + (prevSess.length ? ' (' + prevSess.length + '세트)' : '') + '</button></div>' +
      (cardio ? '' : '<details><summary>붙여넣기 입력 (예: ' + ex1 + ')</summary><textarea id="p-' + X + '" placeholder="' + ex1 + '&#10;' + (bw ? '(20)' : reps ? '80(8) - 80(6)' : '80 - 80') + '"></textarea>' +
      '<div class="err" id="perr-' + X + '"></div><button data-act="paste" data-ex="' + X + '">붙여넣은 세트 추가</button></details>') + '</div>';
  }

  function renderLog() {
    var dk = S.view + '|' + S.date; if (S.dayKey !== dk) { S.dayKey = dk; S.keep = {}; S.bwMode = {}; if (S.rest && (S.rest.date !== S.date || S.rest.view !== S.view)) S.rest = null; } // P2/P5: per day + member
    var w = store.workoutFor(S.view, S.date);
    var blocks = w ? store.blocksForWorkout(w.id, { newestFirst: true }) : []; // newest exercise on top (persisted order key)
    var have = {}; blocks.forEach(function (b) { have[b.exercise.id] = 1; });
    var drafts = S.draft.filter(function (id) { return !have[id] && store.exercise(id); }).reverse(); // a fresh "+ 운동 추가" block stays at the very top
    var prev = store.adjacentDay(S.view, S.date, -1), next = store.adjacentDay(S.view, S.date, 1); // arrows skip days without records
    var dv = store.dayVolume(S.view, S.date), sum = [];
    if (dv !== null) sum.push('<span data-dayvol="1">' + (S.date === GL.todayStr() ? '오늘' : '이 날') + ' 합계 <b>' + esc(GL.fmtVolume(dv)) + '</b></span>');
    // R12: the weekly cardio count left the 기록 summary (owner); it stays in 성장 > 유산소 (주간 유산소 table)
    var html = headerHtml() +
      '<div class="datebar"><button data-act="dprev" aria-label="이전 기록일"' + (prev ? '' : ' disabled') + '>◀</button>' +
      '<button class="datebtn" id="datebtn" data-act="cal" aria-label="날짜 선택 (달력)">' + esc(dateLabel(S.date)) + '</button>' +
      '<button data-act="dnext" aria-label="다음 기록일"' + (next ? '' : ' disabled') + '>▶</button><button data-act="dtoday">오늘</button></div>' +
      '<div class="muted" style="margin-bottom:6px">' + esc((store.member(S.view) || {}).name || '') + '</div>' +
      (sum.length ? '<div class="daysum" id="daysum">' + sum.join(' · ') + '</div>' : '');
    drafts.forEach(function (id) { html += blockHtml(store.exercise(id), [], null); });
    blocks.forEach(function (b) { html += blockHtml(b.exercise, b.sets, w.id); });
    if (!blocks.length && !drafts.length) { // P1: a friend logged this date -> one tap brings their exercise list (no sets, nothing written)
      html += store.members().filter(function (m) { return m.id !== S.view && (function (fw) { return fw && store.blocksForWorkout(fw.id).some(function (b) { return !b.exercise.archived; }); })(store.workoutFor(m.id, S.date)); }).map(function (m) {
        return '<button class="friendday" data-act="friendday" data-id="' + esc(m.id) + '">' + esc(m.name) + ' ' + (S.date === GL.todayStr() ? '오늘' : '이 날') + ' 운동 가져오기</button>';
      }).join('');
      html += '<div class="empty">이 날 기록이 없어요. 위의 ＋ 운동 추가로 시작해 보세요.</div>';
    }
    html += '<button style="width:100%;margin-top:8px" data-act="copyday">다른 날/친구 기록 복사</button>';
    if (blocks.length) html += '<button class="ghost danger" style="width:100%;margin-top:8px" data-act="delday">이 날 기록 전체 삭제</button>';
    var days = store.historyDays(S.view).slice(0, 60);
    html += '<h2>지난 기록</h2>' + (days.length ? days.map(function (d) {
      return '<button class="hist" data-act="openday" data-date="' + esc(d.date) + '"><span>' + esc(dateLabel(d.date)) + '</span><span class="muted">운동 ' + d.exerciseCount + ' · 세트 ' + d.setCount + '</span></button>';
    }).join('') : '<div class="muted">아직 기록이 없어요.</div>');
    return html;
  }

  function memberColor(id) {
    var all = store.members(true), i = all.map(function (m) { return m.id; }).indexOf(id);
    return COLORS[(i < 0 ? 0 : i) % COLORS.length];
  }
  function rangeOf(r) { return GL.rangeBounds(GL.todayStr(), r); }
  function isMonth(r) { return r && typeof r === 'object'; }
  // period control shared by 운동별 and 부위별: 전체 first, 7/30/90 days, then a native month picker (only months that have data)
  function periodHtml(g) {
    var months = store.monthsWithData(memberIdsFor(g.mem)), cur = isMonth(g.range) ? g.range.month : '';
    if (cur && months.indexOf(cur) < 0) months.push(cur), months.sort().reverse();
    return '<div class="chips" id="periodchips">' + ['all', 7, 30, 90].map(function (r) { return '<button class="chip' + (g.range === r ? ' on' : '') + '" data-act="grange" data-r="' + r + '">' + (r === 'all' ? '전체' : r + '일') + '</button>'; }).join('') +
      '<select id="gmonth" class="chip' + (cur ? ' on' : '') + '" aria-label="월 선택"><option value="">월 선택</option>' + months.map(function (m) { return '<option value="' + m + '"' + (m === cur ? ' selected' : '') + '>' + m + '</option>'; }).join('') + '</select></div>';
  }
  function memberIdsFor(mem) { return mem === 'all' ? null : [mem]; }

  function exercisesWithData() { // strength exercises only (cardio has its own view)
    return store.growthExercises().filter(function (e) { return e.body_part && !GL.isCardio(e) && ((!e.archived && !e.deleted) || store.seriesFor(e.id, { includeWarmup: true }).length); });
  }
  function shortDate(d) { return d.slice(5).replace('-', '/'); }

  // 유산소 growth: minutes (or km) per session per member, weekly count vs the goal, last 10 sessions
  function renderCardioGrowth(g, memOpts) {
    var exs = store.growthExercises().filter(function (e) { return GL.isCardio(e) && ((!e.archived && !e.deleted) || store.cardioSeries(e.id).length); }), html = '';
    if (!g.cExId || !exs.some(function (e) { return e.id === g.cExId; })) g.cExId = exs.length ? exs[0].id : null;
    var ex = g.cExId ? store.exercise(g.cExId) : null;
    html += '<select id="gcex" aria-label="유산소 운동 선택">' + exs.map(function (e) { return '<option value="' + esc(e.id) + '"' + (e.id === g.cExId ? ' selected' : '') + '>' + esc(e.name) + (e.deleted ? ' (삭제됨)' : e.archived ? ' (보관됨)' : '') + '</option>'; }).join('') + '</select>';
    html += '<div style="height:8px"></div><select id="gmem" aria-label="멤버">' + memOpts + '</select>' + periodHtml(g);
    html += '<div class="opts"><label><input type="checkbox" id="gdist"' + (g.dist ? ' checked' : '') + '>거리(km) 그래프</label></div>';
    var mids = g.mem === 'all' ? store.members().map(function (m) { return m.id; }) : [g.mem];
    // weekly count vs goal (all cardio exercises together), last 6 weeks, per member
    var weeks = mids.map(function (id) { return store.cardioWeeks(id, GL.todayStr(), 6); });
    html += '<div class="card" id="cardioweeks"><h3>주간 유산소 <span class="muted">(목표 주 ' + CARDIO_GOAL + '회 · 월~일)</span></h3><table><tr><th>주</th>' +
      mids.map(function (id) { return '<th>' + esc((store.member(id) || {}).name || '') + '</th>'; }).join('') + '</tr>' +
      (weeks[0] || []).map(function (wk, i) {
        return '<tr><td>' + esc(shortDate(wk.start)) + '~</td>' + weeks.map(function (list) { var c = list[i].count; return '<td class="' + (c >= CARDIO_GOAL ? 'goalok' : '') + '">' + c + '/' + CARDIO_GOAL + '</td>'; }).join('') + '</tr>';
      }).join('') + '</table></div>';
    if (!ex) return html + '<div class="empty">아직 유산소 운동이 없어요. 기록 탭의 ＋ 운동 추가에서 부위 \'유산소\'로 만들어 보세요.</div>';
    var series = [], tables = '', rb = rangeOf(g.range);
    mids.forEach(function (id) {
      var pts = store.cardioSeries(ex.id, { memberIds: [id], since: rb.since, until: rb.until });
      if (!pts.length) return;
      var m = store.member(id), color = memberColor(id), ys = pts.filter(function (p) { return !g.dist || p.distance !== null; });
      if (ys.length) series.push({ name: m.name, color: color, points: ys.map(function (p) { return { x: p.date, y: g.dist ? p.distance : p.minutes }; }) });
      tables += '<div class="card"><h3>' + esc(m.name) + '</h3><table><tr><th>날짜</th><th>분</th><th>km</th></tr>' +
        pts.slice(-10).reverse().map(function (p) { return '<tr><td>' + esc(p.date.slice(2)) + '</td><td>' + esc(p.minutes) + '</td><td>' + (p.distance === null ? '-' : esc(p.distance)) + '</td></tr>'; }).join('') + '</table></div>';
    });
    html += '<div class="muted">' + exName(ex) + badge(ex) + '</div>';
    if (!tables) return html + '<div class="empty">' + (g.range === 'all' ? '이 운동의 기록이 없어요.' : '이 기간의 기록이 없어요.') + '</div>';
    html += '<div class="card" id="chartbox">' + (series.length ? GLChart.line({ series: series, label: ex.name + (g.dist ? ' 거리' : ' 시간') + ' 그래프' }) : '<div class="empty">거리 기록이 없어요.</div>') +
      '<div class="legend">' + series.map(function (x) { return '<span><i style="background:' + x.color + '"></i>' + esc(x.name) + '</span>'; }).join('') + '<span class="muted">' + (g.dist ? 'km / 회' : '분 / 회') + '</span></div></div>' + tables;
    return html;
  }

  function renderGrowth() {
    var g = S.g, html = headerHtml(true), cardioOn = store.supportsCardio();
    if (!cardioOn) g.kind = 'str';
    if (cardioOn) html += '<div class="seg" id="kindseg"><button data-act="gkind" data-k="str" class="' + (g.kind === 'str' ? 'on' : '') + '">근력</button>' +
      '<button data-act="gkind" data-k="cardio" class="' + (g.kind === 'cardio' ? 'on' : '') + '">유산소</button></div>';
    var memOpts0 = '<option value="all">전체 (각자 따로)</option>' + store.members(true).map(function (m) {
      return '<option value="' + esc(m.id) + '"' + (g.mem === m.id ? ' selected' : '') + '>' + esc(m.name) + '</option>'; }).join('');
    if (g.kind === 'cardio') return html + renderCardioGrowth(g, memOpts0);
    html += '<div class="seg"><button data-act="gmode" data-m="ex" class="' + (g.mode === 'ex' ? 'on' : '') + '">운동별</button>' +
      '<button data-act="gmode" data-m="bp" class="' + (g.mode === 'bp' ? 'on' : '') + '">부위별</button></div>';
    var memOpts = memOpts0;
    var wuOpt = '<label><input type="checkbox" id="gwu"' + (g.wu ? ' checked' : '') + '>웜업 포함</label>';
    if (g.mode === 'ex') {
      var exs = exercisesWithData();
      if (!g.exId || !store.exercise(g.exId)) g.exId = exs.length ? exs[0].id : null;
      var ex = g.exId ? store.exercise(g.exId) : null;
      html += '<select id="gex" aria-label="운동 선택">' + GL.BODY_PARTS.map(function (bp) {
        var l = exs.filter(function (e) { return e.body_part === bp; });
        return l.length ? '<optgroup label="' + esc(bp) + '">' + l.map(function (e) { return '<option value="' + esc(e.id) + '"' + (e.id === g.exId ? ' selected' : '') + '>' + esc(e.name) + (e.deleted ? ' (삭제됨)' : e.archived ? ' (보관됨)' : '') + '</option>'; }).join('') + '</optgroup>' : '';
      }).join('') + '</select>';
      html += '<div style="height:8px"></div><select id="gmem" aria-label="멤버">' + memOpts + '</select>' + periodHtml(g);
      html += '<div class="opts">' + wuOpt + (g.vol ? '' : '<label><input type="checkbox" id="gmax"' + (g.max ? ' checked' : '') + '>최대값 선도 표시</label>') +
        '<label><input type="checkbox" id="gvol"' + (g.vol ? ' checked' : '') + '>합계 그래프</label></div>'; // volume (session 합계) instead of avg/max: different scale, so one or the other
      if (!ex) return html + '<div class="empty">아직 운동이 없어요.</div>';
      var mids = g.mem === 'all' ? store.members(true).map(function (m) { return m.id; }) : [g.mem];
      var series = [], tables = '';
      mids.forEach(function (id) {
        var rb = rangeOf(g.range), oo = { memberIds: [id], includeWarmup: g.wu, since: rb.since, until: rb.until };
        var pts = store.seriesFor(ex.id, oo), vs = store.volumeSeries(ex.id, oo), rows = store.growthRows(ex.id, oo); // volume ignores the warm-up AVERAGE toggle (warm-ups always count); table = union of dates
        if (!rows.length) return;
        var m = store.member(id), color = memberColor(id);
        if (g.vol) { if (vs.length) series.push({ name: m.name + ' 합계', color: color, points: vs.map(function (p) { return { x: p.date, y: p.vol }; }) }); } // days without reps: no point (not 0)
        else if (pts.length) {
          if (g.max) series.push({ name: m.name + ' 최대', color: color, dash: true, opacity: .45, points: pts.map(function (p) { return { x: p.date, y: p.max }; }) });
          series.push({ name: m.name + ' 평균', color: color, points: pts.map(function (p) { return { x: p.date, y: p.avg }; }) });
        }
        var d = pts.length ? GL.delta(pts) : null;
        tables += '<div class="card"><div class="row"><h3 class="grow">' + esc(m.name) + '</h3>' + (d ? '<span class="delta ' + (d.diff > 0 ? 'up' : d.diff < 0 ? 'down' : '') + '">처음 ' + fmt(d.first.avg) + ' → 최근 ' + fmt(d.latest.avg) + ' (' + signed(d.diff) + ')</span>' : '') + '</div>' +
          '<table><tr><th>날짜</th><th>세트</th><th>평균</th><th>최대</th><th>합계</th></tr>' +
          rows.slice(-10).reverse().map(function (p) { return '<tr><td>' + esc(p.date.slice(2)) + '</td><td>' + (p.count === null ? '-' : p.count) + '</td><td>' + fmt(p.avg) + '</td><td>' + fmt(p.max) + '</td><td>' + (p.vol === null ? '-' : esc(GL.fmtVolume(p.vol))) + '</td></tr>'; }).join('') + '</table></div>';
      });
      html += '<div class="muted">' + exName(ex) + badge(ex) + '</div>';
      if (!tables) return html + '<div class="empty">' + (g.range === 'all' ? '이 운동의 기록이 없어요.' : '이 기간의 기록이 없어요.') + '</div>';
      html += '<div class="card" id="chartbox">' + (series.length ? GLChart.line({ series: series, label: ex.name + (g.vol ? ' 합계' : ' 성장') + ' 그래프' }) : '<div class="empty">' + (g.vol ? '횟수가 기록된 날이 없어서 합계를 그릴 수 없어요.' : '평균을 낼 본 세트가 없어요. (웜업 포함을 켜거나 합계 그래프를 보세요)') + '</div>') + '<div class="legend">' +
        series.filter(function (s) { return !s.dash; }).map(function (s) { return '<span><i style="background:' + s.color + '"></i>' + esc(s.name.replace(' 평균', '').replace(' 합계', '')) + '</span>'; }).join('') +
        (g.vol ? '<span class="muted">합계 = 무게×횟수</span>' : g.max ? '<span class="muted">점선 = 최대</span>' : '') + '</div></div>' + tables;
    } else {
      var parts = store.bodyParts().filter(function (b) { return b !== GL.CARDIO_PART; }); // 근력 only
      if (g.bp !== '전체' && parts.indexOf(g.bp) < 0) g.bp = '전체';
      html += '<div class="chips">' + ['전체'].concat(parts).map(function (b) { return '<button class="chip' + (g.bp === b ? ' on' : '') + '" data-act="gbp" data-bp="' + esc(b) + '">' + esc(b) + '</button>'; }).join('') + '</div>'; // 전체 is a view filter only, never a body part
      html += '<select id="gmem" aria-label="멤버">' + memOpts + '</select>' + periodHtml(g) + '<div class="opts">' + wuOpt + '</div>';
      var rows = store.bodyPartSummary(g.bp === '전체' ? null : g.bp, { memberIds: memberIdsFor(g.mem), since: rangeOf(g.range).since, until: rangeOf(g.range).until, includeWarmup: g.wu });
      html += rows.length ? rows.map(function (r) {
        return '<button class="hist card" style="width:100%" data-act="gopen" data-id="' + esc(r.exercise.id) + '"><span><b>' + exName(r.exercise) + '</b>' + badge(r.exercise) +
          '<br><span class="muted">' + r.sessions + '회 · 최근 평균 ' + fmt(r.latestAvg) + '</span></span><span class="delta ' + (r.change > 0 ? 'up' : r.change < 0 ? 'down' : '') + '">' + signed(r.change) + '</span></button>';
      }).join('') : '<div class="empty">' + (g.range === 'all' ? '이 부위의 기록이 없어요.' : '이 기간의 기록이 없어요.') + '</div>';
    }
    return html;
  }

  function render() {
    var me = auth.current();
    if (!me) { store.user = null; renderLogin(); return; }
    store.user = me.id;
    var v = S.view && store.member(S.view);
    if (!v || v.archived) S.view = me.id;
    $app.innerHTML = (S.tab === 'log' ? renderLog() : renderGrowth()) +
      '<nav class="tabbar"><button data-act="tab" data-t="log" class="' + (S.tab === 'log' ? 'on' : '') + '">기록</button>' +
      '<button data-act="tab" data-t="growth" class="' + (S.tab === 'growth' ? 'on' : '') + '">성장</button></nav>';
    store._emit(); applyRO();
    if (S.focus) { var f = $(S.focus); if (f) f.focus(); S.focus = null; }
  }

  // ---------------- sheets ----------------
  function exerciseOptions(sel) { return store.bodyParts().concat(store.bodyParts().indexOf(sel) < 0 && sel ? [sel] : []).map(function (b) { return '<option' + (b === sel ? ' selected' : '') + '>' + b + '</option>'; }).join(''); }

  // R12 picker list: 최근 (2 most recently used) + all others 가나다; search filters both (GL.pickerGroups)
  function pickerList(s) {
    var g = GL.pickerGroups(store.exercises(), store.recentExerciseIds(), s.q);
    function item(e) { return '<button class="item" data-act="pick" data-id="' + esc(e.id) + '"><span>' + esc(e.name) + '</span>' + badge(e) + memoHtml(e, 'inpick') + '</button>'; }
    return { empty: !g.recent.length && !g.rest.length,
      html: (g.recent.length ? '<div id="pickrecent"><h3 class="pickhead">최근</h3>' + g.recent.map(item).join('') + '</div>' : '') +
        '<div id="pickall">' + (g.recent.length && g.rest.length ? '<h3 class="pickhead">전체 (가나다순)</h3>' : '') + g.rest.map(item).join('') + '</div>' };
  }
  // R12 IME fix: typing in the search box updates ONLY the result list (and the untouched 새 운동 name); the focused input is
  // never rebuilt, and nothing happens while a Korean composition is in progress (iOS would commit every jamo separately).
  function updatePicker(q) {
    if (!S.sheet || S.sheet.type !== 'picker') return;
    S.sheet.q = q;
    var pk = pickerList(S.sheet), l = $('picklist'), nx = $('nxn');
    if (l) l.innerHTML = pk.html;
    if (nx && !S.sheet.nxnTyped) nx.value = pk.empty && q.trim() ? q : '';
    applyRO();
  }
  // R13 운동 관리 card: name + part (+ photo, memo), buttons at the bottom; archived = muted + 보관됨 label, inputs read-only
  function exCard(e) {
    var A = e.archived, X = esc(e.id);
    return '<div class="mgcard' + (A ? ' archived' : '') + '" data-exid="' + X + '" data-search="' + esc((e.name + ' ' + e.body_part).toLowerCase()) + '">' +
      (A ? '<div class="mname">' + exName(e) + badge(e) + ' <span class="tag">보관됨</span></div>' : '') +
      '<div class="row"><input class="grow" data-exname="' + X + '" value="' + esc(e.name) + '"' + (A ? ' disabled hidden' : '') + '>' +
      '<select data-exbp="' + X + '" style="width:84px"' + (A ? ' disabled hidden' : '') + '>' + exerciseOptions(e.body_part) + '</select></div>' +
      (photos && photos.available() && !A ? '<div class="row photorow" style="margin-top:6px">' + (photos.url(e.id) ? '<img class="exthumb" src="' + photos.url(e.id) + '" alt="">' : '<span class="muted">사진 없음</span>') +
        '<label class="btn photobtn">' + (photos.url(e.id) ? '사진 바꾸기' : '사진 추가') + '<input type="file" accept="image/*" data-exphoto="' + X + '" hidden></label>' +
        (photos.url(e.id) ? '<button data-act="photodel" data-id="' + X + '">사진 삭제</button>' : '') + '</div>' : '') +
      (store.supportsMemo() && !A ? '<input style="width:100%;margin-top:6px" data-exmemo="' + X + '" maxlength="200" placeholder="메모 (그립 / 자극 부위 / 세팅)" value="' + esc(e.memo || '') + '">' : '') +
      '<div class="mgbtns">' + (A ? '<button data-act="earchive" data-id="' + X + '" data-f="0">복원</button>' : '<button class="primary" data-act="esave" data-id="' + X + '">저장</button><button data-act="earchive" data-id="' + X + '" data-f="1">보관</button>') +
      (store.supportsDelete() ? '<button class="danger" data-act="edelete" data-id="' + X + '">삭제</button>' : '') + '</div></div>';
  }
  // R13 §2: filter by hiding cards (no rebuild: unsaved edits in other cards and the focused search box stay untouched)
  function filterManage(q) {
    if (!S.sheet || S.sheet.type !== 'exercises') return;
    S.sheet.q = q; var t = String(q || '').trim().toLowerCase(), shown = 0, arcShown = 0;
    Array.prototype.forEach.call(document.querySelectorAll('#exlist .mgcard'), function (c) {
      var hit = !t || c.getAttribute('data-search').indexOf(t) >= 0; c.hidden = !hit; if (hit) { shown++; if (c.classList.contains('archived')) arcShown++; }
    });
    var ah = $('archead'); if (ah) ah.hidden = !arcShown; var no = $('exnone'); if (no) no.hidden = !!shown;
  }
  function renderSheet() {
    var s = S.sheet;
    if (!s) { $sheet.hidden = true; $sheet.innerHTML = ''; return; }
    var h = '';
    if (s.type === 'picker') {
      var pk = pickerList(s);
      h = '<h2>운동 선택</h2><input id="pq" placeholder="검색" value="' + esc(s.q || '') + '" autocomplete="off"><div class="list" id="picklist">' + pk.html + '</div>' +
        '<h2>새 운동</h2><input id="nxn" placeholder="운동 이름" value="' + esc(pk.empty && (s.q || '').trim() ? s.q : '') + '" autocomplete="off">' + bpChips(s.bp) + memoInput('nxm', '') +
        '<div class="err" id="serr"></div><button class="primary" style="width:100%" data-act="newex">만들고 선택</button><button style="width:100%;margin-top:8px" data-act="close">닫기</button>';
    } else if (s.type === 'editset') {
      var st = store.t.sets.get(s.id), ex = store.exercise(st.exercise_id), v0 = function (x) { return esc(has(x) ? x : ''); };
      var legacyDrops = st.drops && st.drops.length && !s.clearDrops; // read-only, clearable (never edited)
      h = '<h2>' + exName(ex) + badge(ex) + '</h2>' + (GL.isBodyweight(ex) ? // R12 맨몸: 횟수 + optional 무게 + 메모
        '<div class="entry bw">' + (has(st.seconds) ? '<input id="es" inputmode="numeric" placeholder="초" aria-label="초" value="' + v0(st.seconds) + '">' : '<input id="er" inputmode="numeric" placeholder="횟수" aria-label="횟수" value="' + v0(st.reps) + '">') + '<input class="w" id="ew" inputmode="decimal" placeholder="무게 (선택)" aria-label="무게" value="' + v0(st.weight) + '">' +
          '<input class="note" id="en" value="' + esc(st.note) + '" placeholder="메모"></div>' :
        GL.isCardio(ex) || has(st.minutes) ?
        '<div class="entry cardio"><input id="em" inputmode="numeric" placeholder="분" aria-label="분" value="' + v0(st.minutes) + '"><input id="ek" inputmode="decimal" placeholder="거리 km (선택)" aria-label="거리 km" value="' + v0(st.distance) + '">' +
          '<input class="note" id="en" value="' + esc(st.note) + '" placeholder="메모"></div>' :
        '<div class="entry' + (store.supportsReps() ? '' : ' noreps') + '"><button class="wu' + (st.is_warmup ? ' on' : '') + '" id="ewu" data-act="ewu">웜업</button>' +
          '<input class="w" id="ew" inputmode="decimal" placeholder="무게" aria-label="무게" value="' + v0(st.weight) + '">' + (store.supportsReps() ? '<input id="er" inputmode="numeric" placeholder="횟수" aria-label="횟수" value="' + v0(st.reps) + '">' : '') +
          '<input class="note" id="en" value="' + esc(st.note) + '" placeholder="메모"></div>' + nudgeHtml('ew', st.exercise_id)) +
        (legacyDrops ? '<div class="row legacyrow"><span class="grow muted" id="edrops">예전 드롭 기록: ' + esc(st.drops.join(', ')) + '</span><button data-act="cleardrops">드롭 지우기</button></div>' : '') +
        (s.clearDrops ? '<div class="muted" id="edropsgone">드롭 기록을 지워요 (저장하면 적용)</div>' : '') + '<div class="err" id="serr"></div>' +
        '<div class="row" style="margin-top:8px"><button class="primary grow" data-act="saveset">저장</button><button class="danger grow" data-act="delset">삭제</button><button class="grow" data-act="close">닫기</button></div>';
    } else if (s.type === 'copyday') {
      var src = GL.validDate(s.date) ? store.workoutFor(s.m, s.date) : null, blk = src ? store.blocksForWorkout(src.id).filter(function (b) { return !b.exercise.archived; }) : [];
      var nsets = blk.reduce(function (n, b) { return n + b.sets.length; }, 0);
      h = '<h2>다른 날/친구 기록 복사</h2><p class="muted">고른 날의 운동 목록을 ' + esc(dateLabel(S.date)) + '에 가져와요.</p>' +
        '<select id="cdm" aria-label="멤버">' + store.members().map(function (m) { return '<option value="' + esc(m.id) + '"' + (m.id === s.m ? ' selected' : '') + '>' + esc(m.name) + (m.id === S.view ? ' (나)' : '') + '</option>'; }).join('') + '</select>' +
        '<div style="height:8px"></div><input type="date" id="cdd" value="' + esc(s.date || '') + '">' +
        '<div class="opts"><label><input type="checkbox" id="cdsets"' + (s.sets ? ' checked' : '') + '>세트(무게)도 함께 복사</label></div>' +
        '<div class="muted" id="cdinfo">' + (blk.length ? esc(blk.map(function (b) { return b.exercise.name; }).join(', ')) + ' · 운동 ' + blk.length + ' · 세트 ' + nsets : '그 날은 기록이 없어요.') + '</div>' +
        '<div class="err" id="serr"></div><div class="row" style="margin-top:8px"><button class="primary grow" data-act="docopy"' + (blk.length ? '' : ' disabled') + '>복사</button><button class="grow" data-act="close">닫기</button></div>';
    } else if (s.type === 'cal') { // custom month calendar (the native picker cannot be coloured): records = dark green
      var cal = GL.calendarMonth(s.ym, GL.todayStr(), store.recordDates(S.view), store.dayParts(S.view)); // R12: body parts per day
      h = '<div class="cal-head"><button data-act="calmonth" data-ym="' + cal.prev + '" aria-label="이전 달">‹</button><h2 id="calym">' + Number(s.ym.slice(0, 4)) + '년 ' + Number(s.ym.slice(5)) + '월</h2>' +
        '<button data-act="calmonth" data-ym="' + cal.next + '" aria-label="다음 달">›</button></div><div class="cal-grid parts" id="calgrid">' +
        DAYS.map(function (d) { return '<div class="cal-wd">' + d + '</div>'; }).join('') +
        cal.weeks.map(function (wk) {
          return wk.map(function (c) {
            if (!c) return '<div></div>';
            var cls = 'cal-d' + (c.rec ? ' rec' : c.past ? ' past' : '') + (c.today ? ' today' : '') + (c.future ? ' future' : '') + (c.date === S.date ? ' sel' : '');
            return '<button class="' + cls + '" data-act="calpick" data-date="' + c.date + '" aria-label="' + esc(c.label) + '"><span class="cal-n">' + c.day + '</span>' +
              GL.partLabels(c.parts).map(function (p) { return '<span class="cal-p">' + esc(p) + '</span>'; }).join('') + '</button>';
          }).join('');
        }).join('') + '</div><div class="cal-legend muted"><span><i class="dot rec"></i>기록 있음</span><span><i class="dot past"></i>기록 없음</span><span><i class="dot today"></i>오늘</span></div>' +
        '<button style="width:100%;margin-top:8px" data-act="close">닫기</button>';
    } else if (s.type === 'calday') { // R12 day popup: exercises of that day grouped by body part, sets in the app format, per-exercise total
      var dd = store.dayDetail(S.view, s.date);
      h = '<div id="calday"><h2>' + esc(dateLabel(s.date)) + ' <span class="muted">' + esc((store.member(S.view) || {}).name || '') + '</span></h2>' +
        dd.map(function (g) {
          return '<div class="cdpart"><h3>' + esc(g.part) + '</h3>' + g.items.map(function (it) {
            return '<div class="cditem"><b>' + esc(it.exercise.name) + '</b>' + (it.exercise.archived ? ' <span class="muted">(보관됨)</span>' : '') + ' <span class="cdsets">' + esc(it.texts.join(' - ')) + '</span>' +
              (it.total ? ' <span class="muted cdtotal">' + esc(it.total) + '</span>' : '') + '</div>';
          }).join('') + '</div>';
        }).join('') + '</div>' +
        '<div class="row" style="margin-top:8px"><button class="primary grow" data-act="calgo" data-date="' + esc(s.date) + '">이 날로 가기</button><button class="grow" data-act="calback">달력</button><button class="grow" data-act="close">닫기</button></div>';
    } else if (s.type === 'split') { // R12 section 7: kind change of an exercise with records = archive + recreate
      var sx = store.exercise(s.id);
      h = '<h2>' + esc(sx.name) + ': ' + esc(sx.body_part) + ' → ' + esc(s.patch.body_part) + '</h2><p id="splitq">기존 기록은 그대로 두고 새 종류로 바꿀까요?</p>' +
        '<p class="muted">기록이 있는 운동은 유산소 ↔ 근력/맨몸으로 바로 바꿀 수 없어요 (근력 ↔ 맨몸은 그냥 바뀌어요). 지금 운동은 기록과 함께 보관되고(' + esc(sx.body_part) + ' 배지로 남아요), 같은 이름의 ' + esc(s.patch.body_part) + ' 운동을 새로 만들어요. 바로 되돌릴 수 있어요.</p>' +
        '<div class="err" id="serr"></div><div class="row"><button class="primary grow" data-act="splityes">새 종류로 바꾸기</button><button class="grow" data-act="gexercises">취소</button></div>';
    } else if (s.type === 'zoom') {
      var zex = store.exercise(s.ex), zu = photos && photos.url(s.ex);
      h = '<h2>' + (zex ? exName(zex) : '') + '</h2>' + (zu ? '<img class="zoomimg" src="' + zu + '" alt="">' : '<p class="muted">사진이 없어요.</p>') + (zex ? memoHtml(zex) : '') + '<button style="width:100%;margin-top:8px" data-act="close">닫기</button>';
    } else if (s.type === 'confirm') {
      h = '<h2>' + esc(s.title) + '</h2><p class="muted">' + esc(s.body) + '</p><div class="row"><button class="danger grow" data-act="confirmyes">' + esc(s.yesLabel || '삭제') + '</button><button class="grow" data-act="close">취소</button></div>';
    } else if (s.type === 'gear') {
      h = '<h2>설정</h2><div class="list"><button class="item" data-act="gmembers">멤버 관리 ›</button><button class="item" data-act="gexercises">운동 관리 ›</button>' +
        '<button class="item" data-act="export">백업 내보내기 (JSON)</button>' + (remote ? '' : '<button class="item" data-act="import">백업 가져오기 ›</button>') + '<button class="item danger" data-act="logout">로그아웃</button></div>' +
        '<button style="width:100%;margin-top:8px" data-act="close">닫기</button>';
    } else if (s.type === 'members') { // R13 §5: one card per member, buttons inside at the bottom
      h = '<h2>멤버 관리</h2><div class="list">' + store.members(true).map(function (m) {
        // server mode: the account is tied to the name (login hash), so the name is read-only there
        var nameCell = remote ? '<div class="mname">' + esc(m.name) + (m.archived ? ' <span class="tag">보관됨</span>' : '') + '</div>' : '<input class="grow" data-rename="' + esc(m.id) + '" value="' + esc(m.name) + '"' + (m.archived ? ' disabled' : '') + '>';
        return '<div class="mgcard' + (m.archived ? ' archived' : '') + '" data-mid="' + esc(m.id) + '">' + nameCell + '<div class="mgbtns">' +
          (m.archived ? '<button data-act="marchive" data-id="' + esc(m.id) + '" data-f="0">복원</button>' : (remote ? '' : '<button data-act="mrename" data-id="' + esc(m.id) + '">저장</button>') + '<button class="danger" data-act="marchive" data-id="' + esc(m.id) + '" data-f="1">보관</button>') + '</div></div>';
      }).join('') + '</div>' + (remote ? '' : '<h2>멤버 추가</h2><div class="row"><input id="nmn" placeholder="이름"><button class="primary" data-act="madd">추가</button></div>') + '<div class="err" id="serr">' + esc(s.err || '') + '</div>' +
        '<div class="row" style="margin-top:8px"><button class="grow" data-act="gear">뒤로</button><button class="grow" data-act="close">닫기</button></div>';
    } else if (s.type === 'exercises') { // R13: search (IME-safe), one card per exercise, active first, 보관한 운동 below, 삭제한 운동 at the bottom
      var all = store.manageExercises(), act = all.filter(function (e) { return !e.archived; }), arc = all.filter(function (e) { return e.archived; }), del = store.supportsDelete() ? store.deletedExercises() : [];
      h = '<div class="mgtitle"><h2>운동 관리</h2><button class="primary" data-act="eaddopen" aria-expanded="false">＋ 운동 추가</button></div>' + // R14: add form opens right under the title
        '<div id="addbox" class="mgcard addbox" hidden><input id="nxn" placeholder="운동 이름" autocomplete="off">' + bpChips(s.bp) + memoInput('nxm', '') +
        '<div class="row"><button class="grow" data-act="eaddclose">취소</button><button class="grow primary" data-act="eadd">추가</button></div></div>' +
        '<input id="eq" placeholder="운동 검색 (이름 · 부위)" autocomplete="off" value="' + esc(s.q || '') + '"><div class="err" id="serr">' + esc(s.err || '') + '</div>' +
        '<div class="list" id="exlist">' + act.map(exCard).join('') + '<div class="muted" id="exnone" hidden>검색 결과가 없어요.</div>' +
        (arc.length ? '<h3 class="mghead" id="archead">보관한 운동 <span class="muted">(목록에서 숨김 · 복원 가능)</span></h3>' + arc.map(exCard).join('') : '') + '</div>' +
        (del.length ? '<h3 class="mghead" id="delhead">삭제한 운동 <span class="muted">(기록은 그대로 있어요)</span></h3><div id="dellist">' + del.map(function (e) {
          return '<div class="mgcard deleted" data-delid="' + esc(e.id) + '"><div class="mname">' + exName(e) + badge(e) + '</div><div class="mgbtns"><button data-act="erestore" data-id="' + esc(e.id) + '">되살리기</button></div></div>';
        }).join('') + '</div>' : '') +
        '<div class="row" style="margin-top:8px"><button class="grow" data-act="gear">뒤로</button><button class="grow" data-act="close">닫기</button></div>';
    } else if (s.type === 'import') {
      h = '<h2>백업 가져오기</h2><p class="muted">같은 항목은 덮어쓰고 나머지는 합칩니다. 형식이 틀리면 아무것도 바뀌지 않아요.</p>' +
        '<input type="file" id="ifile" accept="application/json,.json"><textarea id="itext" placeholder="또는 JSON 붙여넣기"></textarea><div class="err" id="serr">' + esc(s.err || '') + '</div>' +
        '<button class="primary" style="width:100%" data-act="doimport">가져오기</button><div class="row" style="margin-top:8px"><button class="grow" data-act="gear">뒤로</button><button class="grow" data-act="close">닫기</button></div>';
    }
    $sheet.innerHTML = '<div class="panel" role="dialog" aria-modal="true">' + h + '</div>';
    $sheet.hidden = false;
    if (s.type === 'exercises' && s.q) filterManage(s.q);
    if (s.type === 'exercises' && s.added) { // R14: show + highlight the card just added
      var nc = $sheet.querySelector('#exlist [data-exid="' + s.added + '"]'); if (nc) { nc.classList.add('justadded'); nc.scrollIntoView({ block: 'center' }); }
    }
  }
  // R14: the add form is shown/hidden in place (no re-render: the search box and unsaved card edits stay as they are)
  function addBox(open) {
    var b = $('addbox'); if (!b) return false; if (b.hidden === !open) return false;
    b.hidden = !open; var o = $sheet.querySelector('[data-act=eaddopen]'); if (o) o.setAttribute('aria-expanded', String(!!open));
    if (open) { var n = $('nxn'); if (n) n.focus(); } return true;
  }

  // ---------------- actions ----------------
  function markChips() { Array.prototype.forEach.call(document.querySelectorAll('#bpchips .chip'), function (c) { var on = c.getAttribute('data-bp') === (S.sheet && S.sheet.bp); c.classList.toggle('on', on); c.setAttribute('aria-pressed', on); }); }
  function setErr(id, msg) { var e = $(id); if (e) e.textContent = msg; }
  var lastGuardErr = null;
  function guard(fn, errId) {
    try { return fn(); } catch (e) { lastGuardErr = e; setErr(errId || 'serr', humanError(e)); return undefined; }
  }
  function humanError(e) {
    var m = String(e && e.message || e);
    if (/duplicate exercise/.test(m)) return '같은 부위에 같은 이름의 운동이 이미 있어요. (다른 부위라면 같은 이름도 괜찮아요)';
    if (/duplicate/.test(m)) return '같은 이름이 이미 있어요.';
    if (/delete unsupported/.test(m)) return '삭제는 서버 업데이트 후 사용할 수 있어요. (보관은 지금도 돼요)';
    if (/undo would bring back|undo after the exercise changed family/.test(m)) return '운동 종류가 바뀌어서 이 기록은 되돌릴 수 없어요.'; // R13 r2: exercise undo too
    if (/bodyweight unsupported/.test(m)) return '맨몸 운동은 서버 업데이트 후 사용할 수 있어요.';
    if (/memo too long/.test(m)) return '메모는 200자까지 쓸 수 있어요.';
    if (/invalid body_part/.test(m)) return '이 부위는 아직 쓸 수 없어요.';
    if (/same day/.test(m)) return '같은 날 기록은 복사할 수 없어요.';
    if (/nothing to copy/.test(m)) return '그 날은 복사할 기록이 없어요.';
    if (/empty name/.test(m)) return '이름을 입력해 주세요.';
    if (/undo would bring back/.test(m)) return '운동 종류가 바뀌어서 이 기록은 되돌릴 수 없어요.';
    if (/kind change/.test(m)) return '기록이 있는 운동은 유산소 ↔ 근력/맨몸으로 바꿀 수 없어요.';
    if (/reps unsupported|cardio unsupported/.test(m)) return '횟수·유산소 기록은 서버 업데이트 후 사용할 수 있어요.';
    if (/invalid set/.test(m)) return setErrText(m.replace(/^.*invalid set: /, ''));
    if (/import rejected/.test(m)) return '가져오기 실패: ' + m.replace('import rejected: ', '') + ' (아무것도 바뀌지 않았어요)';
    return '오류: ' + m;
  }
  function setErrText(code) {
    return code === 'reps' ? '횟수는 1~1000 사이의 정수로 입력해 주세요.' : code === 'minutes' ? '분은 1~600 사이의 정수로 입력해 주세요.' :
      code === 'distance' ? '거리는 0~300 km 사이의 숫자로 입력해 주세요.' : code === 'drops' ? '드롭 값이 올바르지 않아요.' :
      code === 'bw' ? '맨몸 운동은 횟수만 기록해요 (웜업 없음).' : code === 'seconds' ? '초는 1~3600 사이의 정수로 입력해 주세요 (횟수와 초 중 하나만).' : '무게를 0 이상의 숫자로 입력해 주세요 (웜업은 무게를 비워도 돼요)';
  }
  // copy helpers (same / copy-last / copy day): the set's own columns; legacy drops are not carried into NEW entries
  function copyFields(s) { return { weight: s.weight, reps: s.reps, minutes: s.minutes, distance: s.distance, note: s.note, is_warmup: s.is_warmup }; }
  function addSets(exId, list) {
    var w = store.getOrCreateWorkout(S.view, S.date);
    list.forEach(function (f) { store.addSet(w.id, exId, f); });
    S.draft = S.draft.filter(function (id) { return id !== exId; });
  }
  function readEntry(exId) {
    var ex = store.exercise(exId);
    if (GL.isBodyweight(ex) && (S.bwMode[exId] || store.bwMode(S.view, exId)) === 'sec') return { seconds: $('s-' + exId).value, weight: $('w-' + exId) && !$('w-' + exId).hidden ? $('w-' + exId).value : '', note: $('n-' + exId).value };
    if (GL.isBodyweight(ex)) return { reps: $('r-' + exId).value, weight: $('w-' + exId) && !$('w-' + exId).hidden ? $('w-' + exId).value : '', note: $('n-' + exId).value };
    if ($('m-' + exId)) return { minutes: $('m-' + exId).value, distance: $('k-' + exId).value, note: $('n-' + exId).value };
    var f = { weight: $('w-' + exId).value, note: $('n-' + exId).value, is_warmup: !!S.wu[exId] };
    if ($('r-' + exId)) f.reps = $('r-' + exId).value;
    return f;
  }
  function undoToast(msg, token) { toast(msg, function () { try { store.undo(token); } catch (e) { toast(humanError(e)); } }); } // R13: a refused undo explains itself

  var actions = {
    retry: function () { kick(); },
    retryrejected: function () { store.retryRejected().then(function () { render(); kick(); }); },
    tab: function (d) { S.tab = d.t; render(); },
    member: function (d) { S.view = d.id; S.draft = []; render(); },
    dprev: function () { var d = store.adjacentDay(S.view, S.date, -1); if (d) { S.date = d; S.draft = []; render(); } }, // skip days without records
    dnext: function () { var d = store.adjacentDay(S.view, S.date, 1); if (d) { S.date = d; S.draft = []; render(); } },
    cal: function () { openSheet({ type: 'cal', ym: S.date.slice(0, 7) }); },
    calmonth: function (d) { if (S.sheet && S.sheet.type === 'cal') { S.sheet.ym = d.ym; renderSheet(); } },
    calpick: function (d) { // R12: a day with records opens the day popup; an empty day opens directly (as before)
      if (store.dayDetail(S.view, d.date).length) { openSheet({ type: 'calday', date: d.date, ym: S.sheet && S.sheet.ym || d.date.slice(0, 7) }); return; }
      S.date = d.date; S.draft = []; closeSheet(); render();
    },
    calgo: function (d) { S.date = d.date; S.draft = []; closeSheet(); render(); window.scrollTo(0, 0); },
    calback: function () { var ym = S.sheet && S.sheet.ym || S.date.slice(0, 7); openSheet({ type: 'cal', ym: ym }); },
    dtoday: function () { S.date = GL.todayStr(); S.draft = []; render(); },
    openday: function (d) { S.date = d.date; S.draft = []; render(); window.scrollTo(0, 0); },
    gear: function () { openSheet({ type: 'gear' }); },
    close: function () { closeSheet(); },
    addex: function () { openSheet({ type: 'picker', q: '' }); },
    pick: function (d) { if (S.draft.indexOf(d.id) < 0) S.draft.push(d.id); closeSheet(); S.focus = 'w-' + d.id; render(); },
    newex: function () {
      if (!S.sheet.bp) { setErr('serr', '부위를 골라 주세요.'); return; }
      var made = guard(function () { return store.addExercise($('nxn').value, S.sheet.bp, $('nxm') ? $('nxm').value : ''); });
      if (!made) return;
      if (GL.suggestBwMode(made.name) === 'sec' && GL.isBodyweight(made)) S.bwMode[made.id] = 'sec'; // 플랭크 / 월싯 / 행잉 start in 초
      S.draft.push(made.id); closeSheet(); S.focus = 'w-' + made.id; changed();
    },
    wu: function (d) { S.wu[d.ex] = !S.wu[d.ex]; var b = document.querySelector('.wu[data-ex="' + d.ex + '"]'); b.classList.toggle('on', S.wu[d.ex]); b.setAttribute('aria-pressed', !!S.wu[d.ex]); },
    ewu: function () { $('ewu').classList.toggle('on'); },
    addset: function (d) {
      var f = readEntry(d.ex), cardio = !!$('m-' + d.ex), kind = GL.kindOf(store.exercise(d.ex)), v = GL.validateSetFields(f, kind === 'str' ? null : kind);
      var focusOf = { reps: 'r-', seconds: 's-', minutes: 'm-', distance: 'k-' }, first = cardio ? 'm-' : kind === 'bw' ? ((S.bwMode[d.ex] || store.bwMode(S.view, d.ex)) === 'sec' ? 's-' : 'r-') : 'w-'; // R12 r2: 초 has its own field id
      if (!v.ok) { toast(setErrText(v.error)); var fe = $((focusOf[v.error] || first) + d.ex); if (fe) fe.focus(); return; }
      if (guard(function () { addSets(d.ex, [f]); return true; }) === undefined) { toast(humanError(lastGuardErr)); return; }
      S.wu[d.ex] = false; // warm-up toggle applies to one set, then resets
      S.keep[d.ex] = { w: f.weight, r: f.reps, s: f.seconds, m: f.minutes, k: f.distance }; startRest(d.ex); // P2 keep values, P5 rest
      S.focus = first + d.ex; changed(d.ex);
    },
    bwmode: function (d) { var cur = S.bwMode[d.ex] || store.bwMode(S.view, d.ex); S.bwMode[d.ex] = cur === 'sec' ? 'reps' : 'sec'; changed(); },
    friendday: function (d) { // P1: same as copy-day "list only" (sets:false): drafts only, no row written
      var res = guard(function () { return store.copyDay(d.id, S.date, S.view, S.date, { sets: false }); }); if (!res) return;
      res.exerciseIds.forEach(function (id) { if (S.draft.indexOf(id) < 0) S.draft.push(id); });
      toast('운동 ' + res.exerciseIds.length + '개를 가져왔어요 (무게는 비어 있어요)'); render();
    },
    awake: function () { var on = !awakeOn(); setAwake(on); if (on) acquireWake(); else releaseWake(); paintAwake(); },
    bwweight: function (d) { S.bww[d.ex] = true; var w = $('w-' + d.ex), b = document.querySelector('[data-act=bwweight][data-ex="' + d.ex + '"]'); if (w) { w.hidden = false; w.focus(); } if (b) b.hidden = true; }, // R12: weighted pull-ups etc.
    addwu: function (d) { addSets(d.ex, [{ weight: '', note: '', is_warmup: true }]); startRest(d.ex); S.focus = 'w-' + d.ex; changed(d.ex); }, // one tap: a weightless warm-up set
    same: function (d) {
      var w = store.workoutFor(S.view, S.date), sets = w ? store.setsForWorkout(w.id).filter(function (s) { return s.exercise_id === d.ex; }) : [];
      var last = sets[sets.length - 1]; if (!last) return;
      if (guard(function () { addSets(d.ex, [copyFields(last)]); return true; }) === undefined) { toast(humanError(lastGuardErr)); return; }
      startRest(d.ex); changed();
    },
    copylast: function (d) {
      var src = store.lastSession(S.view, d.ex, S.date); if (!src.length) return;
      if (guard(function () { addSets(d.ex, src.map(copyFields)); return true; }) === undefined) { toast(humanError(lastGuardErr)); return; }
      toast('지난 기록 ' + src.length + '세트를 복사했어요'); changed();
    },
    nudge: function (d) {
      var inp = $(d.target); if (!inp) return;
      inp.value = GL.nudge(inp.value, Number(d.d), d.ex ? store.nudgeBase(S.view, d.ex, S.date) : null);
    },
    copyday: function () {
      var past = store.historyDays(S.view).filter(function (x) { return x.date < S.date; })[0];
      openSheet({ type: 'copyday', m: S.view, date: past ? past.date : '', sets: true });
    },
    docopy: function () {
      var s = S.sheet, res = guard(function () { return store.copyDay(s.m, s.date, S.view, S.date, { sets: !!s.sets }); });
      if (!res) return;
      if (s.sets) { toast(res.sets + '세트를 복사했어요', function () { store.undoCopy(res); }); }
      else {
        var w = store.workoutFor(S.view, S.date), have = {}; (w ? store.blocksForWorkout(w.id) : []).forEach(function (b) { have[b.exercise.id] = 1; });
        var added = res.exerciseIds.filter(function (id) { return !have[id] && S.draft.indexOf(id) < 0; });
        added.forEach(function (id) { S.draft.push(id); });
        toast('운동 ' + added.length + '개를 가져왔어요', function () { S.draft = S.draft.filter(function (id) { return added.indexOf(id) < 0; }); render(); });
      }
      closeSheet(); changed();
    },
    paste: function (d) {
      var r = GL.parseLines($('p-' + d.ex).value);
      if (r.errors.length || !r.ok.length) { // nothing is written when any line is bad; old drop lists get their own Korean message
        setErr('perr-' + d.ex, r.ok.length || r.errors.length ? r.errors.map(function (e) { return e.line + '번째 줄: ' + (e.ko || '읽을 수 없어요') + ' — ' + e.text; }).join(' / ') : '입력된 줄이 없어요.');
        return;
      }
      if (!store.supportsReps() && r.ok.some(function (x) { return x.reps !== null; })) { setErr('perr-' + d.ex, '횟수는 서버 업데이트 후 사용할 수 있어요. 괄호 없이 무게만 써 주세요.'); return; }
      // R12: every set is checked against THIS exercise's kind before anything is written (`(15)` needs a 맨몸 exercise,
      // 맨몸 has no warm-up); one bad set -> nothing written
      var kind = GL.kindOf(store.exercise(d.ex)), badAt = -1, badV = null;
      r.ok.some(function (x, i) { var v = GL.validateSetFields(x, kind === 'str' ? null : kind); if (!v.ok) { badAt = i; badV = v; return true; } return false; });
      if (badAt >= 0) { setErr('perr-' + d.ex, (badAt + 1) + '번째 세트: ' + (kind === 'str' && badV.error === 'weight' ? '무게가 없어요. 횟수만 기록하려면 부위를 맨몸으로 만든 운동을 쓰세요.' : setErrText(badV.error))); return; }
      if (guard(function () { addSets(d.ex, r.ok); return true; }, 'perr-' + d.ex) === undefined) return;
      changed(d.ex);
    },
    editset: function (d) {
      var st = store.t.sets.get(d.id), t = function (x) { return has(x) ? String(x) : ''; }; // the values the form is opened with: only edits relative to these are saved
      openSheet({ type: 'editset', id: d.id, base: st ? { weight: t(st.weight), reps: t(st.reps), minutes: t(st.minutes), distance: t(st.distance), drops: st.drops && st.drops.length ? st.drops.join(',') : '', note: st.note, is_warmup: !!st.is_warmup } : null });
    },
    cleardrops: function () { // in place: no re-render, so what the user typed (weight / reps / memo) stays; the opening base snapshot is untouched
      if (!S.sheet || S.sheet.type !== 'editset') return;
      S.sheet.clearDrops = true;
      var row = document.querySelector('#sheet .legacyrow'); if (row) row.outerHTML = '<div class="muted" id="edropsgone">드롭 기록을 지워요 (저장하면 적용)</div>';
    },
    saveset: function () {
      var s = S.sheet, ok = guard(function () {
        var f = $('em') ? { minutes: $('em').value, distance: $('ek').value, note: $('en').value } : { weight: $('ew').value, note: $('en').value, is_warmup: !!$('ewu') && $('ewu').classList.contains('on') };
        if ($('er')) f.reps = $('er').value;
        if ($('es')) f.seconds = $('es').value;
        if (s.clearDrops) f.drops = ''; // legacy drops are removed only by the explicit button
        store.updateSet(s.id, f, s.base); return true;
      });
      if (ok) { closeSheet(); changed(); }
    },
    delset: function () { var tok = store.deleteSet(S.sheet.id); closeSheet(); undoToast('세트를 삭제했어요', tok); changed(); },
    delblock: function (d) {
      var ex = store.exercise(d.ex), w = store.workoutFor(S.view, S.date), n = w ? store.setsForWorkout(w.id).filter(function (s) { return s.exercise_id === d.ex; }).length : 0;
      if (!n) { S.draft = S.draft.filter(function (id) { return id !== d.ex; }); render(); return; }
      openSheet({ type: 'confirm', title: ex.name + ' 기록을 삭제할까요?', body: n + '세트가 삭제돼요. 삭제 직후 되돌릴 수 있어요.', yes: { act: 'block', ex: d.ex } });
    },
    delday: function () { openSheet({ type: 'confirm', title: S.date + ' 기록 전체를 삭제할까요?', body: '이 날의 모든 운동과 세트가 삭제돼요. 삭제 직후 되돌릴 수 있어요.', yes: { act: 'day' } }); },
    confirmyes: function () {
      var y = S.sheet.yes, w = store.workoutFor(S.view, S.date), tok;
      if (y.act === 'exdel') { tok = guard(function () { return store.deleteExercise(y.id); }); if (!tok) return; S.draft = S.draft.filter(function (id) { return id !== y.id; }); openSheet({ type: 'exercises' }); undoToast('목록에서 삭제했어요 (기록은 그대로 남아요)', tok); changed(); return; }
      if (!w) { closeSheet(); return; }
      if (y.act === 'block') { tok = store.deleteExerciseBlock(w.id, y.ex); undoToast('운동 기록을 삭제했어요', tok); }
      else { tok = store.deleteDay(w.id); undoToast('하루 기록을 삭제했어요', tok); }
      closeSheet(); changed();
    },
    gmembers: function () { openSheet({ type: 'members' }); },
    gexercises: function () { openSheet({ type: 'exercises' }); },
    madd: function () { var ok = guard(function () { store.addMember($('nmn').value); return true; }); if (ok) { openSheet({ type: 'members' }); changed(); } },
    mrename: function (d) {
      var inp = document.querySelector('[data-rename="' + d.id + '"]');
      var ok = guard(function () { store.renameMember(d.id, inp.value); return true; });
      if (ok) { openSheet({ type: 'members' }); changed(); }
    },
    marchive: function (d) {
      if (d.f === '1' && d.id === (auth.current() || {}).id) { setErr('serr', '지금 로그인한 멤버는 보관할 수 없어요.'); return; }
      var tok = store.archiveMember(d.id, d.f === '1'); if (d.f === '1') undoToast('멤버를 보관했어요', tok);
      openSheet({ type: 'members' }); changed();
    },
    eye: function () { try { localStorage.setItem('gl:showphotos', showPhotos() ? '0' : '1'); } catch (e) { /* private mode: toggle just does not stick */ } render(); },
    zoom: function (d) { openSheet({ type: 'zoom', ex: d.ex }); },
    photodel: function (d) {
      photos.remove(d.id).then(function () { toast('사진을 지웠어요'); if (S.sheet && S.sheet.type === 'exercises') renderSheet(); render(); })
        .catch(function () { toast('사진을 지우지 못했어요. 연결을 확인하고 다시 해 주세요.'); });
    },
    bpsel: function (d) { S.sheet.bp = d.bp; S.sheet.bpPicked = true; markChips(); },
    eadd: function () {
      if (!S.sheet.bp) { setErr('serr', '부위를 골라 주세요.'); return; }
      var ok = guard(function () { return store.addExercise($('nxn').value, S.sheet.bp, $('nxm') ? $('nxm').value : ''); });
      if (ok) { openSheet({ type: 'exercises', added: ok.id }); changed(); } // R14: the new card is shown + highlighted
    },
    eaddopen: function () { addBox($('addbox').hidden); },
    eaddclose: function () { addBox(false); },
    esave: function (d) {
      var n = document.querySelector('[data-exname="' + d.id + '"]').value, b = document.querySelector('[data-exbp="' + d.id + '"]').value;
      var mi = document.querySelector('[data-exmemo="' + d.id + '"]'), patch = { name: n, body_part: b }; if (mi) patch.memo = mi.value;
      if (store.needsSplit(d.id, patch)) { openSheet({ type: 'split', id: d.id, patch: patch }); return; } // R12 section 7: ask, never refuse
      var ok = guard(function () { store.updateExercise(d.id, patch); return true; });
      if (ok) { openSheet({ type: 'exercises' }); changed(); }
    },
    edelete: function (d) { var e = store.exercise(d.id); openSheet({ type: 'confirm', title: e.name + ' (' + e.body_part + ')', body: '목록에서 삭제할까요? 기록은 그대로 남아요.', yes: { act: 'exdel', id: d.id }, yesLabel: '목록에서 삭제' }); },
    erestore: function (d) {
      var tok = guard(function () { return store.restoreDeleted(d.id); }); if (!tok) return;
      openSheet({ type: 'exercises' }); undoToast('운동을 되살렸어요', tok); changed();
    },
    splityes: function () {
      var s = S.sheet, r = guard(function () { return store.splitExercise(s.id, s.patch); });
      if (!r) return;
      var pu = photos && photos.url(s.id); if (pu) photos.set(r.created.id, pu).catch(function () { /* photo is optional: the old one stays with the archived exercise */ });
      openSheet({ type: 'exercises' }); undoToast(r.created.name + ': ' + r.created.body_part + '(으)로 새로 만들었어요. 이전 기록은 보관됐어요.', r.inverse); changed();
    },
    earchive: function (d) { var tok = store.archiveExercise(d.id, d.f === '1'); if (d.f === '1') undoToast('운동을 보관했어요 (기록은 그대로 남아요)', tok); openSheet({ type: 'exercises' }); changed(); },
    export: function () {
      var data = JSON.stringify(store.exportData(), null, 2), name = 'gymlog-backup-' + GL.todayStr() + '.json';
      function download() { // anchor fallback; the object URL is released afterwards
        var url = URL.createObjectURL(new Blob([data], { type: 'application/json' })), a = document.createElement('a');
        a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        toast('백업 파일을 만들었어요');
      }
      try { // iPhone Safari: share sheet ("파일에 저장") is the reliable way to get a file out
        var file = new File([data], name, { type: 'application/json' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          navigator.share({ files: [file], title: name }).then(function () { toast('백업 파일을 공유했어요'); })
            .catch(function (e) { if (!e || e.name !== 'AbortError') download(); });
          return;
        }
      } catch (e) { /* fall through to download */ }
      download();
    },
    import: function () { openSheet({ type: 'import' }); },
    doimport: function () {
      var f = $('ifile').files[0], run = function (text) {
        store.importData(text).then(function (c) { closeSheet(); toast('가져왔어요: 멤버 ' + c.members + ' · 운동 ' + c.exercises + ' · 기록 ' + c.workouts + ' · 세트 ' + c.sets); render(); kick(); })
          .catch(function (e) { setErr('serr', humanError(e)); });
      };
      if (f) { var r = new FileReader(); r.onload = function () { run(String(r.result)); }; r.readAsText(f); }
      else run($('itext').value);
    },
    logout: function () { auth.logout(); closeSheet(); S.view = null; render(); },
    pickname: function (d) { $('lname').value = d.name; $('lpin').focus(); },
    gmode: function (d) { S.g.mode = d.m; render(); },
    gkind: function (d) { S.g.kind = d.k; render(); },
    gbp: function (d) { S.g.bp = d.bp; render(); },
    grange: function (d) { S.g.range = d.r === 'all' ? 'all' : Number(d.r); render(); },
    gopen: function (d) { S.g.mode = 'ex'; S.g.exId = d.id; render(); window.scrollTo(0, 0); }
  };

  document.addEventListener('click', function (ev) {
    if (ev.target === $sheet) { closeSheet(); return; }
    var ab = $('addbox'); // R14: a tap outside the open add form closes it without adding
    if (ab && !ab.hidden && !ab.contains(ev.target) && !ev.target.closest('[data-act=eaddopen]')) { addBox(false); return; }
    var el = ev.target.closest('[data-act]'); if (!el) return;
    var act = el.getAttribute('data-act');
    if (roNow() && WRITE_ACTS.indexOf(act) >= 0) { toast('다른 창에서 열려 있어서 지금은 보기만 가능해요.'); return; }
    var fn = actions[act]; if (fn) fn(el.dataset);
  });
  document.addEventListener('submit', function (ev) {
    var form = ev.target.getAttribute('data-form'); if (!form) return;
    ev.preventDefault();
    if (form === 'login') {
      var btn = ev.target.querySelector('button.primary'); if (btn) btn.disabled = true;
      auth.login($('lname').value, $('lpin').value).then(function (m) { S.view = m.id; S.loginErr = ''; render(); kick(); if (photos) photos.init().then(function () { render(); syncPhotos(); }); })
        .catch(function (e) { S.loginErr = loginErrorText(e); setErr('lerr', S.loginErr); if (btn) btn.disabled = false; });
    } else if (form === 'firstmember') {
      var ok = guard(function () { store.addMember($('fname').value); return true; }, 'lerr');
      if (ok) { kick(); render(); }
    }
  });
  document.addEventListener('input', function (ev) {
    if (ev.target.id === 'nxn' && S.sheet && !S.sheet.bpPicked) { // hint only: the user's own tap always wins
      var sug = GL.suggestBodyPart(ev.target.value, store.bodyParts()); if (sug) { S.sheet.bp = sug; markChips(); }
    }
    if (ev.target.id === 'nxn' && S.sheet && S.sheet.type === 'picker') S.sheet.nxnTyped = !!ev.target.value; // the user's own name is never overwritten by the search
    // R12 IME: skip while composing (iOS Korean), the list is updated on compositionend; never rebuild the focused input
    if (ev.target.id === 'pq' && S.sheet && !ev.isComposing && !S.composing) updatePicker(ev.target.value);
    if (ev.target.id === 'eq' && S.sheet && !ev.isComposing && !S.composing) filterManage(ev.target.value); // R13 §2: same IME rule
  });
  document.addEventListener('focusin', function (ev) { // P2: typing replaces the kept value. Next tick: a selection made inside focus is reset by browsers (iOS Safari too)
    var t = ev.target; if (!(t.matches && t.matches('.entry input') && t.value)) return;
    setTimeout(function () { if (document.activeElement === t) try { t.setSelectionRange(0, t.value.length); } catch (e) { /* not a text field */ } }, 0);
  });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') { acquireWake(); restTick(); } });
  document.addEventListener('compositionstart', function (ev) { if (ev.target.id === 'pq' || ev.target.id === 'eq') S.composing = true; });
  document.addEventListener('compositionend', function (ev) {
    if (ev.target.id === 'pq') { S.composing = false; updatePicker(ev.target.value); }
    if (ev.target.id === 'eq') { S.composing = false; filterManage(ev.target.value); }
  });
  document.addEventListener('change', function (ev) {
    var id = ev.target.id;
    if (ev.target.hasAttribute && ev.target.hasAttribute('data-exphoto')) {
      var inp = ev.target, exId = inp.getAttribute('data-exphoto'), f = inp.files && inp.files[0];
      if (!f) return;
      if (roNow()) { toast('다른 창에서 열려 있어서 지금은 보기만 가능해요.'); inp.value = ''; return; }
      resizeToJpeg(f).then(function (thumb) {
        return photos.set(exId, thumb).then(function () { toast('사진을 저장했어요'); if (S.sheet && S.sheet.type === 'exercises') renderSheet(); render(); },
          function () { toast('사진을 올리지 못했어요. 연결을 확인하고 다시 해 주세요. (기록에는 영향이 없어요)'); });
      }, function () { toast('이 사진은 읽을 수 없어요. 다른 사진을 골라 주세요.'); });
      inp.value = '';
      return;
    }
    if (id === 'cdm' || id === 'cdd' || id === 'cdsets') {
      if (S.sheet && S.sheet.type === 'copyday') { S.sheet.m = $('cdm').value; S.sheet.date = $('cdd').value; S.sheet.sets = $('cdsets').checked; renderSheet(); }
    }
    else if (id === 'gmonth') { S.g.range = ev.target.value ? { month: ev.target.value } : 'all'; render(); }
    else if (id === 'gex') { S.g.exId = ev.target.value; render(); }
    else if (id === 'gmem') { S.g.mem = ev.target.value; render(); }
    else if (id === 'gwu') { S.g.wu = ev.target.checked; render(); }
    else if (id === 'gmax') { S.g.max = ev.target.checked; render(); }
    else if (id === 'gvol') { S.g.vol = ev.target.checked; render(); }
    else if (id === 'gdist') { S.g.dist = ev.target.checked; render(); }
    else if (id === 'gcex') { S.g.cExId = ev.target.value; render(); }
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && S.sheet) { if (!addBox(false)) closeSheet(); } // R14: Esc closes the open add form first
    if (ev.key === 'Enter' && ev.target.matches && ev.target.matches('.entry input')) {
      var card = ev.target.closest('.card'); // the edit sheet has no card: Enter there saves the edit
      var b = card && card.querySelector('[data-act="addset"]'); if (b) b.click();
      else if (S.sheet && S.sheet.type === 'editset') actions.saveset();
    }
  });

  window.__gl = { store: store, auth: auth, adapter: adapter, state: S, render: render, clock: clock, restTick: restTick, wakeState: function () { return { held: !!wakeLock, pending: wakePending }; } }; // debugging / UI test hook

  // friends' new entries appear when the app is reopened / refocused (no realtime)
  var refreshing = false;
  function syncPhotos() {
    if (!photos) return;
    var was = photos.state;
    photos.sync().then(function (ch) {
      var a = document.activeElement, typing = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
      if ((ch || was !== photos.state) && !S.sheet && !typing && auth.current()) render();
    });
  }
  function refreshNow() {
    if (!remote || refreshing || !auth.current()) return;
    syncPhotos();
    refreshing = true;
    store.refresh().then(function (changed) {
      var a = document.activeElement, typing = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
      if (changed && !S.sheet && !typing) render();
    }).catch(function () { /* offline etc.: keep showing what we have */ }).then(function () { refreshing = false; });
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') refreshNow(); });
  window.addEventListener('focus', refreshNow);

  function renderLoadError(e) {
    $app.innerHTML = '<div class="login"><h1>GymLog</h1><p class="muted">데이터를 불러오지 못했어요. 네트워크를 확인해 주세요.</p>' +
      '<div class="err">' + esc(String(e && e.message || e)) + '</div><button class="primary" style="width:100%" data-act="reload">다시 시도</button>' +
      '<button style="width:100%;margin-top:8px" data-act="logout">로그아웃</button></div>';
  }
  function boot() {
    if (remote && !auth.hasSession()) { render(); return; }
    if (remote) $app.innerHTML = '<div class="login"><h1>GymLog</h1><p class="muted">불러오는 중…</p></div>';
    store.load().then(function () {
      if (!remote) store.seedExercisesIfFirstRun();
      var me = auth.current(); if (me) S.view = me.id;
      render(); kick(); acquireWake(); // P4: only when the user turned it on on this device
      if (photos && me) photos.init().then(function () { render(); syncPhotos(); });
    }).catch(function (e) {
      if (e && e.code === 'AUTH') { S.loginErr = '로그인이 만료됐어요. 다시 로그인해 주세요.'; render(); }
      else renderLoadError(e);
    });
  }
  actions.reload = boot;
  boot();
  // lease: renew while writer; as a reader take over as soon as the other window is gone
  if (remote) {
    setInterval(function () {
      if (!auth.current()) return;
      var was = store.writer;
      store.leaseTick().then(function (took) {
        if (took) { render(); kick(); } else if (was && !store.writer) render();
      }).catch(function () { /* offline: try again next tick */ });
    }, 2000);
    window.addEventListener('pagehide', function () { store.releaseLease(); });
  }
})();
