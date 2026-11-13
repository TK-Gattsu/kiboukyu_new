// ============================================================
// 勤務管理アプリ（希望休申請＋勤務表＋勤務変更）- Google Apps Script バックエンド
// ============================================================
// 【はじめて使うとき】
// 1. script.google.com で新規プロジェクトを作成
// 2. このファイルの内容を「コード.gs」に貼り付け
// 3. 「＋」→「HTML」で「index」という名前のファイルを作り、index.html の内容を貼り付け
// 4. 上の関数選択で「初期設定」を選んで実行（初回は権限の許可を求められます）
//    → 実行ログに、システム管理者のIDと初期パスワードが表示されます
// 5. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
//    - 次のユーザーとして実行: 自分
//    - アクセスできるユーザー: 全員
// 6. 表示されたURLを開き、システム管理者でログインしてスタッフを登録する
//
// 【データの置き場所】
// 初期設定を実行したアカウントのGoogleドライブに「勤務管理データ」というスプレッドシートができます。
// スタッフにこのスプレッドシートを共有しないでください（アプリ経由でだけ読み書きします）。
//
// 【安全のしくみ】
// - パスワードはそのまま保存せず、ハッシュ（元に戻せない値）にして保存します
// - ログイン中かどうか・権限があるかは、すべてサーバー側（このファイル）で確認します
// - 名前の最後が「_」の関数は、画面側から呼び出せません
// ============================================================

const DB_PROP = 'KINMU_DB_ID';
const SESSION_SECONDS = 6 * 60 * 60;   // ログインの有効時間（操作するたびに延長）
const LOGIN_MAX_FAIL = 5;               // パスワードを続けて間違えられる回数
const LOGIN_LOCK_SECONDS = 15 * 60;     // 間違えすぎたときにログインできない時間
const HASH_ROUNDS = 500;
const ROLE_LABELS = { sysadmin: 'システム管理者', approver: '承認者' };

// シートの列（1行目が見出し）
const TABLES = {
  users: ['id', 'name', 'team', 'roles', 'salt', 'hash', 'active', 'mustChange', 'createdAt', 'updatedAt'],
  log:   ['at', 'userId', 'userName', 'action', 'detail'],
};

// ------------------------------------------------------------
// 画面の配信
// ------------------------------------------------------------
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('勤務管理アプリ')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ------------------------------------------------------------
// 初期設定（スクリプトエディタから1回だけ実行）
// ------------------------------------------------------------
function 初期設定() {
  const users = rows_('users');
  if (users.some(u => hasRole_(u, 'sysadmin'))) {
    Logger.log('システム管理者はすでに登録されています。パスワードを忘れた場合は「管理者パスワード再発行」を実行してください。');
    return;
  }
  const pw = tempPassword_();
  const salt = Utilities.getUuid();
  const now = new Date().toISOString();
  writeRow_('users', { id: 'admin', name: 'システム管理者', team: '', roles: 'sysadmin', salt: salt,
    hash: hash_(salt, pw), active: '1', mustChange: '1', createdAt: now, updatedAt: now });
  log_(null, '初期設定', 'システム管理者 admin を作成');
  Logger.log('システム管理者を作成しました。ID: admin ／ 初期パスワード: ' + pw + '（初回ログイン時に変更します）');
  return { id: 'admin', password: pw };
}

// システム管理者がパスワードを忘れたとき（スクリプトエディタから実行）
function 管理者パスワード再発行() {
  const admins = rows_('users').filter(u => hasRole_(u, 'sysadmin'));
  if (!admins.length) { Logger.log('システム管理者がいません。「初期設定」を実行してください。'); return; }
  const out = admins.map(u => {
    const pw = tempPassword_();
    u.salt = Utilities.getUuid(); u.hash = hash_(u.salt, pw); u.mustChange = '1'; u.active = '1';
    u.updatedAt = new Date().toISOString();
    writeRow_('users', u);
    log_(null, '管理者パスワード再発行', u.id);
    Logger.log('ID: ' + u.id + ' ／ 新しい仮パスワード: ' + pw);
    return { id: u.id, password: pw };
  });
  CacheService.getScriptCache().remove('fail_admin');
  return out;
}

// ------------------------------------------------------------
// ログイン・ログアウト
// ------------------------------------------------------------
function login(id, password) {
  try {
    id = String(id || '').trim();
    const cache = CacheService.getScriptCache();
    const failKey = 'fail_' + id;
    const fails = Number(cache.get(failKey) || 0);
    if (fails >= LOGIN_MAX_FAIL) throw new Error('パスワードを続けて間違えたため、15分ほどログインできません。');
    const u = findUser_(id);
    if (!u || u.active !== '1' || hash_(u.salt, String(password || '')) !== u.hash) {
      cache.put(failKey, String(fails + 1), LOGIN_LOCK_SECONDS);
      throw new Error('IDまたはパスワードが違います。');
    }
    cache.remove(failKey);
    const token = Utilities.getUuid() + Utilities.getUuid();
    cache.put('sess_' + token, u.id, SESSION_SECONDS);
    log_(u, 'ログイン', '');
    return { ok: true, data: { token: token, me: profile_(u) } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 画面からの操作はすべてここを通す（ログインと権限をサーバー側で確認）
function api(token, action, payload) {
  try {
    const def = ACTIONS[action];
    if (!def) throw new Error('不明な操作です: ' + action);
    const me = requireSession_(token);
    if (def.role && !hasRole_(me, def.role)) throw new Error('この操作をする権限がありません。');
    if (me.mustChange === '1' && !def.allowBeforeChange) throw new Error('先にパスワードを変更してください。');
    return { ok: true, data: def.run(me, payload || {}, token) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const ACTIONS = {
  me: { allowBeforeChange: true, run: me => profile_(me) },

  logout: { allowBeforeChange: true, run: (me, p, token) => {
    CacheService.getScriptCache().remove('sess_' + token);
    log_(me, 'ログアウト', '');
    return true;
  } },

  changePassword: { allowBeforeChange: true, run: (me, p) => {
    if (hash_(me.salt, String(p.current || '')) !== me.hash) throw new Error('今のパスワードが違います。');
    const next = String(p.next || '');
    checkPasswordRule_(next);
    if (next === String(p.current)) throw new Error('今と同じパスワードにはできません。');
    me.salt = Utilities.getUuid(); me.hash = hash_(me.salt, next); me.mustChange = '';
    me.updatedAt = new Date().toISOString();
    writeRow_('users', me);
    log_(me, 'パスワード変更', '');
    return profile_(me);
  } },

  // ---- システム管理者: スタッフ・権限 ----
  listUsers: { role: 'sysadmin', run: () => rows_('users').map(publicUser_) },

  saveUser: { role: 'sysadmin', run: (me, p) => {
    const id = String(p.id || '').trim();
    const name = String(p.name || '').trim();
    if (!id || !name) throw new Error('IDと名前を入れてください。');
    if (!isValidId_(id)) throw new Error('IDは半角の英数字（- と _ も可）で入れてください。');
    const roles = normalizeRoles_(p.roles);
    const now = new Date().toISOString();
    let u = findUser_(id);
    let password = null;
    if (p.isNew) {
      if (u) throw new Error('ID「' + id + '」はすでに使われています。');
      password = tempPassword_();
      const salt = Utilities.getUuid();
      u = { id: id, salt: salt, hash: hash_(salt, password), mustChange: '1', createdAt: now };
    } else if (!u) {
      throw new Error('ID「' + id + '」のスタッフが見つかりません。');
    }
    const before = u._row ? publicUser_(u) : null;
    u.name = name; u.team = String(p.team || '').trim(); u.roles = roles;
    u.active = p.active === false ? '' : '1'; u.updatedAt = now;
    guardLastAdmin_(u);
    writeRow_('users', u);
    log_(me, p.isNew ? 'スタッフ追加' : 'スタッフ変更', describeUserChange_(before, publicUser_(u)));
    return { user: publicUser_(u), password: password };
  } },

  bulkAddUsers: { role: 'sysadmin', run: (me, p) => {
    // 1行に「チーム名: 名前、名前、…」。IDは start から連番
    const lines = String(p.text || '').split('\n').map(s => s.trim()).filter(Boolean);
    let next = Number(p.start) || 1001;
    const exists = new Set(rows_('users').map(u => u.id));
    const names = new Set(rows_('users').map(u => u.name));
    const created = [], skipped = [];
    const now = new Date().toISOString();
    for (const line of lines) {
      const sep = line.search(/[:：]/);
      const team = sep >= 0 ? line.slice(0, sep).trim() : '';
      const body = sep >= 0 ? line.slice(sep + 1) : line;
      for (const raw of body.split(/[、,，\s]+/)) {
        const name = raw.trim();
        if (!name) continue;
        if (names.has(name)) { skipped.push(name); continue; }
        while (exists.has(String(next))) next++;
        const id = String(next++);
        const password = tempPassword_();
        const salt = Utilities.getUuid();
        writeRow_('users', { id: id, name: name, team: team, roles: '', salt: salt, hash: hash_(salt, password),
          active: '1', mustChange: '1', createdAt: now, updatedAt: now });
        exists.add(id); names.add(name);
        created.push({ id: id, name: name, team: team, password: password });
      }
    }
    log_(me, 'スタッフ一括追加', created.length + '人' + (skipped.length ? '（登録済みのため省略: ' + skipped.join('、') + '）' : ''));
    return { created: created, skipped: skipped };
  } },

  resetPassword: { role: 'sysadmin', run: (me, p) => {
    const u = findUser_(String(p.id || ''));
    if (!u) throw new Error('スタッフが見つかりません。');
    const password = tempPassword_();
    u.salt = Utilities.getUuid(); u.hash = hash_(u.salt, password); u.mustChange = '1';
    u.updatedAt = new Date().toISOString();
    writeRow_('users', u);
    CacheService.getScriptCache().remove('fail_' + u.id);
    log_(me, 'パスワード再発行', u.id + ' ' + u.name);
    return { id: u.id, name: u.name, password: password };
  } },

  listLog: { role: 'sysadmin', run: (me, p) => {
    const all = rows_('log');
    const n = Math.min(Number(p.limit) || 300, 2000);
    return all.slice(-n).reverse().map(r => ({ at: r.at, userId: r.userId, userName: r.userName, action: r.action, detail: r.detail }));
  } },
};

// ------------------------------------------------------------
// 内部の処理（画面からは呼べない）
// ------------------------------------------------------------
function requireSession_(token) {
  if (!token) throw new Error('ログインしてください。');
  const cache = CacheService.getScriptCache();
  const id = cache.get('sess_' + token);
  if (!id) throw new Error('ログインの有効時間が切れました。もう一度ログインしてください。');
  const u = findUser_(id);
  if (!u || u.active !== '1') { cache.remove('sess_' + token); throw new Error('このIDは使えません。'); }
  cache.put('sess_' + token, id, SESSION_SECONDS);   // 操作するたびに延長
  return u;
}

function hasRole_(u, role) {
  return String(u.roles || '').split(',').indexOf(role) >= 0;
}
function normalizeRoles_(roles) {
  const list = Array.isArray(roles) ? roles : String(roles || '').split(',');
  return list.map(r => String(r).trim()).filter(r => ROLE_LABELS[r]).join(',');
}
function guardLastAdmin_(u) {
  // システム管理者が1人もいなくなる変更は不可
  const others = rows_('users').filter(x => x.id !== u.id && x.active === '1' && hasRole_(x, 'sysadmin'));
  const stillAdmin = u.active === '1' && hasRole_(u, 'sysadmin');
  if (!others.length && !stillAdmin) throw new Error('システム管理者が1人もいなくなるため、この変更はできません。');
}
function isValidId_(id) {
  return /^[A-Za-z0-9_-]{1,32}$/.test(id);
}
function checkPasswordRule_(pw) {
  if (pw.length < 8) throw new Error('パスワードは8文字以上にしてください。');
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) throw new Error('パスワードは英字と数字を両方含めてください。');
}
function tempPassword_() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const hex = Utilities.getUuid().replace(/-/g, '');
  let out = '';
  for (let i = 0; i < 8; i++) out += chars[parseInt(hex.substr(i * 2, 2), 16) % chars.length];
  if (!/[0-9]/.test(out)) out = out.slice(0, 7) + '7';
  if (!/[a-z]/.test(out)) out = 'k' + out.slice(1);
  return out;
}
function hash_(salt, pw) {
  let h = salt + ':' + pw;
  for (let i = 0; i < HASH_ROUNDS; i++) {
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8);
    h = bytes.map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
  }
  return h;
}
function profile_(u) {
  return { id: u.id, name: u.name, team: u.team, roles: String(u.roles || '').split(',').filter(Boolean),
           mustChange: u.mustChange === '1' };
}
function publicUser_(u) {
  return { id: u.id, name: u.name, team: u.team, roles: String(u.roles || '').split(',').filter(Boolean),
           active: u.active === '1', mustChange: u.mustChange === '1', updatedAt: u.updatedAt };
}
function describeUserChange_(before, after) {
  const roleText = r => r.length ? r.map(x => ROLE_LABELS[x]).join('・') : '一般';
  if (!before) return after.id + ' ' + after.name + '（' + (after.team || 'チームなし') + '・' + roleText(after.roles) + '）';
  const diffs = [];
  if (before.name !== after.name) diffs.push('名前 ' + before.name + '→' + after.name);
  if (before.team !== after.team) diffs.push('チーム ' + (before.team || 'なし') + '→' + (after.team || 'なし'));
  if (roleText(before.roles) !== roleText(after.roles)) diffs.push('権限 ' + roleText(before.roles) + '→' + roleText(after.roles));
  if (before.active !== after.active) diffs.push(after.active ? '有効にした' : '無効にした');
  return after.id + ' ' + after.name + (diffs.length ? '：' + diffs.join('、') : '（変更なし）');
}

// ---- 操作記録 ----
function log_(u, action, detail) {
  writeRow_('log', { at: new Date().toISOString(), userId: u ? u.id : '', userName: u ? u.name : '（システム）',
    action: action, detail: detail || '' });
}

// ---- スプレッドシート（表）の読み書き ----
function db_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(DB_PROP);
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (e) { /* 削除された場合は作り直す */ }
  }
  const ss = SpreadsheetApp.create('勤務管理データ');
  props.setProperty(DB_PROP, ss.getId());
  return ss;
}
function sheet_(name) {
  const ss = db_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, TABLES[name].length).setValues([TABLES[name]]);
  }
  return sh;
}
function rows_(name) {
  const vals = sheet_(name).getDataRange().getValues();
  const head = TABLES[name];
  const out = [];
  for (let i = 1; i < vals.length; i++) {
    if (!vals[i].some(v => v !== '')) continue;
    const o = { _row: i + 1 };
    head.forEach((k, j) => { o[k] = vals[i][j] === undefined || vals[i][j] === null ? '' : String(vals[i][j]); });
    out.push(o);
  }
  return out;
}
function writeRow_(name, obj) {
  const sh = sheet_(name);
  const head = TABLES[name];
  const vals = [head.map(k => obj[k] === undefined || obj[k] === null ? '' : String(obj[k]))];
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // 書式を文字列にしてから書く（IDの先頭の0や日時が、数値・日付に変換されないように）
    const row = obj._row || sh.getLastRow() + 1;
    sh.getRange(row, 1, 1, head.length).setNumberFormat('@').setValues(vals);
    obj._row = row;
  } finally {
    lock.releaseLock();
  }
}
function findUser_(id) {
  id = String(id || '');
  return rows_('users').find(u => u.id === id) || null;
}
