/* 韓国旅行 2026 — 予約情報ビューア */
'use strict';

const LS = {
  unlocked: 'kt.unlocked',
  cfg:      'kt.cfg',
  token:    'kt.token',
  cache:    'kt.extrasCache',
  pending:  'kt.pending',
  lastDate: 'kt.lastDate',
  openCards:'kt.openCards',
};

const WD = ['日', '月', '火', '水', '木', '金', '土'];

/** trip.json の events[].type ごとの見た目 */
const EVENT_TYPES = {
  luggage: { icon: '🧳', label: '荷物配送', color: 'amber' },
  train:   { icon: '🚄', label: '鉄道',     color: 'blue'  },
  move:    { icon: '🚌', label: '移動',     color: 'blue'  },
  plan:    { icon: '📋', label: '予定',     color: 'green' },
  note:    { icon: '📝', label: 'メモ',     color: 'gray'  },
};

let TRIP = null;          // trip.json
let EXTRAS = [];          // 共有の追加予定（マージ後）
let EXTRAS_SHA = null;    // GitHub 上のファイル sha
let selDate = null;       // 'YYYY-MM-DD'
let editingId = null;
let SW_REG = null;      // サービスワーカーの登録（更新確認に使う）

/* ============ ユーティリティ ============ */

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/** 安全にエスケープしたうえで **強調** だけ有効化 */
function rich(s) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function todayStr() { return ymd(new Date()); }
function dateRange(a, b) {
  const out = [];
  for (let d = parseYmd(a); ymd(d) <= b; d.setDate(d.getDate() + 1)) out.push(ymd(d));
  return out;
}
/** '2026-08-23' → '8/23(日)' */
function shortDate(str) {
  const d = parseYmd(str);
  return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
}
function fmtDateLong(s) {
  const d = parseYmd(s);
  return `${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）`;
}
function toMin(t) {
  const m = /(\d{1,2}):(\d{2})/.exec(t || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : 9999;
}
function leadTime(t) {
  const m = /(\d{1,2}:\d{2})/.exec(t || '');
  return m ? m[1] : '';
}
/** 「06:00〜11:00」「12:00まで」→ 最後の時刻（＝締切）を返す */
function lastTime(t) {
  const m = String(t || '').match(/\d{1,2}:\d{2}/g);
  return m ? m[m.length - 1] : '';
}
function toast(msg, ms = 2400) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}
async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function lsGet(k, fb) {
  try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); }
  catch { return fb; }
}
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

/* ============ 地図・電話リンク ============ */

function mapQueryOf(o) {
  if (o.mapQuery) return o.mapQuery;
  if (o.lat != null && o.lng != null) return `${o.lat},${o.lng}`;
  return [o.title || o.name, o.place || o.address].filter(Boolean).join(' ');
}
function gmapUrl(o) {
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(mapQueryOf(o));
}
function gdirUrl(o) {
  return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(mapQueryOf(o));
}
function naverUrl(o) {
  if (o.naverUrl) return o.naverUrl;   // 共有された店舗ページの直リンク
  const q = o.mapQuery || o.nameLocal || o.name || o.title || o.place || '';
  return 'https://map.naver.com/p/search/' + encodeURIComponent(q);
}
function telUrl(t) { return 'tel:' + String(t).replace(/[^\d+]/g, ''); }
function bookingMyUrl(s) {
  return `https://secure.booking.com/mybooking.html?bn=${s.bookingNo.replace(/\D/g, '')}&pincode=${s.pin}&lang=ja`;
}
function docById(id) { return (TRIP.documents || []).find(d => d.id === id); }

/* ============ ロック画面 ============ */

let buf = '';
function renderDots() {
  $$('#dots i').forEach((el, i) => el.classList.toggle('on', i < buf.length));
}
async function tryUnlock() {
  const hash = await sha256hex(buf);
  if (hash === TRIP.meta.passcodeSha256) {
    lsSet(LS.unlocked, true);
    showApp();
  } else {
    $('#lockErr').textContent = 'パスコードが違います';
    $('#lock .lock-inner').classList.add('shake');
    setTimeout(() => $('#lock .lock-inner').classList.remove('shake'), 320);
    buf = ''; renderDots();
  }
}
function initLock() {
  $('#keypad').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const k = b.dataset.k;
    if (k === 'del') buf = buf.slice(0, -1);
    else if (buf.length < 4) buf += k;
    $('#lockErr').textContent = ' ';
    renderDots();
    if (buf.length === 4) setTimeout(tryUnlock, 120);
  });
}
function showApp() {
  $('#lock').hidden = true;
  $('#app').hidden = false;
  render();
}

/* ============ データ読み込み ============ */

async function loadTrip() {
  const r = await fetch('data/trip.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error('trip.json を読み込めません');
  TRIP = await r.json();
}

/* --- 同期設定 --- */
function autoRepo() {
  const m = /^([\w-]+)\.github\.io$/i.exec(location.hostname);
  if (!m) return null;
  const owner = m[1];
  const seg = location.pathname.split('/').filter(Boolean);
  const isProject = seg.length > 0 && !/\.\w+$/.test(seg[0]);
  const repo = isProject ? seg[0] : `${owner}.github.io`;
  return { owner, repo };
}
function dataPathFor(rel) {
  let dir = location.pathname.replace(/[^/]*$/, '');   // 末尾のファイル名を除いたディレクトリ
  let seg = dir.split('/').filter(Boolean);
  if (autoRepo() && seg.length && seg[0] === autoRepo().repo) seg.shift();
  return (seg.length ? seg.join('/') + '/' : '') + rel;
}
function getCfg() {
  const auto = autoRepo();
  const saved = lsGet(LS.cfg, {});
  return {
    owner:  saved.owner  || (auto ? auto.owner : ''),
    repo:   saved.repo   || (auto ? auto.repo  : ''),
    branch: saved.branch || 'main',
    path:   saved.path   || dataPathFor('data/extras.json'),
  };
}
function getToken() { return lsGet(LS.token, '') || ''; }

/* --- GitHub API --- */
async function ghFetch(method, body) {
  const c = getCfg();
  if (!c.owner || !c.repo) throw new Error('GitHub のユーザー名／リポジトリ名が未設定です');
  const url = `https://api.github.com/repos/${c.owner}/${c.repo}/contents/${c.path}`;
  const headers = { 'Accept': 'application/vnd.github+json' };
  const tk = getToken();
  if (tk) headers['Authorization'] = 'Bearer ' + tk;
  const opts = { method, headers, cache: 'no-store' };
  if (body) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const u = method === 'GET' ? `${url}?ref=${encodeURIComponent(c.branch)}&_=${Date.now()}` : url;
  const res = await fetch(u, opts);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    const e = new Error(`GitHub ${res.status}: ${txt.slice(0, 160)}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

/** 追加予定を取得。GitHub API → 静的ファイル → ローカルキャッシュ の順にフォールバック */
async function fetchExtras() {
  try {
    const j = await ghFetch('GET');
    EXTRAS_SHA = j.sha;
    const data = JSON.parse(b64decode(j.content));
    lsSet(LS.cache, data);
    return { data, source: 'github' };
  } catch (e) {
    console.warn('GitHub 取得失敗:', e.message);
  }
  try {
    const r = await fetch('data/extras.json?_=' + Date.now(), { cache: 'no-cache' });
    if (r.ok) {
      const data = await r.json();
      lsSet(LS.cache, data);
      return { data, source: 'static' };
    }
  } catch (e) { /* オフライン */ }
  return { data: lsGet(LS.cache, { events: [] }), source: 'cache' };
}

/* --- 保留中の変更（未同期） --- */
function getPending() { return lsGet(LS.pending, []); }
function setPending(p) { lsSet(LS.pending, p); }
function queueOp(op) {
  const p = getPending();
  // 同じ ID の古い操作は捨てて最新だけ残す
  const id = op.event ? op.event.id : op.id;
  setPending(p.filter(o => (o.event ? o.event.id : o.id) !== id).concat(op));
}
function applyOps(events, ops) {
  let out = events.slice();
  for (const op of ops) {
    if (op.op === 'delete') out = out.filter(e => e.id !== op.id);
    else {
      const i = out.findIndex(e => e.id === op.event.id);
      if (i >= 0) out[i] = op.event; else out.push(op.event);
    }
  }
  return out;
}

async function refreshExtras() {
  const { data, source } = await fetchExtras();
  EXTRAS = applyOps(data.events || [], getPending());
  return source;
}

/** 保留中の変更を GitHub に書き込む */
async function pushPending() {
  const pending = getPending();
  if (!pending.length) return { ok: true, skipped: true };
  if (!getToken()) return { ok: false, reason: 'トークン未設定' };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const cur = await ghFetch('GET');
      const data = JSON.parse(b64decode(cur.content));
      data.events = applyOps(data.events || [], pending);
      data.version = (data.version || 1) + 1;
      data.updatedAt = new Date().toISOString();
      const c = getCfg();
      const res = await ghFetch('PUT', {
        message: `予定を更新（${pending.length}件）`,
        content: b64encode(JSON.stringify(data, null, 2) + '\n'),
        sha: cur.sha,
        branch: c.branch,
      });
      EXTRAS_SHA = res.content.sha;
      setPending([]);
      lsSet(LS.cache, data);
      EXTRAS = data.events;
      return { ok: true };
    } catch (e) {
      if (e.status === 409 && attempt === 0) continue;   // 競合したら読み直して再試行
      return { ok: false, reason: e.message };
    }
  }
  return { ok: false, reason: '書き込みに失敗しました' };
}

/* ============ 1日分の項目を組み立て ============ */

function itemsForDate(date) {
  const items = [];

  (TRIP.flights || []).forEach(f => {
    if (f.date === date) items.push({ sort: toMin(f.time), kind: 'flight', data: f });
  });

  (TRIP.stays || []).forEach(s => {
    const t = stayTimes(s);
    if (s.checkOutDate === date) {
      items.push({ sort: toMin(lastTime(t.outTime)) - 1, kind: 'checkout', data: s });
    }
    if (s.checkInDate === date) {
      items.push({ sort: toMin(t.inTime), kind: 'checkin', data: s });
    }
  });

  (TRIP.events || []).forEach(e => {
    // time が未定でも sortTime があれば正しい位置に並べる
    if (e.date === date) items.push({ sort: toMin(e.time || e.sortTime), kind: 'event', data: e });
  });

  (EXTRAS || []).forEach(e => {
    if (e.type === 'stayOverride') return;
    if (e.date === date) items.push({ sort: toMin(e.time), kind: 'extra', data: e });
  });

  items.sort((a, b) => a.sort - b.sort);
  return items;
}

/** 「すべて開く／すべて閉じる」ボタンの表示を、いま出ているカードに合わせる */
function syncFoldBtn(btnId, ids) {
  const btn = $('#' + btnId);
  if (!btn) return;
  const allOpen = ids.length > 0 && ids.every(isCardOpen);
  btn.dataset.open = allOpen ? '1' : '0';
  btn.textContent = allOpen ? 'すべて閉じる' : 'すべて開く';
  btn.hidden = ids.length === 0;
}
/** いま「行きたい」タブに描画されているカードのID（ジャンル絞り込み後） */
function visibleWishIds() {
  return $$('#wishList .card').map(c => c.dataset.card);
}
function refreshFoldBtns() {
  syncFoldBtn('btnFoldAll', itemsForDate(selDate).map(cardIdOf));
  syncFoldBtn('btnFoldWish', visibleWishIds());
}

/** タイムライン項目 → 折りたたみカードのID */
function cardIdOf(it) {
  if (it.kind === 'checkin')  return `${it.data.id}-checkin`;
  if (it.kind === 'checkout') return `${it.data.id}-checkout`;
  return it.data.id;
}

/** その日の夜に泊まる宿（中日のみバー表示） */
function stayOfNight(date) {
  return (TRIP.stays || []).find(s => date > s.checkInDate && date < s.checkOutDate) || null;
}

/* ============ カード描画 ============ */

/* --- 折りたたみカード ---
   ヘッダー（時刻・アイコン・タイトル・バッジ行）だけを常に表示し、
   それ以外はタップで開閉する。開いているカードは端末に記憶する。 */
let openCards = new Set(lsGet(LS.openCards, []));
function isCardOpen(id) { return openCards.has(id); }
function setCardOpen(id, open) {
  if (open) openCards.add(id); else openCards.delete(id);
  lsSet(LS.openCards, Array.from(openCards));
}
/** head だけ常時表示、rest は開いたときだけ表示するカードを組み立てる */
function foldCard(id, head, rest) {
  const open = isCardOpen(id);
  const hasRest = rest.trim().length > 0;
  return `<div class="card ${open ? 'open' : ''}" data-card="${esc(id)}">
    <button type="button" class="card-head" data-cardtoggle="${esc(id)}"
            aria-expanded="${open}"${hasRest ? '' : ' disabled'}>
      ${head}
      ${hasRest ? '<span class="card-chev" aria-hidden="true">⌄</span>' : ''}
    </button>
    ${hasRest ? `<div class="card-rest"${open ? '' : ' hidden'}>${rest}</div>` : ''}
  </div>`;
}

function actionsHtml(list) {
  if (!list.length) return '';
  return `<div class="actions">${list.join('')}</div>`;
}
function linkBtn(url, label, cls = '') {
  return `<a class="abtn ${cls}" href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>`;
}
function kv(k, v, mono) {
  if (!v) return '';
  return `<div class="kv"><div class="k">${esc(k)}</div><div class="v ${mono ? 'mono' : ''}">${rich(v)}</div></div>`;
}
function notesHtml(arr) {
  if (!arr || !arr.length) return '';
  return `<ul class="notes">${arr.map(n => `<li>${rich(n)}</li>`).join('')}</ul>`;
}

function flightCard(f) {
  const A = TRIP.airports, from = A[f.from], to = A[f.to];
  const acts = [];
  from.links.forEach((l, i) => acts.push(linkBtn(l.url, `${from.short}：${l.label}`, i === 0 ? 'primary' : '')));
  acts.push(linkBtn(gmapUrl(from), `${from.short} の場所（地図）`));
  if (f.checkinUrl) acts.push(linkBtn(f.checkinUrl, '航空会社サイト（チェックイン）'));
  const d = docById(f.docId);
  if (d) acts.push(linkBtn(d.file, 'eチケットを開く'));
  to.links.forEach(l => acts.push(linkBtn(l.url, `${to.short}：${l.label}`, 'ghost')));

  const head = `
      <div class="card-time"><div class="t">${esc(f.time)}</div><div class="tn">発</div></div>
      <div class="card-icon">✈️</div>
      <div class="card-main">
        <div class="card-title">${esc(f.title)}</div>
        <div class="card-sub"><span class="badge blue">フライト</span>${esc(from.name)} → ${esc(to.name)}</div>
      </div>`;
  const rest = `
    <div class="card-body">
      ${kv('出発', `${f.time}　${from.name}`)}
      ${kv('到着', `${f.arriveTime}　${to.name}`)}
      ${kv('航空会社', f.airline)}
      ${kv('便名', f.flightNo, true)}
      ${kv('予約参照', f.bookingRef, true)}
      ${kv('eチケット', f.eticket, true)}
      ${kv('座席クラス', f.seatClass)}
      ${notesHtml(f.guide)}
    </div>
    ${actionsHtml(acts)}
    <button class="disclose" type="button" aria-expanded="false" data-toggle="bag-${f.id}">手荷物ルール</button>
    <div class="card-body" id="bag-${f.id}" hidden>${notesHtml(f.baggage)}</div>`;
  return foldCard(f.id, head, rest);
}

function stayCard(s, mode) {
  const isIn = mode === 'checkin';
  const T = stayTimes(s);
  const acts = [
    linkBtn(gmapUrl(s), 'Googleマップで開く', 'primary'),
    linkBtn(gdirUrl(s), 'ここへの経路'),
    linkBtn(naverUrl(s), 'NAVERマップ', 'ghost'),
  ];
  if (s.tel) acts.push(`<a class="abtn" href="${telUrl(s.tel)}">電話する</a>`);
  if (s.bookingNo && s.pin) acts.push(linkBtn(bookingMyUrl(s), '予約内容を見る'));
  if (s.propertyUrl) acts.push(linkBtn(s.propertyUrl, '施設ページ', 'ghost'));
  const d = docById(s.docId);
  if (d) acts.push(linkBtn(d.file, '予約確認書 PDF', 'ghost'));
  acts.push(`<button class="abtn" type="button" data-staytime="${esc(s.id)}">🕒 時間を変更</button>`);

  const head = `
      <div class="card-time"><div class="t">${esc(isIn ? leadTime(T.inTime) : lastTime(T.outTime))}</div><div class="tn">${isIn ? 'IN' : 'OUTまで'}</div></div>
      <div class="card-icon">🏨</div>
      <div class="card-main">
        <div class="card-title">${esc(s.name)}</div>
        <div class="card-sub"><span class="badge ${isIn ? 'green' : 'amber'}">${isIn ? 'チェックイン' : 'チェックアウト'}</span>${T.changed ? '<span class="badge blue">時間変更済み</span>' : ''}${esc(s.nameLocal)}</div>
      </div>`;
  const rest = `
    <div class="card-body">
      ${kv('住所', s.address)}
      ${kv('現地表記', s.addressLocal)}
      ${kv('電話', s.tel, true)}
      ${kv('チェックイン', `${s.checkInDate.slice(5).replace('-', '/')}　${T.inTime}`)}
      ${kv('チェックアウト', `${s.checkOutDate.slice(5).replace('-', '/')}　${T.outTime}`)}
      ${T.changed ? kv('元の時間', `IN ${s.checkInTime} ／ OUT ${s.checkOutTime}`) : ''}
      ${T.memo ? kv('変更メモ', T.memo) : ''}
      ${kv('部屋', s.roomType)}
      ${kv('人数', s.guests)}
      ${kv('予約番号', s.bookingNo, true)}
      ${kv('暗証番号', s.pin, true)}
      ${notesHtml(s.notes)}
    </div>
    ${actionsHtml(acts)}
    <button class="disclose" type="button" aria-expanded="false" data-toggle="fee-${s.id}-${mode}">料金・キャンセル規定</button>
    <div class="card-body" id="fee-${s.id}-${mode}" hidden>
      ${kv('料金', s.price)}
      ${kv('キャンセル', s.cancelPolicy)}
    </div>`;
  return foldCard(`${s.id}-${mode}`, head, rest);
}

function eventCard(e) {
  const acts = [];
  // 「A → B」のような移動メモには地図ボタンを出さない（検索が無意味になるため）
  if (e.mapQuery || e.lat != null) {
    acts.push(linkBtn(gmapUrl(e), 'Googleマップで開く', 'primary'));
    acts.push(linkBtn(gdirUrl(e), 'ここへの経路'));
  }
  (e.links || []).forEach(l => acts.push(linkBtn(l.url, l.label)));
  (e.docIds || []).forEach(id => { const d = docById(id); if (d) acts.push(linkBtn(d.file, d.title.replace(/^.*：/, ''), 'ghost')); });

  const meta = EVENT_TYPES[e.type] || EVENT_TYPES.note;
  const details = (e.details || []).map(d => kv(d.k, d.v, d.mono)).join('');

  const head = `
      <div class="card-time"><div class="t">${esc(leadTime(e.time) || '—')}</div>${e.timeNote ? `<div class="tn">${esc(e.timeNote)}</div>` : ''}</div>
      <div class="card-icon">${meta.icon}</div>
      <div class="card-main">
        <div class="card-title">${esc(e.title)}</div>
        <div class="card-sub"><span class="badge ${meta.color}">${meta.label}</span>${esc(e.place || '')}</div>
      </div>`;
  const rest = `
    ${details || e.notes ? `<div class="card-body">${details}${notesHtml(e.notes)}</div>` : ''}
    ${actionsHtml(acts)}`;
  return foldCard(e.id, head, rest);
}

function extraCard(e) {
  const acts = [
    linkBtn(gmapUrl(e), 'Googleマップで開く', 'primary'),
    linkBtn(gdirUrl(e), 'ここへの経路'),
    linkBtn(naverUrl(e), 'NAVERマップ', 'ghost'),
  ];
  if (e.url) acts.push(linkBtn(e.url, 'サイトを見る'));
  if (e.tel) acts.push(`<a class="abtn" href="${telUrl(e.tel)}">電話する</a>`);
  acts.push(`<button class="abtn ghost" type="button" data-edit="${esc(e.id)}">編集</button>`);

  const icon = e.type === 'spot' ? '📍' : e.type === 'note' ? '📝' : '🍽';
  const label = e.type === 'spot' ? 'スポット' : e.type === 'note' ? 'メモ' : 'お店';
  const unsynced = getPending().some(o => (o.event ? o.event.id : o.id) === e.id);

  const head = `
      <div class="card-time"><div class="t">${esc(leadTime(e.time))}</div></div>
      <div class="card-icon">${icon}</div>
      <div class="card-main">
        <div class="card-title">${esc(e.title)}</div>
        <div class="card-sub"><span class="badge green">${esc(e.genre || label)}</span>${unsynced ? '<span class="badge amber">未同期</span>' : ''}${esc(e.place || '')}</div>
      </div>`;
  const rest = `
    ${e.memo || e.tel ? `<div class="card-body">${kv('電話', e.tel, true)}${e.memo ? `<div class="kv"><div class="k">メモ</div><div class="v">${rich(e.memo)}</div></div>` : ''}</div>` : ''}
    ${actionsHtml(acts)}`;
  return foldCard(e.id, head, rest);
}

/* ============ 描画 ============ */

function renderDateStrip() {
  const days = dateRange(TRIP.meta.startDate, TRIP.meta.endDate);
  const t = todayStr();
  $('#datestrip').innerHTML = days.map(d => {
    const dt = parseYmd(d), w = dt.getDay();
    return `<button type="button" class="dchip ${d === selDate ? 'sel' : ''} ${d === t ? 'today' : ''} ${w === 0 ? 'sun' : w === 6 ? 'sat' : ''}" data-date="${d}">
      <div class="dw">${WD[w]}</div><div class="dd">${dt.getDate()}</div><div class="dm">${dt.getMonth() + 1}月</div>
    </button>`;
  }).join('');
  const sel = $('#datestrip .dchip.sel');
  if (sel) sel.scrollIntoView({ inline: 'center', block: 'nearest' });
}

function renderCalendar() {
  const start = parseYmd(TRIP.meta.startDate);
  const y = start.getFullYear(), m = start.getMonth();
  const first = new Date(y, m, 1), last = new Date(y, m + 1, 0);
  const t = todayStr();
  let cells = '';
  for (let i = 0; i < first.getDay(); i++) cells += '<div class="cal-cell"></div>';
  for (let d = 1; d <= last.getDate(); d++) {
    const key = ymd(new Date(y, m, d));
    const inTrip = key >= TRIP.meta.startDate && key <= TRIP.meta.endDate;
    const has = inTrip && itemsForDate(key).length > 0;
    cells += `<div class="cal-cell ${inTrip ? 'in' : ''} ${key === selDate ? 'sel' : ''} ${key === t ? 'today' : ''}" ${inTrip ? `data-date="${key}"` : ''}>
      <span>${d}</span>${has ? '<span class="cdot"></span>' : ''}</div>`;
  }
  $('#calendar').innerHTML = `
    <div class="cal-month">${y}年 ${m + 1}月</div>
    <div class="cal-grid">
      <div class="h u">日</div><div class="h">月</div><div class="h">火</div><div class="h">水</div>
      <div class="h">木</div><div class="h">金</div><div class="h s">土</div>
      ${cells}
    </div>`;
}

function renderDay() {
  const d = parseYmd(selDate);
  const days = dateRange(TRIP.meta.startDate, TRIP.meta.endDate);
  const n = days.indexOf(selDate) + 1;
  const isToday = selDate === todayStr();
  const items = itemsForDate(selDate);
  const ids = items.map(cardIdOf);
  const allOpen = ids.length > 0 && ids.every(isCardOpen);
  $('#dayhead').innerHTML = `
    <div class="dayhead-main">
      <div class="dh1">${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）</div>
      <div class="dh2">旅行${n}日目 / 全${days.length}日${isToday ? '　・　今日' : ''}</div>
    </div>
    ${ids.length ? `<button type="button" class="icon-btn" id="btnFoldAll" data-open="${allOpen ? '1' : '0'}">${allOpen ? 'すべて閉じる' : 'すべて開く'}</button>` : ''}`;

  const night = stayOfNight(selDate);
  let html = '';
  if (night) {
    html += `<div class="staybar"><span class="si">🏨</span>
      <span class="sn">${esc(night.name)}</span>
      <span class="sx">に宿泊中</span></div>`;
  }
  if (!items.length) {
    html += '<div class="empty">この日の確定予定はありません。<br>右下の ＋ からお店の予約などを追加できます。</div>';
  }
  for (const it of items) {
    if (it.kind === 'flight') html += flightCard(it.data);
    else if (it.kind === 'checkin') html += stayCard(it.data, 'checkin');
    else if (it.kind === 'checkout') html += stayCard(it.data, 'checkout');
    else if (it.kind === 'event') html += eventCard(it.data);
    else if (it.kind === 'extra') html += extraCard(it.data);
  }
  $('#timeline').innerHTML = html;
}

function renderAll() {
  const days = dateRange(TRIP.meta.startDate, TRIP.meta.endDate);
  $('#allList').innerHTML = days.map(date => {
    const dt = parseYmd(date);
    const items = itemsForDate(date);
    const night = stayOfNight(date);
    const rows = items.map(it => {
      const o = it.data;
      let icon = '📝', title = o.title || o.name, time = leadTime(o.time);
      if (it.kind === 'flight') { icon = '✈️'; }
      else if (it.kind === 'checkin') { icon = '🏨'; title = `${o.name} チェックイン`; time = leadTime(o.checkInTime); }
      else if (it.kind === 'checkout') { icon = '🏨'; title = `${o.name} チェックアウト`; time = lastTime(o.checkOutTime); }
      else if (it.kind === 'event') { icon = (EVENT_TYPES[o.type] || EVENT_TYPES.note).icon; }
      else if (it.kind === 'extra') { icon = o.type === 'spot' ? '📍' : o.type === 'note' ? '📝' : '🍽'; }
      return `<div class="allrow"><div class="rt">${esc(time)}</div><div class="ri">${icon}</div><div class="rx">${esc(title)}</div></div>`;
    }).join('');
    const nightRow = night
      ? `<div class="allrow"><div class="rt"></div><div class="ri">🌙</div><div class="rx muted">${esc(night.name)} に宿泊</div></div>`
      : '';
    return `<div class="allday">
      <div class="allday-h" data-date="${date}">
        <span class="d">${dt.getMonth() + 1}/${dt.getDate()}</span>
        <span class="w">（${WD[dt.getDay()]}）</span>
        <span class="n">${items.length ? items.length + '件' : '—'}</span>
      </div>
      <div class="allday-b">${nightRow}${rows || '<div class="allrow muted"><div class="rt"></div><div class="ri"></div><div class="rx">予定なし</div></div>'}</div>
    </div>`;
  }).join('');
}

/* ============ 行きたいお店（日付未定） ============ */

/** 選べるジャンル。増やしたいときはここに足すだけ */
const GENRES = ['焼肉', 'ホルモン', '韓国料理', '麺・粉食', 'パスタ・洋食', 'カフェ', 'スイーツ', 'コース料理', 'バー・酒', 'その他'];
const NO_GENRE = '未分類';
let wishGenre = '';   // '' = すべて

/** 「行きたい」に出すお店。日程が決まったものも残す（メモとホテル時間の上書きは除く） */
function wishExtras() {
  return (EXTRAS || []).filter(e => e.type !== 'note' && e.type !== 'stayOverride');
}

/* ---- ホテルのチェックイン／チェックアウト時間の上書き ----
   trip.json は固定なので、変更内容は extras.json に持たせて2台で共有する。 */
function stayOverrideOf(stayId) {
  return (EXTRAS || []).find(e => e.type === 'stayOverride' && e.stayId === stayId) || null;
}
/** 表示用の時間（上書きがあればそちら） */
function stayTimes(s) {
  const ov = stayOverrideOf(s.id);
  return {
    inTime:  (ov && ov.checkInTime)  || s.checkInTime,
    outTime: (ov && ov.checkOutTime) || s.checkOutTime,
    memo: ov ? (ov.memo || '') : '',
    changed: !!(ov && ((ov.checkInTime && ov.checkInTime !== s.checkInTime) ||
                       (ov.checkOutTime && ov.checkOutTime !== s.checkOutTime))),
  };
}
function genreOf(e) { return e.genre || NO_GENRE; }

function renderGenreChips() {
  const list = wishExtras();
  const counts = new Map();
  list.forEach(e => counts.set(genreOf(e), (counts.get(genreOf(e)) || 0) + 1));
  // 絞り込み中のジャンルが空になったら「すべて」に戻す
  if (wishGenre && !counts.has(wishGenre)) wishGenre = '';

  const order = GENRES.concat(NO_GENRE).filter(g => counts.has(g));
  const chip = (val, label, n) =>
    `<button type="button" class="chip ${wishGenre === val ? 'on' : ''}" data-genre="${esc(val)}">${esc(label)}<span class="n">${n}</span></button>`;
  $('#genreChips').innerHTML =
    chip('', 'すべて', list.length) + order.map(g => chip(g, g, counts.get(g))).join('');
}

function wishCard(e) {
  const acts = [
    linkBtn(gmapUrl(e), 'Googleマップで開く', 'primary'),
    linkBtn(gdirUrl(e), 'ここへの経路'),
    linkBtn(naverUrl(e), 'NAVERマップ', 'ghost'),
  ];
  if (e.url) acts.push(linkBtn(e.url, 'サイトを見る'));
  if (e.tel) acts.push(`<a class="abtn" href="${telUrl(e.tel)}">電話する</a>`);
  acts.push(`<button class="abtn" type="button" data-edit="${esc(e.id)}">日程を決める・編集</button>`);

  const unsynced = getPending().some(o => (o.event ? o.event.id : o.id) === e.id);
  const icon = e.type === 'spot' ? '📍' : e.type === 'note' ? '📝' : '🍽';
  const gb = `<span class="badge ${e.genre ? 'blue' : 'gray'}">${esc(genreOf(e))}</span>`;
  // 日程が決まっていれば、その日へ飛べるバッジを出す
  const db = e.date
    ? `<span class="badge green link" role="link" tabindex="0" data-goto="${esc(e.date)}">日程決定 ${esc(shortDate(e.date))}${e.time ? ' ' + esc(e.time) : ''} ›</span>`
    : '';

  const head = `
      <div class="card-icon" style="width:auto">${icon}</div>
      <div class="card-main">
        <div class="card-title">${esc(e.title)}</div>
        <div class="card-sub">${db}${gb}${unsynced ? '<span class="badge amber">未同期</span>' : ''}${esc(e.place || '')}</div>
      </div>`;
  const rest = `
    ${e.tel || e.memo ? `<div class="card-body">${kv('電話', e.tel, true)}${e.memo ? `<div class="kv"><div class="k">メモ</div><div class="v">${rich(e.memo)}</div></div>` : ''}</div>` : ''}
    ${actionsHtml(acts)}`;
  // 日程タブの同じお店とは別に開閉状態を持たせる
  return foldCard('wish:' + e.id, head, rest);
}

function renderWish() {
  renderGenreChips();
  const all = wishExtras();
  if (!all.length) {
    $('#wishList').innerHTML = '<div class="empty">まだ登録がありません。<br>右下の ＋ から、日付を空のままお店を追加できます。</div>';
    return;
  }
  const list = wishGenre ? all.filter(e => genreOf(e) === wishGenre) : all;

  // 日程が決まったものは先頭にまとめて、日付順に
  const dated = list.filter(e => e.date)
    .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  const undated = list.filter(e => !e.date);

  const sections = [];
  if (dated.length) {
    sections.push(`<div class="group-title">日程が決まっている（${dated.length}件）</div>` + dated.map(wishCard).join(''));
  }
  [['前半', '日程前半に行きたい'], ['後半', '日程後半に行きたい'], ['', '時期は未定']].forEach(([key, label]) => {
    const items = undated.filter(e => (e.when || '') === key);
    if (items.length) sections.push(`<div class="group-title">${esc(label)}（${items.length}件）</div>` + items.map(wishCard).join(''));
  });

  $('#wishList').innerHTML = sections.join('') || `<div class="empty">「${esc(wishGenre)}」のお店はまだありません。</div>`;
  syncFoldBtn('btnFoldWish', visibleWishIds());
}

function renderDocs() {
  $('#docList').innerHTML = (TRIP.documents || []).map(d => d.file ? `
    <a class="doc" href="${esc(d.file)}" target="_blank" rel="noopener">
      <span class="di">📄</span>
      <span><span class="dt">${esc(d.title)}</span><span class="dd">${esc(d.desc)}</span></span>
      <span class="dgo">›</span>
    </a>` : `
    <div class="doc note-doc">
      <span class="di">🔒</span>
      <span><span class="dt">${esc(d.title)}</span><span class="dd">${esc(d.desc)}</span></span>
    </div>`).join('');

  $('#travelerList').innerHTML = `<div class="card"><div class="card-body" style="padding-top:12px">
    ${(TRIP.travelers || []).map(t => kv(t.nameJa || t.name, [
      t.name,
      t.passport ? 'パスポート ' + t.passport : '',
      t.birth ? '生年月日 ' + t.birth : '',
      t.earrival ? '入国申告 ' + t.earrival : '',
      t.note || '',
    ].filter(Boolean).join('　/　'))).join('')}
  </div></div>`;

  $('#emergencyList').innerHTML = `<div class="card"><div class="card-body" style="padding-top:12px">
    ${(TRIP.emergency || []).map(e =>
      `<div class="kv wide"><div class="k">${esc(e.label)}</div><div class="v mono"><a href="${telUrl(e.tel)}">${esc(e.value)}</a></div></div>`
    ).join('')}
  </div></div>`;
}

function render() {
  if (!selDate) {
    const t = todayStr();
    const saved = lsGet(LS.lastDate, null);
    selDate = (t >= TRIP.meta.startDate && t <= TRIP.meta.endDate) ? t
            : (saved && saved >= TRIP.meta.startDate && saved <= TRIP.meta.endDate) ? saved
            : (t < TRIP.meta.startDate ? TRIP.meta.startDate : TRIP.meta.endDate);
  }
  $('#topTitle').textContent = TRIP.meta.title;
  $('#topSub').textContent = TRIP.meta.subtitle;
  renderDateStrip();
  if (!$('#calendar').hidden) renderCalendar();
  renderDay();
  renderAll();
  renderWish();
  renderDocs();
}

function setDate(d) {
  selDate = d;
  lsSet(LS.lastDate, d);
  renderDateStrip();
  if (!$('#calendar').hidden) renderCalendar();
  renderDay();
  switchView('plan');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

const VIEWS = ['plan', 'all', 'wish', 'docs', 'settings'];
function switchView(v) {
  VIEWS.forEach(k => { $('#view-' + k).hidden = (k !== v); });
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  $('#fab').hidden = (v === 'settings' || v === 'docs');
  currentView = v;
}
let currentView = 'plan';

/* ============ 予定シート ============ */

let sheetOrigin = 'plan';
function openSheet(id) {
  editingId = id || null;
  sheetOrigin = currentView;
  const e = id ? EXTRAS.find(x => x.id === id) : null;
  // 「行きたい」タブから ＋ を押したときは、日付なしで開く
  const blankDate = !e && currentView === 'wish';
  $('#sheetTitle').textContent = e ? (e.date ? '予定を編集' : '日程を決める・編集') : '予定を追加';
  $('#fType').value    = e ? (e.type || 'food') : 'food';
  $('#fTitle').value   = e ? (e.title || '') : '';
  $('#fGenre').value   = e ? (e.genre || '') : (wishGenre || '');
  $('#fDate').value    = e ? (e.date || '') : (blankDate ? '' : selDate);
  $('#fTime').value    = e ? (e.time || '') : '';
  $('#fWhen').value    = e ? (e.when || '') : '';
  $('#fPlace').value   = e ? (e.place || '') : '';
  $('#fMapQuery').value= e ? (e.mapQuery || '') : '';
  $('#fUrl').value     = e ? (e.url || '') : '';
  $('#fTel').value     = e ? (e.tel || '') : '';
  $('#fMemo').value    = e ? (e.memo || '') : '';
  $('#fDelete').hidden = !e;
  syncWhenField();
  $('#sheetBack').hidden = false;
  document.body.style.overflow = 'hidden';
  fitSheetToViewport();
}

/** 日付が入っているときは「時期の目安」を隠す */
function syncWhenField() {
  const hasDate = !!$('#fDate').value;
  $('#dateHint').textContent = hasDate
    ? '日程タブに表示されます。「行きたい」タブにも「日程決定」として残ります。'
    : '日付が空のあいだは「行きたい」タブにだけ表示されます。';
}
function closeSheet() {
  $('#sheetBack').hidden = true;
  editingId = null;
  document.body.style.removeProperty('overflow');
}

/* iOS Safari はキーボードが出ても画面の高さが変わらず、position:fixed の
   要素が画面外へずれることがある。visualViewport に追従させて、
   シートの見出し（キャンセル／保存）が必ず見える位置に留める。 */
function fitSheetToViewport() {
  const back = $('#sheetBack');
  if (!back || back.hidden) return;
  const vv = window.visualViewport;
  if (!vv) return;
  back.style.height = vv.height + 'px';
  back.style.top = (vv.offsetTop || 0) + 'px';
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', fitSheetToViewport);
  window.visualViewport.addEventListener('scroll', fitSheetToViewport);
}

async function saveSheet() {
  const title = $('#fTitle').value.trim();
  const date  = $('#fDate').value;
  if (!title) {
    toast('店名・タイトルを入力してください');
    $('#fTitle').focus();
    return;
  }

  const ev = {
    id: editingId || ('extra-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)),
    type: $('#fType').value,
    genre: $('#fGenre').value,
    date,
    when: $('#fWhen').value,
    time: date ? ($('#fTime').value || '') : '',
    title,
    place: $('#fPlace').value.trim(),
    mapQuery: $('#fMapQuery').value.trim(),
    url: $('#fUrl').value.trim(),
    tel: $('#fTel').value.trim(),
    memo: $('#fMemo').value.trim(),
  };
  queueOp({ op: 'upsert', event: ev });
  EXTRAS = applyOps(EXTRAS.filter(x => x.id !== ev.id), [{ op: 'upsert', event: ev }]);
  closeSheet();
  if (sheetOrigin === 'wish') { renderWish(); switchView('wish'); }
  else if (date) setDate(date);
  else { renderWish(); switchView('wish'); window.scrollTo({ top: 0 }); }
  await syncAndRefresh(true);
}

async function deleteCurrent() {
  if (!editingId) return;
  if (!confirm('この予定を削除しますか？')) return;
  queueOp({ op: 'delete', id: editingId });
  EXTRAS = EXTRAS.filter(x => x.id !== editingId);
  closeSheet();
  renderDay(); renderAll(); renderWish();
  await syncAndRefresh(true);
}

/* ============ 書類ビューアー ============
   ホーム画面から起動していると iOS は target="_blank" を無視して
   同じウィンドウでPDFを開いてしまい、戻る手段が無くなる。
   そのためアプリ内のオーバーレイで開く。 */

function openViewer(url, title) {
  const body = $('#viewerBody');
  const isImg = /\.(png|jpe?g|gif|webp)$/i.test(url);
  body.innerHTML = isImg
    ? `<img src="${esc(url)}" alt="${esc(title)}">`
    : `<iframe src="${esc(url)}" title="${esc(title)}"></iframe>
       <div class="viewer-fallback">表示されないときは
         <a href="${esc(url)}" target="_blank" rel="noopener">こちらから開いてください</a>
       </div>`;
  $('#viewerTitle').textContent = title || '';
  $('#viewerExt').href = url;
  $('#viewer').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeViewer() {
  $('#viewer').hidden = true;
  $('#viewerBody').innerHTML = '';   // PDFの読み込みを止める
  document.body.style.removeProperty('overflow');
}

/* ============ ホテルの時間を変更するシート ============ */

let editingStayId = null;

function openStaySheet(stayId) {
  const st = (TRIP.stays || []).find(x => x.id === stayId);
  if (!st) return;
  editingStayId = stayId;
  const T = stayTimes(st);
  $('#stayHotel').textContent = `${st.name}（${st.checkInDate.slice(5).replace('-', '/')} 〜 ${st.checkOutDate.slice(5).replace('-', '/')}）`;
  $('#sIn').value = T.inTime;
  $('#sOut').value = T.outTime;
  $('#sMemo').value = T.memo;
  $('#sIn').placeholder = st.checkInTime;
  $('#sOut').placeholder = st.checkOutTime;
  $('#stayReset').hidden = !stayOverrideOf(stayId);
  $('#stayBack').hidden = false;
  document.body.style.overflow = 'hidden';
  fitStaySheet();
}

function closeStaySheet() {
  $('#stayBack').hidden = true;
  editingStayId = null;
  document.body.style.removeProperty('overflow');
}

function fitStaySheet() {
  const back = $('#stayBack');
  if (!back || back.hidden) return;
  const vv = window.visualViewport;
  if (!vv) return;
  back.style.height = vv.height + 'px';
  back.style.top = (vv.offsetTop || 0) + 'px';
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', fitStaySheet);
  window.visualViewport.addEventListener('scroll', fitStaySheet);
}

async function saveStaySheet() {
  if (!editingStayId) return;
  const st = (TRIP.stays || []).find(x => x.id === editingStayId);
  const inT = $('#sIn').value.trim();
  const outT = $('#sOut').value.trim();
  if (!inT || !outT) { toast('チェックイン／チェックアウトを入力してください'); return; }

  const ev = {
    id: 'stayov-' + editingStayId,
    type: 'stayOverride',
    stayId: editingStayId,
    date: '',
    checkInTime: inT,
    checkOutTime: outT,
    memo: $('#sMemo').value.trim(),
    title: `${st.name} の時間変更`,
  };
  queueOp({ op: 'upsert', event: ev });
  EXTRAS = applyOps(EXTRAS.filter(x => x.id !== ev.id), [{ op: 'upsert', event: ev }]);
  closeStaySheet();
  renderDay(); renderAll();
  toast('時間を変更しました');
  await syncAndRefresh(true);
}

async function resetStayTime() {
  if (!editingStayId) return;
  const id = 'stayov-' + editingStayId;
  queueOp({ op: 'delete', id });
  EXTRAS = EXTRAS.filter(x => x.id !== id);
  closeStaySheet();
  renderDay(); renderAll();
  toast('元の時間に戻しました');
  await syncAndRefresh(true);
}

/* ============ 同期 ============ */

async function syncAndRefresh(quiet) {
  const hasToken = !!getToken();
  const pend = getPending().length;

  if (pend && hasToken) {
    const r = await pushPending();
    if (r.ok) { toast('共有しました（相手の端末にも反映されます）'); }
    else { toast('この端末に保存しました（未同期：' + r.reason + '）', 3600); }
  } else if (pend && !hasToken) {
    if (!quiet) toast('この端末にのみ保存されています。設定でトークンを登録すると共有されます。', 3800);
  }

  const src = await refreshExtras();
  renderDay(); renderAll(); renderWish(); renderSyncStatus(src);
  return src;
}

function renderSyncStatus(src) {
  const el = $('#syncStatus');
  if (!el) return;
  const c = getCfg(), pend = getPending().length;
  const lines = [];
  lines.push(c.owner && c.repo ? `接続先：${c.owner}/${c.repo}（${c.branch}）` : '接続先：未設定');
  lines.push(`保存先ファイル：${c.path}`);
  lines.push(getToken() ? 'トークン：この端末に登録済み（書き込み可）' : 'トークン：未登録（読み取りのみ）');
  if (src) lines.push('最終取得：' + ({ github: 'GitHub（最新）', static: '公開ファイル（数十秒遅れる場合あり）', cache: 'この端末のキャッシュ（オフライン）' }[src] || src));
  if (pend) lines.push(`⚠️ 未同期の変更が ${pend} 件あります`);
  el.innerHTML = lines.map(esc).join('<br>');
  el.className = 'sync-status ' + (pend ? 'ng' : (getToken() ? 'ok' : ''));
}

/* ============ 起動 ============ */

function bind() {
  // 日付チップ / カレンダー
  $('#datestrip').addEventListener('click', e => {
    const b = e.target.closest('[data-date]'); if (b) setDate(b.dataset.date);
  });
  $('#calendar').addEventListener('click', e => {
    const b = e.target.closest('[data-date]'); if (b) setDate(b.dataset.date);
  });
  $('#allList').addEventListener('click', e => {
    const b = e.target.closest('[data-date]'); if (b) setDate(b.dataset.date);
  });
  $('#genreChips').addEventListener('click', e => {
    const b = e.target.closest('[data-genre]'); if (!b) return;
    wishGenre = b.dataset.genre;
    renderWish();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('#calToggle').addEventListener('click', () => {
    const c = $('#calendar'), open = c.hidden;
    c.hidden = !open;
    $('#calToggle').setAttribute('aria-expanded', String(open));
    $('#calToggleLabel').textContent = open ? '閉じる' : 'カレンダー';
    if (open) renderCalendar();
  });
  $('#btnToday').addEventListener('click', () => {
    const t = todayStr();
    setDate(t >= TRIP.meta.startDate && t <= TRIP.meta.endDate ? t : TRIP.meta.startDate);
  });

  // タブ
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    switchView(t.dataset.view);
    if (t.dataset.view === 'settings') renderSyncStatus();
    window.scrollTo({ top: 0 });
  }));

  // カード内の開閉 & 編集
  $('#dayhead').addEventListener('click', e => {
    const b = e.target.closest('#btnFoldAll'); if (!b) return;
    const open = b.dataset.open !== '1';
    itemsForDate(selDate).map(cardIdOf).forEach(id => setCardOpen(id, open));
    renderDay();
  });

  $('#btnFoldWish').addEventListener('click', () => {
    const btn = $('#btnFoldWish');
    const open = btn.dataset.open !== '1';
    visibleWishIds().forEach(id => setCardOpen(id, open));
    renderWish();
  });

  document.addEventListener('click', e => {
    // 同梱書類（PDF・画像）はアプリ内ビューアーで開く
    const docLink = e.target.closest('a[href^="docs/"]');
    if (docLink && $('#viewer').hidden) {
      e.preventDefault();
      const t = docLink.querySelector('.dt');   // 書類タブは表題だけ使う
      openViewer(docLink.getAttribute('href'),
                 (t ? t.textContent : docLink.innerText).trim() || '書類');
      return;
    }
    // 「日程決定」バッジはカード見出しの中にあるので、開閉より先に処理する
    const go = e.target.closest('[data-goto]');
    if (go) { e.preventDefault(); setDate(go.dataset.goto); switchView('plan'); return; }

    const ct = e.target.closest('[data-cardtoggle]');
    if (ct) {
      const id = ct.dataset.cardtoggle;
      const card = ct.closest('.card');
      const rest = card.querySelector('.card-rest');
      const open = !isCardOpen(id);
      setCardOpen(id, open);
      card.classList.toggle('open', open);
      ct.setAttribute('aria-expanded', String(open));
      if (rest) rest.hidden = !open;
      refreshFoldBtns();
      return;
    }
    const tg = e.target.closest('[data-toggle]');
    if (tg) {
      const box = document.getElementById(tg.dataset.toggle);
      const open = box.hidden;
      box.hidden = !open;
      tg.setAttribute('aria-expanded', String(open));
      return;
    }
    const stm = e.target.closest('[data-staytime]');
    if (stm) { openStaySheet(stm.dataset.staytime); return; }
    const ed = e.target.closest('[data-edit]');
    if (ed) { openSheet(ed.dataset.edit); return; }
  });

  // シート
  $('#fab').addEventListener('click', () => openSheet(null));
  $('#sheetCancel').addEventListener('click', closeSheet);
  $('#sheetSave').addEventListener('click', saveSheet);
  $('#sheetCancel2').addEventListener('click', closeSheet);
  $('#sheetSave2').addEventListener('click', saveSheet);
  $('#stayCancel').addEventListener('click', closeStaySheet);
  $('#stayCancel2').addEventListener('click', closeStaySheet);
  $('#staySave').addEventListener('click', saveStaySheet);
  $('#staySave2').addEventListener('click', saveStaySheet);
  $('#stayReset').addEventListener('click', resetStayTime);
  $('#stayBack').addEventListener('click', e => { if (e.target.id === 'stayBack') closeStaySheet(); });
  $('#viewerClose').addEventListener('click', closeViewer);
  // iOSでキーボードが出ても操作できなくならないよう、Escでも閉じられるように
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('#sheetBack').hidden) closeSheet();
    if (!$('#stayBack').hidden) closeStaySheet();
    if (!$('#viewer').hidden) closeViewer();
  });
  $('#fDelete').addEventListener('click', deleteCurrent);
  $('#fDate').addEventListener('change', syncWhenField);
  $('#fDate').addEventListener('input', syncWhenField);
  $('#sheetBack').addEventListener('click', e => { if (e.target.id === 'sheetBack') closeSheet(); });

  // ジャンルの選択肢
  $('#fGenre').innerHTML = `<option value="">${NO_GENRE}</option>` +
    GENRES.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('');

  // 設定
  const c = getCfg();
  $('#cfgOwner').value = c.owner;
  $('#cfgRepo').value = c.repo;
  $('#cfgToken').value = getToken();

  $('#btnSaveCfg').addEventListener('click', async () => {
    lsSet(LS.cfg, {
      owner: $('#cfgOwner').value.trim(),
      repo: $('#cfgRepo').value.trim(),
      branch: 'main',
      path: dataPathFor('data/extras.json'),
    });
    lsSet(LS.token, $('#cfgToken').value.trim());
    try {
      await ghFetch('GET');
      toast('接続できました');
    } catch (err) {
      toast('接続できません：' + err.message, 4000);
    }
    await syncAndRefresh(true);
    renderSyncStatus();
  });

  $('#btnSyncNow').addEventListener('click', async () => {
    toast('同期中…', 1200);
    const src = await syncAndRefresh(false);
    renderSyncStatus(src);
  });

  $('#btnExport').addEventListener('click', async () => {
    const txt = JSON.stringify({ events: EXTRAS }, null, 2);
    try { await navigator.clipboard.writeText(txt); toast('コピーしました'); }
    catch { prompt('コピーしてください', txt); }
  });

  $('#btnImport').addEventListener('click', async () => {
    const txt = prompt('コピーしたテキストを貼り付けてください');
    if (!txt) return;
    try {
      const d = JSON.parse(txt);
      (d.events || []).forEach(ev => { if (ev && ev.id) queueOp({ op: 'upsert', event: ev }); });
      await syncAndRefresh(false);
      toast('取り込みました');
    } catch { toast('形式が正しくありません'); }
  });

  $('#btnUpdate').addEventListener('click', async () => {
    toast('最新版を確認しています…', 2000);
    try {
      if (SW_REG) await SW_REG.update();
      const ks = await caches.keys();
      await Promise.all(ks.map(k => caches.delete(k)));   // 古い書類キャッシュも捨てる
    } catch {}
    location.reload();
  });

  $('#btnLock').addEventListener('click', () => {
    localStorage.removeItem(LS.unlocked);
    location.reload();
  });

  $('#btnReset').addEventListener('click', () => {
    if (!confirm('この端末に保存した設定・トークン・未同期の変更をすべて消します。よろしいですか？')) return;
    Object.values(LS).forEach(k => localStorage.removeItem(k));
    location.reload();
  });

  // 復帰時に自動同期
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || $('#app').hidden) return;
    syncAndRefresh(true);
    if (SW_REG) SW_REG.update().catch(() => {});   // 新しい版が出ていないか確認
  });
  window.addEventListener('online', () => syncAndRefresh(true));
}

(async function main() {
  try {
    await loadTrip();
  } catch (e) {
    document.body.innerHTML = '<p style="padding:40px;text-align:center">データを読み込めませんでした。<br>通信状況を確認して再読み込みしてください。</p>';
    return;
  }
  bind();
  initLock();

  if (lsGet(LS.unlocked, false)) showApp();
  else { $('#lock').hidden = false; renderDots(); }

  await refreshExtras();
  if (!$('#app').hidden) { renderDay(); renderAll(); renderWish(); }
  renderSyncStatus();
  $('#verInfo').textContent =
    `データ ${TRIP.meta.startDate} 〜 ${TRIP.meta.endDate} ／ 追加予定 ${EXTRAS.length}件`
    + (window.matchMedia('(display-mode: standalone)').matches ? ' ／ ホーム画面から起動中' : '');
  fetch('sw.js', { cache: 'no-store' }).then(r => r.text()).then(t => {
    const m = /const VERSION = '([^']+)'/.exec(t);
    if (m) $('#verInfo').textContent += ` ／ 版 ${m[1]}`;
  }).catch(() => {});

  /* ホーム画面から起動している場合、iOSはサスペンドから復帰しても
     ページを再読み込みしないため、古いコードが動き続けることがある。
     新しい版を検出したら自動で読み込み直す。 */
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;   // 初回インストール時は再読込しない
      reloading = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js').then(reg => {
      SW_REG = reg;
      reg.update().catch(() => {});
    }).catch(() => {});
  }
})();
