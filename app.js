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

  var DAYS = ['일', '월', '화', '수', '목', '금', '토'];
  var COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0ca678'];
  var S = {
    tab: 'log', view: null, date: GL.todayStr(), draft: [], wu: {}, focus: null, sheet: null, loginErr: '',
    g: { mode: 'ex', exId: null, mem: 'all', wu: false, max: true, bp: '이두', range: 30 }
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
    'madd', 'mrename', 'marchive', 'eadd', 'esave', 'earchive', 'doimport', 'undo', 'retryrejected', 'retry'];
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
    Array.prototype.forEach.call($app.querySelectorAll('input[id^="w-"],input[id^="w2-"],input[id^="n-"],textarea[id^="p-"]'), function (e) { if (e.value) d[e.id] = e.value; });
    return d;
  }
  function restoreDrafts(d, skipEx) {
    Object.keys(d).forEach(function (id) {
      if (skipEx && id.slice(id.indexOf('-') + 1) === skipEx) return; // the card that just saved starts clean
      var e = $(id); if (e && !e.value) e.value = d[id];
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

  function headerHtml(noChips) {
    var members = store.members();
    return '<div id="robanner" class="banner"' + (roNow() ? '' : ' hidden') + '>다른 창에서 열려 있어요. 그 창을 닫거나 잠시 기다리면 여기서 이어서 쓸 수 있어요. (지금은 보기만 가능해요)</div>' +
      '<div id="offbanner" class="banner"' + (store.offline ? '' : ' hidden') + '>오프라인이에요. 저장된 기록으로 열었고, 새 기록은 연결되면 자동으로 올라가요.</div>' +
      '<div class="top"><div id="savestate" class="save ' + store.status + '"></div>' +
      '<button data-act="gear" aria-label="설정">⚙ 설정</button></div>' +
      (noChips ? '' : '<div class="chips" id="memberchips">' + members.map(function (m) {
        return '<button class="chip' + (m.id === S.view ? ' on' : '') + '" data-act="member" data-id="' + esc(m.id) + '">' + esc(m.name) + '</button>';
      }).join('') + '</div>');
  }

  function blockHtml(ex, sets) {
    var rows = sets.map(function (s, i) {
      return '<div class="setrow"><span class="idx">' + (i + 1) + '</span><button class="txt" data-act="editset" data-id="' + esc(s.id) + '">' +
        (store.isRejected('sets', s.id) ? '<span class="tag reject">서버 거부</span> ' : '') + (s.is_warmup ? '<span class="tag">웜업</span> ' : '') + '<b>' + esc(GL.formatSet({ weight: s.weight, weight2: s.weight2, note: s.note, is_warmup: false })) + '</b></button>' +
        '<button class="ghost" data-act="editset" data-id="' + esc(s.id) + '" aria-label="수정">✎</button></div>';
    }).join('');
    var last = sets.length ? sets[sets.length - 1] : null;
    var prevSess = store.lastSession(S.view, ex.id, S.date);
    var on = S.wu[ex.id] ? ' on' : '';
    return '<div class="card" data-ex="' + esc(ex.id) + '"><div class="row"><h3 class="grow">' + exName(ex) + badge(ex) + '</h3>' +
      '<button class="ghost danger" data-act="delblock" data-ex="' + esc(ex.id) + '" aria-label="운동 삭제">🗑</button></div>' + rows +
      '<div class="entry"><button class="wu' + on + '" data-act="wu" data-ex="' + esc(ex.id) + '" aria-pressed="' + (!!S.wu[ex.id]) + '">웜업</button>' +
      '<input id="w-' + esc(ex.id) + '" inputmode="decimal" placeholder="무게" autocomplete="off">' +
      '<input id="w2-' + esc(ex.id) + '" inputmode="decimal" placeholder="무게2(선택)" autocomplete="off">' +
      '<input class="note" id="n-' + esc(ex.id) + '" placeholder="메모(선택)" autocomplete="off">' +
      '<button class="primary add" data-act="addset" data-ex="' + esc(ex.id) + '">추가</button></div>' +
      '<div class="quick">' +
      '<button data-act="same" data-ex="' + esc(ex.id) + '"' + (last ? '' : ' disabled') + '>이전 세트와 같게</button>' +
      '<button data-act="copylast" data-ex="' + esc(ex.id) + '"' + (prevSess.length ? '' : ' disabled') + '>지난 기록 복사' + (prevSess.length ? ' (' + prevSess.length + '세트)' : '') + '</button></div>' +
      '<details><summary>붙여넣기 입력 (예: 웜업 - 15 - 20(15))</summary><textarea id="p-' + esc(ex.id) + '" placeholder="한 줄에 한 세트"></textarea>' +
      '<div class="err" id="perr-' + esc(ex.id) + '"></div><button data-act="paste" data-ex="' + esc(ex.id) + '">붙여넣은 세트 추가</button></details></div>';
  }

  function renderLog() {
    var w = store.workoutFor(S.view, S.date);
    var blocks = w ? store.blocksForWorkout(w.id) : [];
    var have = {}; blocks.forEach(function (b) { have[b.exercise.id] = 1; });
    var drafts = S.draft.filter(function (id) { return !have[id] && store.exercise(id); });
    var html = headerHtml() +
      '<div class="datebar"><button data-act="dprev" aria-label="전날">◀</button><input type="date" id="datein" value="' + esc(S.date) + '">' +
      '<button data-act="dnext" aria-label="다음날">▶</button><button data-act="dtoday">오늘</button></div>' +
      '<div class="muted" style="margin-bottom:6px">' + esc(dateLabel(S.date)) + ' · ' + esc((store.member(S.view) || {}).name || '') + '</div>';
    drafts.forEach(function (id) { html += blockHtml(store.exercise(id), []); });
    blocks.forEach(function (b) { html += blockHtml(b.exercise, b.sets); });
    if (!blocks.length && !drafts.length) html += '<div class="empty">이 날 기록이 없어요. 운동을 추가해 보세요.</div>';
    html += '<button class="primary" style="width:100%" data-act="addex">＋ 운동 추가</button>';
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
  function memberIdsFor(mem) { return mem === 'all' ? null : [mem]; }

  function exercisesWithData() {
    return store.exercises(true).filter(function (e) { return e.body_part && (!e.archived || store.seriesFor(e.id, { includeWarmup: true }).length); });
  }

  function renderGrowth() {
    var g = S.g, html = headerHtml(true);
    html += '<div class="seg"><button data-act="gmode" data-m="ex" class="' + (g.mode === 'ex' ? 'on' : '') + '">운동별</button>' +
      '<button data-act="gmode" data-m="bp" class="' + (g.mode === 'bp' ? 'on' : '') + '">부위별</button></div>';
    var memOpts = '<option value="all">전체 (각자 따로)</option>' + store.members(true).map(function (m) {
      return '<option value="' + esc(m.id) + '"' + (g.mem === m.id ? ' selected' : '') + '>' + esc(m.name) + '</option>'; }).join('');
    var wuOpt = '<label><input type="checkbox" id="gwu"' + (g.wu ? ' checked' : '') + '>웜업 포함</label>';
    if (g.mode === 'ex') {
      var exs = exercisesWithData();
      if (!g.exId || !store.exercise(g.exId)) g.exId = exs.length ? exs[0].id : null;
      var ex = g.exId ? store.exercise(g.exId) : null;
      html += '<select id="gex" aria-label="운동 선택">' + GL.BODY_PARTS.map(function (bp) {
        var l = exs.filter(function (e) { return e.body_part === bp; });
        return l.length ? '<optgroup label="' + esc(bp) + '">' + l.map(function (e) { return '<option value="' + esc(e.id) + '"' + (e.id === g.exId ? ' selected' : '') + '>' + esc(e.name) + (e.archived ? ' (보관됨)' : '') + '</option>'; }).join('') + '</optgroup>' : '';
      }).join('') + '</select>';
      html += '<div style="height:8px"></div><select id="gmem" aria-label="멤버">' + memOpts + '</select>';
      html += '<div class="opts">' + wuOpt + '<label><input type="checkbox" id="gmax"' + (g.max ? ' checked' : '') + '>최대값 선도 표시</label></div>';
      if (!ex) return html + '<div class="empty">아직 운동이 없어요.</div>';
      var mids = g.mem === 'all' ? store.members(true).map(function (m) { return m.id; }) : [g.mem];
      var series = [], tables = '';
      mids.forEach(function (id) {
        var pts = store.seriesFor(ex.id, { memberIds: [id], includeWarmup: g.wu });
        if (!pts.length) return;
        var m = store.member(id), color = memberColor(id);
        if (g.max) series.push({ name: m.name + ' 최대', color: color, dash: true, opacity: .45, points: pts.map(function (p) { return { x: p.date, y: p.max }; }) });
        series.push({ name: m.name + ' 평균', color: color, points: pts.map(function (p) { return { x: p.date, y: p.avg }; }) });
        var d = GL.delta(pts);
        tables += '<div class="card"><div class="row"><h3 class="grow">' + esc(m.name) + '</h3><span class="delta ' + (d.diff > 0 ? 'up' : d.diff < 0 ? 'down' : '') + '">처음 ' + fmt(d.first.avg) + ' → 최근 ' + fmt(d.latest.avg) + ' (' + signed(d.diff) + ')</span></div>' +
          '<table><tr><th>날짜</th><th>세트</th><th>평균</th><th>최대</th></tr>' +
          pts.slice(-10).reverse().map(function (p) { return '<tr><td>' + esc(p.date.slice(2)) + '</td><td>' + p.count + '</td><td>' + fmt(p.avg) + '</td><td>' + fmt(p.max) + '</td></tr>'; }).join('') + '</table></div>';
      });
      html += '<div class="muted">' + exName(ex) + badge(ex) + '</div>';
      if (!series.length) return html + '<div class="empty">이 운동의 기록이 없어요.</div>';
      html += '<div class="card" id="chartbox">' + GLChart.line({ series: series, label: ex.name + ' 성장 그래프' }) + '<div class="legend">' +
        series.filter(function (s) { return !s.dash; }).map(function (s) { return '<span><i style="background:' + s.color + '"></i>' + esc(s.name.replace(' 평균', '')) + '</span>'; }).join('') +
        (g.max ? '<span class="muted">점선 = 최대</span>' : '') + '</div></div>' + tables;
    } else {
      html += '<div class="chips">' + GL.BODY_PARTS.map(function (b) { return '<button class="chip' + (g.bp === b ? ' on' : '') + '" data-act="gbp" data-bp="' + esc(b) + '">' + esc(b) + '</button>'; }).join('') + '</div>';
      html += '<div class="chips">' + [7, 30, 90, 'all'].map(function (r) { return '<button class="chip' + (g.range === r ? ' on' : '') + '" data-act="grange" data-r="' + r + '">' + (r === 'all' ? '전체' : r + '일') + '</button>'; }).join('') + '</div>';
      html += '<select id="gmem" aria-label="멤버">' + memOpts + '</select><div class="opts">' + wuOpt + '</div>';
      var rows = store.bodyPartSummary(g.bp, { memberIds: memberIdsFor(g.mem), since: rangeOf(g.range).since, until: rangeOf(g.range).until, includeWarmup: g.wu });
      html += rows.length ? rows.map(function (r) {
        return '<button class="hist card" style="width:100%" data-act="gopen" data-id="' + esc(r.exercise.id) + '"><span><b>' + exName(r.exercise) + '</b>' + badge(r.exercise) +
          '<br><span class="muted">' + r.sessions + '회 · 최근 평균 ' + fmt(r.latestAvg) + '</span></span><span class="delta ' + (r.change > 0 ? 'up' : r.change < 0 ? 'down' : '') + '">' + signed(r.change) + '</span></button>';
      }).join('') : '<div class="empty">이 부위의 기록이 없어요.</div>';
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
  function exerciseOptions(sel) { return GL.BODY_PARTS.map(function (b) { return '<option' + (b === sel ? ' selected' : '') + '>' + b + '</option>'; }).join(''); }

  function renderSheet() {
    var s = S.sheet;
    if (!s) { $sheet.hidden = true; $sheet.innerHTML = ''; return; }
    var h = '';
    if (s.type === 'picker') {
      var q = (s.q || '').trim().toLowerCase(), recent = store.recentExerciseIds(), all = store.exercises();
      all.sort(function (a, b) {
        var ia = recent.indexOf(a.id), ib = recent.indexOf(b.id);
        if (ia < 0 && ib < 0) return a.name < b.name ? -1 : 1;
        return ia < 0 ? 1 : ib < 0 ? -1 : ia - ib;
      });
      var list = all.filter(function (e) { return !q || e.name.toLowerCase().indexOf(q) >= 0 || e.body_part.indexOf(q) >= 0; });
      h = '<h2>운동 선택</h2><input id="pq" placeholder="검색" value="' + esc(s.q || '') + '" autocomplete="off"><div class="list">' +
        list.map(function (e) { return '<button class="item" data-act="pick" data-id="' + esc(e.id) + '"><span>' + esc(e.name) + '</span>' + badge(e) + '</button>'; }).join('') + '</div>' +
        '<h2>새 운동</h2><div class="row"><input id="nxn" placeholder="운동 이름" value="' + esc(q && !list.length ? s.q : '') + '"><select id="nxb" style="width:90px">' + exerciseOptions('기타') + '</select></div>' +
        '<div class="err" id="serr"></div><button class="primary" style="width:100%" data-act="newex">만들고 선택</button><button style="width:100%;margin-top:8px" data-act="close">닫기</button>';
    } else if (s.type === 'editset') {
      var st = store.t.sets.get(s.id), ex = store.exercise(st.exercise_id);
      h = '<h2>' + exName(ex) + badge(ex) + '</h2><div class="entry" style="grid-template-columns:56px 1fr 1fr"><button class="wu' + (st.is_warmup ? ' on' : '') + '" id="ewu" data-act="ewu">웜업</button>' +
        '<input id="ew" inputmode="decimal" value="' + esc(st.weight) + '"><input id="ew2" inputmode="decimal" value="' + esc(st.weight2 === null ? '' : st.weight2) + '">' +
        '<input class="note" id="en" value="' + esc(st.note) + '" placeholder="메모"></div><div class="err" id="serr"></div>' +
        '<div class="row" style="margin-top:8px"><button class="primary grow" data-act="saveset">저장</button><button class="danger grow" data-act="delset">삭제</button><button class="grow" data-act="close">닫기</button></div>';
    } else if (s.type === 'confirm') {
      h = '<h2>' + esc(s.title) + '</h2><p class="muted">' + esc(s.body) + '</p><div class="row"><button class="danger grow" data-act="confirmyes">삭제</button><button class="grow" data-act="close">취소</button></div>';
    } else if (s.type === 'gear') {
      h = '<h2>설정</h2><div class="list"><button class="item" data-act="gmembers">멤버 관리 ›</button><button class="item" data-act="gexercises">운동 관리 ›</button>' +
        '<button class="item" data-act="export">백업 내보내기 (JSON)</button>' + (remote ? '' : '<button class="item" data-act="import">백업 가져오기 ›</button>') + '<button class="item danger" data-act="logout">로그아웃</button></div>' +
        '<button style="width:100%;margin-top:8px" data-act="close">닫기</button>';
    } else if (s.type === 'members') {
      h = '<h2>멤버 관리</h2><div class="list">' + store.members(true).map(function (m) {
        // server mode: the account is tied to the name (login hash), so the name is read-only there
        var nameCell = remote ? '<span class="grow">' + esc(m.name) + '</span>' : '<input class="grow" data-rename="' + esc(m.id) + '" value="' + esc(m.name) + '"' + (m.archived ? ' disabled' : '') + '>';
        return '<div class="row" style="margin:6px 0">' + nameCell +
          (m.archived ? '<button data-act="marchive" data-id="' + esc(m.id) + '" data-f="0">복원</button>' : (remote ? '' : '<button data-act="mrename" data-id="' + esc(m.id) + '">저장</button>') + '<button class="danger" data-act="marchive" data-id="' + esc(m.id) + '" data-f="1">보관</button>') + '</div>';
      }).join('') + '</div>' + (remote ? '' : '<h2>멤버 추가</h2><div class="row"><input id="nmn" placeholder="이름"><button class="primary" data-act="madd">추가</button></div>') + '<div class="err" id="serr">' + esc(s.err || '') + '</div>' +
        '<div class="row" style="margin-top:8px"><button class="grow" data-act="gear">뒤로</button><button class="grow" data-act="close">닫기</button></div>';
    } else if (s.type === 'exercises') {
      h = '<h2>운동 관리</h2><div class="list">' + store.exercises(true).map(function (e) {
        return '<div class="row" style="margin:6px 0;flex-wrap:wrap"><input class="grow" data-exname="' + esc(e.id) + '" value="' + esc(e.name) + '"' + (e.archived ? ' disabled' : '') + '>' +
          '<select data-exbp="' + esc(e.id) + '" style="width:84px"' + (e.archived ? ' disabled' : '') + '>' + exerciseOptions(e.body_part) + '</select>' +
          (e.archived ? '<button data-act="earchive" data-id="' + esc(e.id) + '" data-f="0">복원</button>' : '<button data-act="esave" data-id="' + esc(e.id) + '">저장</button><button class="danger" data-act="earchive" data-id="' + esc(e.id) + '" data-f="1">보관</button>') + '</div>';
      }).join('') + '</div><h2>운동 추가</h2><div class="row"><input id="nxn" placeholder="운동 이름"><select id="nxb" style="width:90px">' + exerciseOptions('기타') + '</select></div>' +
        '<div class="err" id="serr">' + esc(s.err || '') + '</div><button class="primary" style="width:100%" data-act="eadd">추가</button><div class="row" style="margin-top:8px"><button class="grow" data-act="gear">뒤로</button><button class="grow" data-act="close">닫기</button></div>';
    } else if (s.type === 'import') {
      h = '<h2>백업 가져오기</h2><p class="muted">같은 항목은 덮어쓰고 나머지는 합칩니다. 형식이 틀리면 아무것도 바뀌지 않아요.</p>' +
        '<input type="file" id="ifile" accept="application/json,.json"><textarea id="itext" placeholder="또는 JSON 붙여넣기"></textarea><div class="err" id="serr">' + esc(s.err || '') + '</div>' +
        '<button class="primary" style="width:100%" data-act="doimport">가져오기</button><div class="row" style="margin-top:8px"><button class="grow" data-act="gear">뒤로</button><button class="grow" data-act="close">닫기</button></div>';
    }
    $sheet.innerHTML = '<div class="panel" role="dialog" aria-modal="true">' + h + '</div>';
    $sheet.hidden = false;
  }

  // ---------------- actions ----------------
  function setErr(id, msg) { var e = $(id); if (e) e.textContent = msg; }
  function guard(fn, errId) {
    try { return fn(); } catch (e) { setErr(errId || 'serr', humanError(e)); return undefined; }
  }
  function humanError(e) {
    var m = String(e && e.message || e);
    if (/duplicate/.test(m)) return '같은 이름이 이미 있어요.';
    if (/empty name/.test(m)) return '이름을 입력해 주세요.';
    if (/invalid set/.test(m)) return '무게는 0 이상의 숫자로 입력해 주세요.';
    if (/import rejected/.test(m)) return '가져오기 실패: ' + m.replace('import rejected: ', '') + ' (아무것도 바뀌지 않았어요)';
    return '오류: ' + m;
  }
  function addSets(exId, list) {
    var w = store.getOrCreateWorkout(S.view, S.date);
    list.forEach(function (f) { store.addSet(w.id, exId, f); });
    S.draft = S.draft.filter(function (id) { return id !== exId; });
  }
  function readEntry(exId) {
    return { weight: $('w-' + exId).value, weight2: $('w2-' + exId).value, note: $('n-' + exId).value, is_warmup: !!S.wu[exId] };
  }
  function undoToast(msg, token) { toast(msg, function () { store.undo(token); }); }

  var actions = {
    retry: function () { kick(); },
    retryrejected: function () { store.retryRejected().then(function () { render(); kick(); }); },
    tab: function (d) { S.tab = d.t; render(); },
    member: function (d) { S.view = d.id; S.draft = []; render(); },
    dprev: function () { S.date = GL.addDays(S.date, -1); S.draft = []; render(); },
    dnext: function () { S.date = GL.addDays(S.date, 1); S.draft = []; render(); },
    dtoday: function () { S.date = GL.todayStr(); S.draft = []; render(); },
    openday: function (d) { S.date = d.date; S.draft = []; render(); window.scrollTo(0, 0); },
    gear: function () { openSheet({ type: 'gear' }); },
    close: function () { closeSheet(); },
    addex: function () { openSheet({ type: 'picker', q: '' }); },
    pick: function (d) { if (S.draft.indexOf(d.id) < 0) S.draft.push(d.id); closeSheet(); S.focus = 'w-' + d.id; render(); },
    newex: function () {
      var made = guard(function () { return store.addExercise($('nxn').value, $('nxb').value); });
      if (!made) return;
      S.draft.push(made.id); closeSheet(); S.focus = 'w-' + made.id; changed();
    },
    wu: function (d) { S.wu[d.ex] = !S.wu[d.ex]; var b = document.querySelector('.wu[data-ex="' + d.ex + '"]'); b.classList.toggle('on', S.wu[d.ex]); b.setAttribute('aria-pressed', !!S.wu[d.ex]); },
    ewu: function () { $('ewu').classList.toggle('on'); },
    addset: function (d) {
      var f = readEntry(d.ex), v = GL.validateSetFields(f);
      if (!v.ok) { toast('무게를 0 이상의 숫자로 입력해 주세요'); $('w-' + d.ex).focus(); return; }
      addSets(d.ex, [f]); S.wu[d.ex] = false; // warm-up toggle applies to one set, then resets
      S.focus = 'w-' + d.ex; changed(d.ex);
    },
    same: function (d) {
      var w = store.workoutFor(S.view, S.date), sets = w ? store.setsForWorkout(w.id).filter(function (s) { return s.exercise_id === d.ex; }) : [];
      var last = sets[sets.length - 1]; if (!last) return;
      addSets(d.ex, [{ weight: last.weight, weight2: last.weight2, note: last.note, is_warmup: last.is_warmup }]); changed();
    },
    copylast: function (d) {
      var src = store.lastSession(S.view, d.ex, S.date); if (!src.length) return;
      addSets(d.ex, src.map(function (s) { return { weight: s.weight, weight2: s.weight2, note: s.note, is_warmup: s.is_warmup }; }));
      toast('지난 기록 ' + src.length + '세트를 복사했어요'); changed();
    },
    paste: function (d) {
      var r = GL.parseLines($('p-' + d.ex).value);
      if (r.errors.length || !r.ok.length) {
        setErr('perr-' + d.ex, r.ok.length || r.errors.length ? r.errors.map(function (e) { return e.line + '번째 줄을 읽을 수 없어요: ' + e.text; }).join(' / ') : '입력된 줄이 없어요.');
        return;
      }
      addSets(d.ex, r.ok); changed(d.ex);
    },
    editset: function (d) {
      var st = store.t.sets.get(d.id); // the values the form is opened with: only edits relative to these are saved
      openSheet({ type: 'editset', id: d.id, base: st ? { weight: String(st.weight), weight2: st.weight2 === null ? '' : String(st.weight2), note: st.note, is_warmup: !!st.is_warmup } : null });
    },
    saveset: function () {
      var s = S.sheet, ok = guard(function () {
        store.updateSet(s.id, { weight: $('ew').value, weight2: $('ew2').value, note: $('en').value, is_warmup: $('ewu').classList.contains('on') }, s.base); return true;
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
    eadd: function () { var ok = guard(function () { store.addExercise($('nxn').value, $('nxb').value); return true; }); if (ok) { openSheet({ type: 'exercises' }); changed(); } },
    esave: function (d) {
      var n = document.querySelector('[data-exname="' + d.id + '"]').value, b = document.querySelector('[data-exbp="' + d.id + '"]').value;
      var ok = guard(function () { store.updateExercise(d.id, { name: n, body_part: b }); return true; });
      if (ok) { openSheet({ type: 'exercises' }); changed(); }
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
    gbp: function (d) { S.g.bp = d.bp; render(); },
    grange: function (d) { S.g.range = d.r === 'all' ? 'all' : Number(d.r); render(); },
    gopen: function (d) { S.g.mode = 'ex'; S.g.exId = d.id; render(); window.scrollTo(0, 0); }
  };

  document.addEventListener('click', function (ev) {
    if (ev.target === $sheet) { closeSheet(); return; }
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
      auth.login($('lname').value, $('lpin').value).then(function (m) { S.view = m.id; S.loginErr = ''; render(); kick(); })
        .catch(function (e) { S.loginErr = loginErrorText(e); setErr('lerr', S.loginErr); if (btn) btn.disabled = false; });
    } else if (form === 'firstmember') {
      var ok = guard(function () { store.addMember($('fname').value); return true; }, 'lerr');
      if (ok) { kick(); render(); }
    }
  });
  document.addEventListener('input', function (ev) {
    if (ev.target.id === 'pq' && S.sheet) { S.sheet.q = ev.target.value; var pos = ev.target.selectionStart; renderSheet(); var n = $('pq'); n.focus(); n.setSelectionRange(pos, pos); }
  });
  document.addEventListener('change', function (ev) {
    var id = ev.target.id;
    if (id === 'datein') { if (ev.target.value) { S.date = ev.target.value; S.draft = []; render(); } }
    else if (id === 'gex') { S.g.exId = ev.target.value; render(); }
    else if (id === 'gmem') { S.g.mem = ev.target.value; render(); }
    else if (id === 'gwu') { S.g.wu = ev.target.checked; render(); }
    else if (id === 'gmax') { S.g.max = ev.target.checked; render(); }
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && S.sheet) closeSheet();
    if (ev.key === 'Enter' && ev.target.matches && ev.target.matches('.entry input')) {
      var card = ev.target.closest('.card'); // the edit sheet has no card: Enter there saves the edit
      var b = card && card.querySelector('[data-act="addset"]'); if (b) b.click();
      else if (S.sheet && S.sheet.type === 'editset') actions.saveset();
    }
  });

  window.__gl = { store: store, auth: auth, adapter: adapter, state: S, render: render }; // debugging / UI test hook

  // friends' new entries appear when the app is reopened / refocused (no realtime)
  var refreshing = false;
  function refreshNow() {
    if (!remote || refreshing || !auth.current()) return;
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
      render(); kick();
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
