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
  users:    ['id', 'name', 'team', 'roles', 'salt', 'hash', 'active', 'mustChange', 'createdAt', 'updatedAt'],
  log:      ['at', 'userId', 'userName', 'action', 'detail'],
  docs:     ['key', 'part', 'text', 'updatedAt'],   // 勤務表の内容・設定（大きいので分割して保存）
  archives: ['key', 'part', 'text', 'updatedAt'],   // 過去の勤務表（読む回数が少ないので別シート）
  requests: ['id', 'name', 'userId', 'date', 'type', 'kind', 'fromDate', 'status', 'createdAt', 'updatedAt', 'by'],
  // 勤務変更（確定後の交代・振休の交換・自分の勤務の変更）。cells は [{name, date, before, after}] のJSON
  changes:  ['id', 'kind', 'requester', 'requesterId', 'partner', 'status', 'cells', 'summary', 'deviations', 'reason',
             'createdAt', 'updatedAt', 'partnerAt', 'partnerBy', 'approverAt', 'approverBy', 'rejectedBy', 'note', 'appliedAt',
             'revertOf', 'revertedBy'],
  // アプリ内のお知らせ（勤務変更の承認依頼・承認・却下・取り消しなど）。to は名前、link は開く画面
  notices:  ['id', 'to', 'at', 'text', 'link', 'changeId', 'read'],   // revertOf＝取り消す元の申請のID（承認後の取り消しの申請）／revertedBy＝取り消した申請のID
};

// ---- 勤務表のきまり（勤務表作成アプリと同じ）----
const DAY_CAP = 5;                                   // 平日の休みは1日5人まで
const COUNT_MARKS = ['特', '夏', '有', '業', '出'];   // ＋「振」を含むもの（×・研は数えない）
const ADMIN_ONLY_TYPES = ['業', '研', '出'];          // スタッフ本人は申請できない（システム管理者が入れる）
const HOLIDAYS = {
  '2025-01-01':'元日','2025-01-13':'成人の日','2025-02-11':'建国記念の日','2025-02-23':'天皇誕生日','2025-02-24':'振替休日',
  '2025-03-20':'春分の日','2025-04-29':'昭和の日','2025-05-03':'憲法記念日','2025-05-04':'みどりの日','2025-05-05':'こどもの日','2025-05-06':'振替休日',
  '2025-07-21':'海の日','2025-08-11':'山の日','2025-09-15':'敬老の日','2025-09-22':'振替休日','2025-09-23':'秋分の日',
  '2025-10-13':'スポーツの日','2025-11-03':'文化の日','2025-11-23':'勤労感謝の日','2025-11-24':'振替休日',
  '2026-01-01':'元日','2026-01-12':'成人の日','2026-02-11':'建国記念の日','2026-02-23':'天皇誕生日','2026-03-20':'春分の日','2026-04-29':'昭和の日',
  '2026-05-03':'憲法記念日','2026-05-04':'みどりの日','2026-05-05':'こどもの日','2026-05-06':'振替休日','2026-07-20':'海の日','2026-08-11':'山の日',
  '2026-09-21':'敬老の日','2026-09-22':'国民の休日','2026-09-23':'秋分の日','2026-10-12':'スポーツの日','2026-11-03':'文化の日','2026-11-23':'勤労感謝の日',
  '2027-01-01':'元日','2027-01-11':'成人の日','2027-02-11':'建国記念の日','2027-02-23':'天皇誕生日','2027-03-21':'春分の日','2027-03-22':'振替休日','2027-04-29':'昭和の日',
  '2027-05-03':'憲法記念日','2027-05-04':'みどりの日','2027-05-05':'こどもの日','2027-07-19':'海の日','2027-08-11':'山の日','2027-09-20':'敬老の日',
  '2027-09-23':'秋分の日','2027-10-11':'スポーツの日','2027-11-03':'文化の日','2027-11-23':'勤労感謝の日',
};

// ---- 作成の流れと申請の受付 ----
// flow: 'request_first'＝希望休を先に受け付ける／'duty_first'＝日直・夜勤・振休を先に決めてから受け付ける
// split: 当番が先の流れで、申請を「土日祝の×」と「平日の希望休」の2回に分けるか（あとから切り替え可）
const FLOW_LABELS = { request_first: '希望休が先（希望休 → 日直・夜勤 → 振休）', duty_first: '当番が先（日直・夜勤 → 振休 → 希望休）' };
// 受付の状態: 受付前 → 受付中（5人を超えても申請できる）→ 調整中（超えた日の当該者だけが変更できる）→ 締め切り
// 受付期間・調整期間の日付を入れると、その日付で自動的に切り替わる（ボタンで手動に切り替えることもできる）
const ROUND_STATUS = ['before', 'open', 'adjust', 'closed'];

// ---- 勤務変更 ----
// kind: swap＝交代（自分の勤務と相手の勤務を同時に入れ替える）／furi＝振休の交換（2人の振休の日を入れ替える）／self＝自分の勤務の変更
//       hourly＝時間休／revert＝承認後の取り消し（承認済みの申請を元に戻す。元の申請と同じ人の承認が必要）
// status: wait_partner（受け手の承認待ち）→ wait_approver（承認者の承認待ち）→ approved（承認・実績に反映）
//         rejected（却下）／withdrawn（申請者が取り下げ）
const CHANGE_KINDS = { swap: '交代', furi: '振休の交換', self: '自分の勤務の変更', hourly: '時間休', revert: '承認後の取り消し' };
const CHANGE_STATUS = { wait_partner: '受け手の承認待ち', wait_approver: '承認者の承認待ち', approved: '承認済み', rejected: '却下', withdrawn: '取り下げ' };
const SWAP_MARKS = ['', '×', '○', '入', '明', '残'];              // 交代で入れ替えられる記号
const SWAP_DUTIES = ['○', '入', '残'];                           // 交代で渡す・引き受ける勤務（日直・夜勤・残り当番）
const SELF_MARKS = ['', '有', '夏', '特', '業', '出', '研', '×'];   // 自分の勤務の変更で使える記号
const MAX_STREAK = 6;                                            // 連続勤務は6日まで
const FURI_AFTER_DAYS = 14, FURI_BEFORE_DAYS = 7;                // 振休の付与期限

// ---- 時間休（時間単位の有給。遅く来る・早く帰る・途中で抜けるの3通り）----
// 勤務表のマスには「有12-17」（12時から17時まで休む）の形で入れる。勤務の日として扱い、休み人数には数えない。
// 取る時間は1時間単位（始業・終業・休憩の時刻から計算し、1時間に満たない端数は切り上げ）。
// 年度ごとの上限は「yearDays 日 × dayHours 時間」（申請中のものも含めて数える）
// 休憩は2通りまで（例: 12:00〜13:00 または 13:00〜14:00）。申請するときに、その日の休憩を選ぶ
const HOURLY_DEFAULT = { start: '8:15', end: '17:00', breakFrom: '12:00', breakTo: '13:00', break2From: '13:00', break2To: '14:00',
  dayHours: 8, yearDays: 5, yearStartMonth: 4 };
const HOURLY_WAYS = { late: '遅く来る', early: '早く帰る', middle: '途中で抜ける' };

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

  // ---- 希望休の申請（スタッフ本人）----
  reqView: { run: me => {
    const c = ctx_();
    const effOf = effective_(c);
    const names = allNames_(c);
    const rest = d => isRestDay_(c, d);
    const counts = {};
    c.dates.forEach(d => { if (!rest(d)) counts[d] = names.filter(n => isCountMark_(effOf(n)[d])).length; });
    const myData = c.wf.published ? (c.data[me.name] || {}) : {};
    const myFuri = c.wf.flow === 'duty_first' && c.wf.published
      ? Object.keys(c.data[me.name] || {}).filter(d => c.dateSet.has(d) && isMovableFuri_((c.data[me.name] || {})[d])).sort()
        .map(d => ({ date: d, label: c.data[me.name][d] }))
      : [];
    return {
      period: periodInfo_(c),
      flow: c.wf.flow, flowLabel: FLOW_LABELS[c.wf.flow], published: !!c.wf.published,
      rounds: rounds_(c.wf), cap: DAY_CAP, counts: counts,
      types: { weekday: weekdayTypes_(c.wf, false), rest: ['×'] },
      my: { name: me.name, inRoster: names.indexOf(me.name) >= 0, marks: myData, furi: myFuri,
            requests: c.reqs.filter(r => r.name === me.name).map(publicReq_), overDays: overDaysFor_(c, me.name),
            adjustMember: rounds_(c.wf).some(r => r.status === 'adjust' && ((c.wf.involved || {})[r.id] || []).indexOf(me.name) >= 0) },
    };
  } },

  // メニューに出す注意（自分が申請している日が人数を超えているか）
  reqAlerts: { run: me => {
    const c = ctx_();
    return { overDays: overDaysFor_(c, me.name).length, adjusting: rounds_(c.wf).some(r => r.status === 'adjust') };
  } },

  reqSave: { run: (me, p) => withLock_(() => {
    const c = ctx_();
    const admin = hasRole_(me, 'sysadmin');
    const name = p.name && p.name !== me.name ? (admin ? String(p.name) : null) : me.name;
    if (!name) throw new Error('ほかの人の申請はシステム管理者だけが入れられます。');
    const req = { kind: p.kind === 'move' ? 'move' : 'leave', date: String(p.date || ''), type: String(p.type || ''), fromDate: String(p.fromDate || '') };
    const err = checkRequest_(c, name, req, admin, !!(admin && p.force));
    if (err) throw new Error(err);
    // 同じ日（移動は同じ振休）の申請は置き換える
    const now = new Date().toISOString();
    c.reqs.filter(r => r.name === name && (req.kind === 'move' ? (r.kind === 'move' && r.fromDate === req.fromDate) || r.date === req.date : r.date === req.date))
      .forEach(r => { r.status = 'cancelled'; r.updatedAt = now; r.by = me.id; writeRow_('requests', r); });
    const u = rows_('users').find(x => x.name === name);
    const row = { id: Utilities.getUuid().slice(0, 8), name: name, userId: u ? u.id : '', date: req.date, type: req.kind === 'move' ? '振休移動' : req.type,
      kind: req.kind, fromDate: req.kind === 'move' ? req.fromDate : '', status: 'active', createdAt: now, updatedAt: now, by: me.id };
    writeRow_('requests', row);
    log_(me, '希望休の申請', name + ' ' + (req.kind === 'move' ? '振休移動 ' + req.fromDate + '→' + req.date : req.date + ' ' + req.type) + (p.force ? '（勤務表との重なりを超えて登録）' : ''));
    // 上限を超えたら申請した人に知らせる（同じ日に申請している人の画面にも注意が出る）
    c.reqs.push(row);
    const over = overDays_(c)[req.date];
    return { req: publicReq_(row), warning: over
      ? Number(req.date.slice(5, 7)) + '/' + Number(req.date.slice(8, 10)) + 'は休みが' + over.count + '人になり、上限（' + DAY_CAP + '人）を超えています。同じ日に申請している人に注意が表示されます。受付期間中または調整期間に、申請している人どうしで相談して調整してください。'
      : '' };
  }) },

  reqCancel: { run: (me, p) => withLock_(() => {
    const c = ctx_();
    const admin = hasRole_(me, 'sysadmin');
    const r = c.reqs.find(x => x.id === String(p.id || ''));
    if (!r) throw new Error('取り消す申請が見つかりません（すでに取り消されたか、勤務表に取り込み済みです）。');
    if (!admin) {
      if (r.name !== me.name) throw new Error('自分の申請だけ取り消せます。');
      const rd = roundFor_(c.wf, isRestDay_(c, r.date));
      if (!rd || (rd.status !== 'open' && rd.status !== 'adjust')) throw new Error('受付・調整の期間が終わっているため取り消せません。システム管理者に連絡してください。');
    }
    r.status = 'cancelled'; r.updatedAt = new Date().toISOString(); r.by = me.id;
    writeRow_('requests', r);
    log_(me, '希望休の取り消し', r.name + ' ' + (r.kind === 'move' ? '振休移動 ' + r.fromDate + '→' + r.date : r.date + ' ' + r.type));
    return true;
  }) },

  // ---- システム管理者: 期間・流れ・受付 ----
  wfGet: { role: 'sysadmin', run: () => {
    const c = ctx_();
    const roster = rosterNames_(c);
    const userNames = rows_('users').filter(u => u.active === '1').map(u => u.name);
    return {
      period: periodInfo_(c), flow: c.wf.flow, split: c.wf.split !== false, published: !!c.wf.published,
      flowLabels: FLOW_LABELS, rounds: rounds_(c.wf), involved: c.wf.involved || {}, today: todayJst_(),
      hasState: !!docGet_('state'), cells: Object.keys(c.data).reduce((a, n) => a + Object.keys(c.data[n] || {}).length, 0),
      activeRequests: c.reqs.length,
      rosterWithoutUser: roster.filter(n => userNames.indexOf(n) < 0),
      usersNotInRoster: roster.length ? userNames.filter(n => roster.indexOf(n) < 0 && n !== 'システム管理者') : [],
    };
  } },

  wfSave: { role: 'sysadmin', run: (me, p) => withLock_(() => {
    const wf = Object.assign(defaultWorkflow_(), docGet_('workflow') || {});
    const before = JSON.stringify(rounds_(wf)) + wf.flow + wf.published;
    if (p.flow) { if (!FLOW_LABELS[p.flow]) throw new Error('流れの指定が正しくありません。'); wf.flow = p.flow; }
    if (p.split !== undefined) wf.split = !!p.split;
    if (p.published !== undefined) wf.published = !!p.published;
    Object.keys(p.status || {}).forEach(id => {
      if (p.status[id] === 'auto') delete wf.status[id];
      else if (ROUND_STATUS.indexOf(p.status[id]) >= 0) wf.status[id] = p.status[id];
    });
    Object.keys(p.sched || {}).forEach(id => {
      const s = Object.assign({}, wf.sched[id] || {}, p.sched[id]);
      ['openFrom', 'openTo', 'adjustTo'].forEach(k => { s[k] = /^\d{4}-\d{2}-\d{2}$/.test(String(s[k] || '')) ? s[k] : ''; });
      if (s.openFrom && s.openTo && s.openFrom > s.openTo) throw new Error('受付期間の終わりは、始まりより後にしてください。');
      if (s.openTo && s.adjustTo && s.openTo >= s.adjustTo) throw new Error('調整期間の終わりは、受付期間の終わりより後にしてください。');
      wf.sched[id] = s;
    });
    docPut_('workflow', wf);
    if (before !== JSON.stringify(rounds_(wf)) + wf.flow + wf.published)
      log_(me, '流れ・受付の変更', FLOW_LABELS[wf.flow] + '／' + rounds_(wf).map(r => r.label + ':' + statusLabel_(r.status)).join('、') + (wf.flow === 'duty_first' ? '／仮の勤務表' + (wf.published ? '公開中' : '非公開') : ''));
    return true;
  }) },

  periodSave: { role: 'sysadmin', run: (me, p) => withLock_(() => {
    const start = String(p.start || ''), end = String(p.end || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error('開始日と終了日を入れてください。');
    if (start > end) throw new Error('終了日は開始日より後にしてください。');
    const [sy, sm] = start.split('-').map(Number), [ey, em, ed] = end.split('-').map(Number);
    const span = (ey * 12 + em) - (sy * 12 + sm);
    if (span > 5) throw new Error('期間は6か月以内にしてください。');
    const months = [];
    for (let i = 0; i <= span; i++) months.push(((sm - 1 + i) % 12) + 1);
    const lastDay = new Date(ey, em, 0).getDate();
    const state = docGet_('state') || { schedule: {}, settings: {}, memo: '' };
    state.settings = state.settings || {};
    const old = state.settings.period || {};
    state.settings.period = { year: sy, months: months, extraDates: old.extraDates || [], extraLabel: old.extraLabel || '追加日程',
      start: start.slice(8) === '01' ? null : start, end: ed === lastDay ? null : end };
    saveState_(state);
    log_(me, '期間の設定', start + '〜' + end);
    return periodInfo_(ctx_());
  }) },

  // 勤務表作成アプリの「JSON書出」ファイルを読み込む（移行用・第2段階の後半までの橋渡し）
  stateImport: { role: 'sysadmin', run: (me, p) => withLock_(() => {
    const b = p.backup;
    if (!b || !b.isKinmuBackup) throw new Error('勤務表作成アプリの「JSON書出」で作ったファイル（kinmu_backup.json）を選んでください。');
    const old = docGet_('state');
    saveState_({ schedule: b.schedule || {}, settings: b.settings || {}, memo: b.memo || '', rev: old ? old.rev || 0 : 0 });
    if (Array.isArray(b.archive)) docPut_('archive', b.archive, 'archives');
    const c = ctx_();
    const cells = Object.keys(c.data).reduce((a, n) => a + Object.keys(c.data[n] || {}).length, 0);
    log_(me, '勤務表データの読み込み', periodInfo_(c).label + '・' + cells + 'マス・過去の勤務表' + (b.archive || []).length + '件');
    return { period: periodInfo_(c), cells: cells, archive: (b.archive || []).length, staff: rosterNames_(c).length };
  }) },

  stateExport: { role: 'sysadmin', run: (me, p) => {
    const state = docGet_('state') || { schedule: {}, settings: {}, memo: '' };
    if (p.forDownload) log_(me, '勤務表データの書き出し', '');
    // GASは名前が「__」で終わる項目を画面と受け渡しできないため、目印は isKinmuBackup で送る（画面側で __kinmu_backup__ に戻す）
    return { isKinmuBackup: true, schedule: state.schedule || {}, memo: state.memo || '', archive: docGet_('archive', 'archives') || [],
             settings: state.settings || {}, rev: state.rev || 0 };
  } },

  // 勤務表の作成画面（勤務表作成アプリ）からの自動保存。読み込んだときの版（rev）と違えば保存しない
  stateSave: { role: 'sysadmin', run: (me, p) => withLock_(() => {
    const b = p.backup;
    if (!b || !b.isKinmuBackup) throw new Error('保存する内容が正しくありません。');
    const cur = docGet_('state');
    if ((cur ? cur.rev || 0 : 0) !== Number(p.rev))
      throw new Error('【更新の衝突】勤務表がほかの操作（申請の取り込み・期間の変更など）で更新されました。最新の内容を読み込み直します（直前に行った変更は保存されていないので、もう一度行ってください）。');
    const rev = saveState_({ schedule: b.schedule || {}, settings: b.settings || {}, memo: b.memo || '', rev: cur ? cur.rev || 0 : 0 });
    if (Array.isArray(b.archive)) docPut_('archive', b.archive, 'archives');
    // 操作記録は30分に1回まで（自動保存のたびに記録しない）
    const cache = CacheService.getScriptCache();
    if (!cache.get('statesave_' + me.id)) { cache.put('statesave_' + me.id, '1', 1800); log_(me, '勤務表の編集', '勤務表の作成画面で変更'); }
    return { rev: rev };
  }) },

  // ---- 確定・配布 ----
  scheduleConfirm: { role: 'sysadmin', run: (me, p) => withLock_(() => {
    const pl = p.payload;
    if (!pl || !pl.period || !pl.data || !Array.isArray(pl.teams)) throw new Error('確定する内容が正しくありません。');
    const old = docGet_('confirmed');
    const sameLabel = old && old.label === pl.label;
    const doc = { rev: sameLabel ? (old.rev || 1) + 1 : 1, label: String(pl.label), confirmedAt: new Date().toISOString(), by: me.name,
      period: pl.period, teams: pl.teams, data: pl.data, jimu: pl.jimu || {}, holidays: pl.holidays || {}, dutyTeam: pl.dutyTeam || {},
      leaves: pl.leaves || [] };
    docPut_('confirmed', doc);
    docPut_('confirmed:' + doc.label + ':' + doc.rev, doc, 'archives');   // 確定した版はすべて残す（実績の比較用）
    log_(me, '勤務表の確定・配布', doc.label + ' 第' + doc.rev + '版' + (pl.warnings ? '（警告' + pl.warnings + '件が残った状態）' : ''));
    return { rev: doc.rev, label: doc.label, confirmedAt: doc.confirmedAt };
  }) },

  // 確定版に、確定後に承認された勤務変更を重ねた「実績」を返す（変更したマスは changed に入る）
  scheduleView: { run: () => {
    const doc = docGet_('confirmed');
    if (!doc) return { confirmed: null };
    const act = actual_(doc);
    const dates = periodDates_(doc.period).map(d => ({ date: d, dow: dowOf_(d), rest: confRest_(doc, d), holiday: doc.holidays[d] || '' }));
    return { confirmed: Object.assign({}, doc, { data: act.data }), changed: act.changed, dates: dates };
  } },

  // ---- 勤務変更 ----
  chgPreview: { run: (me, p) => {
    const conf = docGet_('confirmed');
    if (!conf) throw new Error('確定した勤務表がまだありません。');
    return buildChange_(conf, actual_(conf).data, me, p);
  } },

  chgCreate: { run: (me, p) => withLock_(() => {
    const conf = docGet_('confirmed');
    if (!conf) throw new Error('確定した勤務表がまだありません。');
    const ch = buildChange_(conf, actual_(conf).data, me, p);
    // 同じマスに承認待ちの申請があれば受け付けない（先に承認・却下・取り下げを済ませる）
    const pending = rows_('changes').filter(r => r.status === 'wait_partner' || r.status === 'wait_approver');
    const busy = ch.cells.filter(x => pending.some(r => JSON.parse(r.cells).some(y => y.name === x.name && y.date === x.date)));
    if (busy.length) throw new Error(busy.map(x => x.name + 'さんの' + md_(x.date)).filter((v, i, a) => a.indexOf(v) === i).join('、') + 'には、承認待ちの勤務変更があります。その申請が終わってから申請してください。');
    const reason = String(p.reason || '').trim();
    if (ch.deviations.length && reason.length < 5) throw new Error('条件から外れる変更のため、理由を5文字以上で書いてください。');
    const now = new Date().toISOString();
    const row = { id: Utilities.getUuid().slice(0, 8), kind: ch.kind, requester: me.name, requesterId: me.id, partner: ch.partner || '',
      status: ch.partner ? 'wait_partner' : 'wait_approver', cells: JSON.stringify(ch.cells), summary: ch.summary,
      deviations: JSON.stringify(ch.deviations), reason: ch.deviations.length || ch.kind === 'revert' ? reason.slice(0, 500) : '', createdAt: now, updatedAt: now, revertOf: ch.revertOf || '' };
    writeRow_('changes', row);
    const kl = CHANGE_KINDS[ch.kind];
    if (row.partner) notify_(row.partner, me.name + 'さんから「' + kl + '」の承認を頼まれました：' + ch.summary, 'chgme', row.id, me);
    else notifyApprovers_(row, me.name + 'さんの「' + kl + '」が承認者の承認待ちになりました：' + ch.summary, me);
    if (ch.kind === 'revert') {
      const orig = rows_('changes').find(x => x.id === ch.revertOf);
      if (orig && orig.requester !== me.name) notify_(orig.requester, me.name + 'さんが、あなたの申請の取り消しを申請しました：' + orig.summary, 'chg', row.id, me);
    }
    log_(me, '勤務変更の申請', CHANGE_KINDS[ch.kind] + '：' + ch.summary + (ch.deviations.length ? '（条件外' + ch.deviations.length + '件・理由あり）' : ''));
    return publicChange_(row, me);
  }) },

  chgList: { run: me => {
    const all = rows_('changes').slice().reverse();
    const approver = hasRole_(me, 'approver') || hasRole_(me, 'sysadmin');
    return {
      mine: all.filter(r => r.requester === me.name).map(r => publicChange_(r, me)),
      toMe: all.filter(r => r.partner === me.name).map(r => publicChange_(r, me)),
      approvals: approver ? all.map(r => publicChange_(r, me)) : null,
      canApprove: approver, isAdmin: hasRole_(me, 'sysadmin'),
    };
  } },

  chgCounts: { run: me => {
    const all = rows_('changes');
    const approver = hasRole_(me, 'approver') || hasRole_(me, 'sysadmin');
    return {
      toMe: all.filter(r => r.partner === me.name && r.status === 'wait_partner').length,
      approvals: approver ? all.filter(r => r.status === 'wait_approver' && r.requester !== me.name && r.partner !== me.name).length : 0,
    };
  } },

  chgDecide: { run: (me, p) => withLock_(() => {
    const r = rows_('changes').find(x => x.id === String(p.id || ''));
    if (!r) throw new Error('申請が見つかりません。');
    const admin = hasRole_(me, 'sysadmin');
    const approver = hasRole_(me, 'approver') || admin;
    const ok = p.decision === 'approve';
    const now = new Date().toISOString();
    if (r.status === 'wait_partner') {
      if (r.partner !== me.name && !admin) throw new Error('この申請の受け手だけが承認できます。');
      if (ok) { r.status = 'wait_approver'; r.partnerAt = now; r.partnerBy = me.name + (r.partner !== me.name ? '（システム管理者が代理）' : ''); }
    } else if (r.status === 'wait_approver') {
      if (!approver) throw new Error('承認者だけが承認できます。');
      if (!admin && (r.requester === me.name || r.partner === me.name)) throw new Error('自分が関わる変更は、ほかの承認者かシステム管理者が承認します。');
      if (ok) {
        // 申請したときから勤務表が変わっていないか確かめてから反映する
        const conf = docGet_('confirmed');
        if (!conf) throw new Error('確定した勤務表がありません。');
        const act = actual_(conf).data;
        const cells = JSON.parse(r.cells);
        const stale = cells.filter(x => ((act[x.name] || {})[x.date] || '') !== x.before);
        if (stale.length) throw new Error('申請したあとに勤務表が変わったため承認できません（' + stale.map(x => x.name + ' ' + md_(x.date)).join('、') + '）。却下して、申請し直してもらってください。');
        let orig = null;
        if (r.kind === 'revert') {
          orig = rows_('changes').find(x => x.id === r.revertOf);
          if (!orig || orig.revertedBy) throw new Error('取り消す元の申請が見つからないか、すでに取り消されています。');
        }
        r.status = 'approved'; r.approverAt = now; r.approverBy = me.name; r.appliedAt = now;
        applyToState_(cells);
        if (orig) { orig.revertedBy = r.id; orig.updatedAt = now; writeRow_('changes', orig); }
      }
    } else {
      throw new Error('この申請はすでに' + (CHANGE_STATUS[r.status] || r.status) + 'です。');
    }
    if (!ok) { r.status = 'rejected'; r.rejectedBy = me.name; r.note = String(p.note || '').slice(0, 200); }
    r.updatedAt = now;
    writeRow_('changes', r);
    // お知らせ: 申請者・相手（・取り消された元の申請の申請者）、承認者の番になったら承認者に
    const kl = CHANGE_KINDS[r.kind], who = [r.requester].concat(r.partner ? [r.partner] : []);
    if (r.kind === 'revert') { const o = rows_('changes').find(x => x.id === r.revertOf); if (o && who.indexOf(o.requester) < 0) who.push(o.requester); }
    if (r.status === 'wait_approver') {
      notify_(r.requester, me.name + 'さんが「' + kl + '」を承認しました。次は承認者の承認です：' + r.summary, 'chg', r.id, me);
      notifyApprovers_(r, r.requester + 'さんの「' + kl + '」が承認者の承認待ちになりました：' + r.summary, me);
    } else if (r.status === 'approved') {
      who.forEach(n => notify_(n, '「' + kl + '」が承認され、勤務表に反映されました：' + r.summary, n === r.requester ? 'chg' : n === r.partner ? 'chgme' : 'chg', r.id, me));
    } else if (r.status === 'rejected') {
      who.forEach(n => notify_(n, me.name + 'さんが「' + kl + '」を却下しました' + (r.note ? '（' + r.note + '）' : '') + '：' + r.summary, n === r.partner ? 'chgme' : 'chg', r.id, me));
    }
    log_(me, ok ? '勤務変更の承認' : '勤務変更の却下', CHANGE_KINDS[r.kind] + '：' + r.summary + '（' + (CHANGE_STATUS[r.status] || r.status) + '）');
    return publicChange_(r, me);
  }) },

  chgWithdraw: { run: (me, p) => withLock_(() => {
    const r = rows_('changes').find(x => x.id === String(p.id || ''));
    if (!r) throw new Error('申請が見つかりません。');
    if (r.requester !== me.name && !hasRole_(me, 'sysadmin')) throw new Error('自分の申請だけ取り下げられます。');
    if (r.status !== 'wait_partner' && r.status !== 'wait_approver') throw new Error('この申請はすでに' + (CHANGE_STATUS[r.status] || r.status) + 'です。');
    const wasPartner = r.status === 'wait_partner' || !!r.partnerAt;
    r.status = 'withdrawn'; r.updatedAt = new Date().toISOString();
    writeRow_('changes', r);
    if (r.partner && wasPartner) notify_(r.partner, r.requester + 'さんが「' + CHANGE_KINDS[r.kind] + '」を取り下げました：' + r.summary, 'chgme', r.id, me);
    log_(me, '勤務変更の取り下げ', CHANGE_KINDS[r.kind] + '：' + r.summary);
    return true;
  }) },

  // ---- お知らせ ----
  noticeList: { run: me => {
    const mine = rows_('notices').filter(n => n.to === me.name).reverse();
    return { unread: mine.filter(n => n.read !== '1').length,
      items: mine.slice(0, 30).map(n => ({ id: n.id, at: n.at, text: n.text, link: n.link, read: n.read === '1' })) };
  } },
  noticeRead: { run: (me, p) => withLock_(() => {
    const ids = Array.isArray(p.ids) ? p.ids.map(String) : null;   // 指定がなければ全部
    rows_('notices').filter(n => n.to === me.name && n.read !== '1' && (!ids || ids.indexOf(n.id) >= 0))
      .forEach(n => { n.read = '1'; writeRow_('notices', n); });
    return true;
  }) },

  // ---- 時間休 ----
  // 申請画面用: 勤務時間の設定・選べる時刻・自分の使用時間（確定した勤務表の期間にかかる年度ごと）
  hourlyGet: { run: me => {
    const cfg = hourlyCfg_(), conf = docGet_('confirmed');
    const days = conf ? periodDates_(conf.period) : [todayJst_()];
    const fys = [];
    days.forEach(d => { const f = fiscalOf_(d, cfg); if (!fys.some(x => x.fy === f.fy)) fys.push(f); });
    return Object.assign(hourlyInfo_(cfg), {
      usage: fys.map(f => ({ fy: f.fy, label: f.label, from: f.from, to: f.to, used: hourlyUsed_(me.name, f, cfg) })) });
  } },

  // システム管理者: 勤務時間と年度の上限、全員の使用時間
  hourlyAdmin: { role: 'sysadmin', run: () => {
    const cfg = hourlyCfg_(), f = fiscalOf_(todayJst_(), cfg);
    const names = [];
    rows_('changes').forEach(r => JSON.parse(r.cells || '[]').forEach(x => { if ((isHourly_(x.before) || isHourly_(x.after)) && names.indexOf(x.name) < 0) names.push(x.name); }));
    return Object.assign(hourlyInfo_(cfg), { fiscal: f,
      usage: names.map(n => ({ name: n, used: hourlyUsed_(n, f, cfg) })).filter(u => u.used > 0).sort((a, b) => b.used - a.used) });
  } },

  hourlySave: { role: 'sysadmin', run: (me, p) => withLock_(() => {
    const cfg = {};
    ['start', 'end', 'breakFrom', 'breakTo', 'break2From', 'break2To'].forEach(k => {
      const v = String(p[k] || '').trim();
      if (!v && (k === 'break2From' || k === 'break2To')) { cfg[k] = ''; return; }   // 2つ目の休憩はなくてもよい
      if (isNaN(toMin_(v))) throw new Error('時刻は「8:15」のように入れてください。');
      cfg[k] = fmtClock_(toMin_(v));
    });
    if (!cfg.break2From || !cfg.break2To) cfg.break2From = cfg.break2To = '';
    const st = toMin_(cfg.start), en = toMin_(cfg.end);
    if (!(st < en)) throw new Error('終業は始業より後にしてください。');
    [['breakFrom', 'breakTo'], ['break2From', 'break2To']].forEach(k => {
      if (!cfg[k[0]]) return;
      const bf = toMin_(cfg[k[0]]), bt = toMin_(cfg[k[1]]);
      if (bt < bf || (bt > bf && (bf <= st || bt >= en))) throw new Error('休憩は始業と終業の間にしてください（休憩なしは、始まりと終わりを同じ時刻に）。');
    });
    cfg.dayHours = Number(p.dayHours); cfg.yearDays = Number(p.yearDays); cfg.yearStartMonth = Number(p.yearStartMonth);
    if (!(cfg.dayHours >= 1 && cfg.dayHours <= 12 && cfg.dayHours % 1 === 0)) throw new Error('1日分の時間数は1〜12の整数にしてください。');
    if (!(cfg.yearDays >= 0 && cfg.yearDays <= 40 && cfg.yearDays % 1 === 0)) throw new Error('1年度の上限日数は0〜40の整数にしてください。');
    if (!(cfg.yearStartMonth >= 1 && cfg.yearStartMonth <= 12 && cfg.yearStartMonth % 1 === 0)) throw new Error('年度の始まりの月は1〜12にしてください。');
    docPut_('hourly', cfg);
    log_(me, '時間休の設定', '勤務 ' + cfg.start + '〜' + cfg.end + '・休憩 ' + cfg.breakFrom + '〜' + cfg.breakTo + (cfg.break2From ? 'または' + cfg.break2From + '〜' + cfg.break2To : '') + '・上限 ' + cfg.yearDays + '日×' + cfg.dayHours + '時間・年度は' + cfg.yearStartMonth + '月から');
    return true;
  }) },

  // ---- システム管理者: 申請の一覧・代理入力・取り込み ----
  reqAdminView: { role: 'sysadmin', run: () => {
    const c = ctx_();
    return {
      period: periodInfo_(c), flow: c.wf.flow, published: !!c.wf.published, rounds: rounds_(c.wf), cap: DAY_CAP,
      teams: rosterTeams_(c), data: pickDates_(c.data, c.dateSet),
      requests: c.reqs.map(publicReq_), over: overDays_(c),
      types: { weekday: weekdayTypes_(c.wf, true), rest: ['×'].concat(ADMIN_ONLY_TYPES) },
    };
  } },

  reqImport: { role: 'sysadmin', run: me => withLock_(() => {
    const c = ctx_();
    const state = docGet_('state');
    if (!state) throw new Error('勤務表のデータがありません。先に期間を設定してください。');
    const data = state.schedule = state.schedule || {};
    const now = new Date().toISOString();
    let leave = 0, moved = 0; const skipped = [];
    c.reqs.forEach(r => {
      data[r.name] = data[r.name] || {};
      if (r.kind === 'move') {
        const label = data[r.name][r.fromDate];
        if (!isMovableFuri_(label) || data[r.name][r.date]) { skipped.push(r.name + ' 振休移動 ' + r.fromDate + '→' + r.date); return; }
        delete data[r.name][r.fromDate]; data[r.name][r.date] = label; moved++;
      } else {
        if (data[r.name][r.date] && data[r.name][r.date] !== r.type) { skipped.push(r.name + ' ' + r.date + '（勤務表に「' + data[r.name][r.date] + '」）'); return; }
        data[r.name][r.date] = r.type; leave++;
      }
      r.status = 'imported'; r.updatedAt = now; r.by = me.id;
      writeRow_('requests', r);
    });
    saveState_(state);
    log_(me, '申請を勤務表に取り込み', '希望休' + leave + '件・振休移動' + moved + '件' + (skipped.length ? '・取り込めず' + skipped.length + '件' : ''));
    return { leave: leave, moved: moved, skipped: skipped };
  }) },
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
const SHEET_CHECKED = {};
function sheet_(name) {
  const ss = db_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, TABLES[name].length).setValues([TABLES[name]]);
  } else if (!SHEET_CHECKED[name]) {
    // 列を足したときは見出しも足す（前からあるシートでも、新しい列に名前が付くように）
    const head = sh.getRange(1, 1, 1, TABLES[name].length).getValues()[0];
    if (TABLES[name].some((k, i) => String(head[i] || '') !== k)) sh.getRange(1, 1, 1, TABLES[name].length).setValues([TABLES[name]]);
  }
  SHEET_CHECKED[name] = true;
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
  withLock_(() => {
    // 書式を文字列にしてから書く（IDの先頭の0や日時が、数値・日付に変換されないように）
    const row = obj._row || sh.getLastRow() + 1;
    sh.getRange(row, 1, 1, head.length).setNumberFormat('@').setValues(vals);
    obj._row = row;
  });
}
// 同時に複数の人が書き込んでも食い違わないよう、読み取り→確認→書き込みをまとめて排他にする
let LOCK_DEPTH = 0;
function withLock_(fn) {
  if (LOCK_DEPTH) return fn();
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  LOCK_DEPTH++;
  try { return fn(); } finally { LOCK_DEPTH--; lock.releaseLock(); }
}
// ---- 勤務変更の中身 ----
function md_(iso) { return Number(iso.slice(5, 7)) + '/' + Number(iso.slice(8, 10)); }
function addDays_(iso, n) {
  const a = iso.split('-').map(Number);
  const d = new Date(a[0], a[1] - 1, a[2] + n);
  return d.getFullYear() + '-' + pad2_(d.getMonth() + 1) + '-' + pad2_(d.getDate());
}
function confRest_(conf, d) { const w = dowOf_(d); return w === 0 || w === 6 || !!conf.holidays[d]; }
function isFuriLabel_(mk) { return /^\d{1,2}\/\d{1,2}振$/.test(String(mk || '')); }
function furiDuty_(mk, conf) {
  // 「M/D振」の出勤日（期間に近い年）
  const m = String(mk).match(/^(\d{1,2})\/(\d{1,2})振$/);
  if (!m) return null;
  const y0 = conf.period.year;
  let best = null, dist = Infinity;
  const first = periodDates_(conf.period)[0];
  for (let y = y0 - 1; y <= y0 + 1; y++) {
    const iso = y + '-' + pad2_(Number(m[1])) + '-' + pad2_(Number(m[2]));
    const dd = Math.abs(new Date(iso) - new Date(first));
    if (dd < dist) { dist = dd; best = iso; }
  }
  return best;
}
function daysBetween_(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }
// ---- 時間休 ----
function hourlyCfg_() { return Object.assign({}, HOURLY_DEFAULT, docGet_('hourly') || {}); }
function toMin_(t) { const m = String(t || '').match(/^(\d{1,2}):(\d{2})$/); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; }
function fmtMin_(min) { const h = Math.floor(min / 60), m = min % 60; return m ? h + ':' + pad2_(m) : String(h); }        // 12 または 8:30
function fmtClock_(min) { return Math.floor(min / 60) + ':' + pad2_(min % 60); }                                     // 12:00
function parseHourly_(mk) {
  const m = String(mk || '').match(/^有(\d{1,2})(?::(\d{2}))?-(\d{1,2})(?::(\d{2}))?$/);
  return m ? { from: Number(m[1]) * 60 + Number(m[2] || 0), to: Number(m[3]) * 60 + Number(m[4] || 0) } : null;
}
function isHourly_(mk) { return !!parseHourly_(mk); }
function hourlyMark_(from, to) { return '有' + fmtMin_(from) + '-' + fmtMin_(to); }
// 休憩の一覧（[{from, to}]、分）。2つ目は設定したときだけ
function breaks_(cfg) {
  return [[cfg.breakFrom, cfg.breakTo], [cfg.break2From, cfg.break2To]].map(x => ({ from: toMin_(x[0]), to: toMin_(x[1]) }))
    .filter((x, i) => x.to > x.from || i === 0).map(x => x.to > x.from ? x : { from: 0, to: 0 });
}
// 実際に勤務する時間（休憩を除く）の分数。bi＝その日の休憩（0 または 1）
function workMin_(cfg, from, to, bi) {
  const bs = breaks_(cfg), b = bs[bi] || bs[0];
  const overlap = b.to > b.from ? Math.max(0, Math.min(to, b.to) - Math.max(from, b.from)) : 0;
  return Math.max(0, to - from - overlap);
}
function hoursOf_(cfg, from, to, bi) { return Math.ceil(workMin_(cfg, from, to, bi) / 60); }
// 記録がないときの時間数（1つ目の休憩で計算）
function hourlyHours_(cfg, mk) { const h = parseHourly_(mk); return h ? hoursOf_(cfg, h.from, h.to, 0) : 0; }
function hourlyWay_(cfg, from, to) { return from === toMin_(cfg.start) ? 'late' : to === toMin_(cfg.end) ? 'early' : 'middle'; }
function hourlyText_(cfg, mk, hours) {
  const h = parseHourly_(mk);
  return h ? HOURLY_WAYS[hourlyWay_(cfg, h.from, h.to)] + ' ' + fmtClock_(h.from) + '〜' + fmtClock_(h.to) + '（' + hours + '時間）' : '';
}
// 選べる時刻: 始業・ちょうどの時刻・終業（休憩の区切りがちょうどでなければそれも）
function hourlyTimes_(cfg) {
  const st = toMin_(cfg.start), en = toMin_(cfg.end), out = [st];
  for (let t = Math.floor(st / 60) * 60 + 60; t < en; t += 60) out.push(t);
  breaks_(cfg).forEach(b => [b.from, b.to].forEach(t => { if (t > st && t < en && out.indexOf(t) < 0) out.push(t); }));
  out.push(en);
  return out.sort((x, y) => x - y);
}
// 申請画面に渡す形
function hourlyInfo_(cfg) {
  return { cfg: cfg, cap: hourlyCap_(cfg), ways: HOURLY_WAYS, dayHours: Number(cfg.dayHours),
    times: hourlyTimes_(cfg).map(t => ({ min: t, label: fmtClock_(t) })),
    breaks: breaks_(cfg).filter(b => b.to > b.from).map(b => ({ from: b.from, to: b.to, label: fmtClock_(b.from) + '〜' + fmtClock_(b.to) })) };
}
// 申請された時刻を確かめて、時間数を返す
function checkHourly_(cfg, from, to, bi) {
  const times = hourlyTimes_(cfg), st = toMin_(cfg.start), en = toMin_(cfg.end);
  if (times.indexOf(from) < 0 || times.indexOf(to) < 0 || !(from < to)) throw new Error('休む時刻（開始と終了）を選んでください。');
  if (from === st && to === en) throw new Error('1日休む場合は、「自分の勤務の変更」で「有」にしてください。');
  const hours = hoursOf_(cfg, from, to, bi);
  if (hours < 1) throw new Error('休憩の時間だけになっています。休む時刻を選び直してください。');
  if (hours >= Number(cfg.dayHours)) throw new Error('1日分（' + cfg.dayHours + '時間）以上になるため、「自分の勤務の変更」で「有」にしてください。');
  return hours;
}
// その日の時間休の、記録された時間数（承認済みの変更から探す）
function recordedHours_(name, date, mk, cfg) {
  const prev = rows_('changes').filter(r => r.status === 'approved').map(r => JSON.parse(r.cells || '[]'))
    .reduce((a, cs) => a.concat(cs), []).filter(y => y.name === name && y.date === date && y.after === mk && y.afterHours !== undefined).pop();
  return prev ? Number(prev.afterHours) : hourlyHours_(cfg, mk);
}
// その日が入る年度（yearStartMonth 月はじまり）
function fiscalOf_(iso, cfg) {
  const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7)), sm = Number(cfg.yearStartMonth) || 4;
  const fy = m >= sm ? y : y - 1;
  const from = fy + '-' + pad2_(sm) + '-01', to = (fy + 1) + '-' + pad2_(sm) + '-01';
  return { fy: fy, from: from, to: to, label: fy + '年度（' + fy + '年' + sm + '月〜）' };
}
// その年度に使った時間休（承認済み＋申請中。変更のたびの増減を足し合わせる）
function hourlyUsed_(name, fy, cfg) {
  let used = 0;
  rows_('changes').filter(r => r.status === 'approved' || r.status === 'wait_partner' || r.status === 'wait_approver').forEach(r => {
    JSON.parse(r.cells || '[]').forEach(x => {
      if (x.name !== name || x.date < fy.from || x.date >= fy.to) return;
      const a = x.afterHours !== undefined ? Number(x.afterHours) : hourlyHours_(cfg, x.after);
      const b = x.beforeHours !== undefined ? Number(x.beforeHours) : hourlyHours_(cfg, x.before);
      // 申請中のものは、増える分だけ数える（取り消し・短くする申請は、承認されてから減らす）
      used += r.status === 'approved' ? a - b : Math.max(0, a - b);
    });
  });
  return Math.max(0, used);
}
function hourlyCap_(cfg) { return Number(cfg.yearDays) * Number(cfg.dayHours); }
// 確定版に、確定後に承認された変更を順に重ねる
function actual_(conf) {
  const data = JSON.parse(JSON.stringify(conf.data || {}));
  const changed = {};
  rows_('changes').filter(r => r.status === 'approved' && r.appliedAt > conf.confirmedAt)
    .sort((a, b) => a.appliedAt < b.appliedAt ? -1 : 1)
    .forEach(r => JSON.parse(r.cells).forEach(x => {
      data[x.name] = data[x.name] || {};
      if (x.after) data[x.name][x.date] = x.after; else delete data[x.name][x.date];
      changed[x.name + '|' + x.date] = 1;
    }));
  return { data: data, changed: changed };
}
// 承認した変更を勤務表作成アプリのデータにも入れる（再配布で抜け落ちないように）
function applyToState_(cells) {
  const state = docGet_('state');
  if (!state) return;
  const data = state.schedule = state.schedule || {};
  const st = state.settings || {};
  cells.forEach(x => {
    data[x.name] = data[x.name] || {};
    if (x.after) data[x.name][x.date] = x.after; else delete data[x.name][x.date];
  });
  // 振休が別の日に移ったら、振休の自動配置の記録も付け替える（「3. 振休」のやり直しで重複しないように）
  cells.filter(x => isFuriLabel_(x.before) && !x.after).forEach(from => {
    const to = cells.find(y => y.name === from.name && y.after === from.before && !y.before);
    if (!to) return;
    (st.furi_auto || []).forEach(f => { if (f.name === from.name && f.iso === from.date) f.iso = to.date; });
  });
  saveState_(state);
}
// 申請の中身を組み立て、確かめる（受け付けられない場合はエラー、条件外は deviations に入れる）
function buildChange_(conf, act, me, p) {
  const kind = p.kind;
  if (!CHANGE_KINDS[kind]) throw new Error('変更の種類を選んでください。');
  const dates = periodDates_(conf.period), dateSet = new Set(dates);
  const roster = [].concat.apply([], conf.teams.map(t => t[1]));
  const name = me.name;
  if (kind !== 'revert' && roster.indexOf(name) < 0) throw new Error('あなたの名前（' + name + '）が勤務表の名簿にありません。システム管理者に確認してください。');
  const cell = (n, d) => (act[n] || {})[d] || '';
  const cells = [];
  let partner = '', summary = '', hoursNote = '', revertOf = '';
  if (kind === 'revert') {
    // 承認後の取り消し: 承認済みの申請のマスを、申請前の内容に戻す（その後にマスが変わっていないこと）
    const orig = rows_('changes').find(r => r.id === String(p.of || ''));
    if (!orig || orig.status !== 'approved') throw new Error('取り消す、承認済みの申請を選んでください。');
    if (orig.kind === 'revert') throw new Error('「承認後の取り消し」は取り消せません。元に戻したいときは、新しく申請してください。');
    if (orig.revertedBy) throw new Error('この申請は、すでに取り消されています。');
    if (orig.requester !== name && !hasRole_(me, 'sysadmin')) throw new Error('自分の申請だけ取り消せます。');
    const oc = JSON.parse(orig.cells || '[]');
    const out = oc.filter(x => !dateSet.has(x.date));
    if (out.length) throw new Error('今の勤務表の期間の外の日（' + out.map(x => md_(x.date)).join('、') + '）が含まれるため、取り消せません。');
    const moved = oc.filter(x => cell(x.name, x.date) !== (x.after || ''));
    if (moved.length) throw new Error('承認されたあとに、' + moved.map(x => x.name + 'さんの' + md_(x.date)).join('、') + 'が変わっているため、取り消せません（今の勤務表から、新しく申請してください）。');
    oc.forEach(x => {
      const y = { name: x.name, date: x.date, before: x.after || '', after: x.before || '' };
      if (x.afterHours !== undefined) y.beforeHours = x.afterHours;
      if (x.beforeHours !== undefined) y.afterHours = x.beforeHours;
      cells.push(y);
    });
    partner = orig.partner || '';
    if (partner === name) partner = orig.requester;   // 念のため（相手側が取り消すことはできないが、システム管理者のとき）
    revertOf = orig.id;
    summary = '取り消し：' + orig.summary;
  } else if (kind === 'swap' || kind === 'furi') {
    partner = String(p.partner || '');
    if (!partner || roster.indexOf(partner) < 0) throw new Error('交代する相手を選んでください。');
    if (partner === name) throw new Error('相手には自分以外の人を選んでください。');
  }
  if (kind === 'revert') {
    // 上で組み立て済み
  } else if (kind === 'swap') {
    // 交代: 自分が渡す勤務（myDate）と、代わりに引き受ける相手の勤務（partnerDate）を同時に入れ替える。
    // 夜勤（入）は翌日の「明」も一緒に移す
    const myDate = String(p.myDate || ''), pDate = String(p.partnerDate || '');
    const mine = cell(name, myDate), theirs = cell(partner, pDate);
    if (!dateSet.has(myDate) || SWAP_DUTIES.indexOf(mine) < 0) throw new Error('自分が渡す勤務（日直・夜勤・残り当番）の日を選んでください。');
    if (!dateSet.has(pDate) || SWAP_DUTIES.indexOf(theirs) < 0) throw new Error('代わりに引き受ける、相手の勤務（日直・夜勤・残り当番）の日を選んでください。');
    const span = (n, d) => {
      const ds = [d], nx = addDays_(d, 1);
      if (cell(n, d) === '入' && dateSet.has(nx) && cell(n, nx) === '明') ds.push(nx);
      return ds;
    };
    const give = span(name, myDate), take = span(partner, pDate);
    const ds = give.concat(take).filter((d, i, a) => a.indexOf(d) === i).sort();
    const isFree = mk => mk === '' || mk === '×';
    ds.forEach(d => {
      [name, partner].forEach(n => {
        const mk = cell(n, d);
        if (String(mk).indexOf('振') >= 0) throw new Error(md_(d) + 'の' + n + 'さんは振休です。振休は「振休の交換」で、振休同士で入れ替えてください。');
        if (isHourly_(mk)) throw new Error(md_(d) + 'の' + n + 'さんには時間休（' + mk + '）があります。時間休のある日は交代できません（先に「時間休」で取り消してください）。');
        if (SWAP_MARKS.indexOf(mk) < 0) throw new Error(md_(d) + 'の' + n + 'さんの「' + mk + '」は人と入れ替えられません（休み・出張などは「自分の勤務の変更」で行います）。');
      });
      // 受け取る側は、その日に別の勤務が入っていないこと（同じ日の勤務どうしの入れ替えは可）
      if (give.indexOf(d) >= 0 && take.indexOf(d) < 0 && !isFree(cell(partner, d)))
        throw new Error(md_(d) + 'は' + partner + 'さんに「' + cell(partner, d) + '」が入っているため、あなたの勤務を引き受けられません。');
      if (take.indexOf(d) >= 0 && give.indexOf(d) < 0 && !isFree(cell(name, d)))
        throw new Error(md_(d) + 'はあなたに「' + cell(name, d) + '」が入っているため、' + partner + 'さんの勤務を引き受けられません。');
      const a = cell(name, d), b = cell(partner, d);
      if (a === b) return;
      cells.push({ name: name, date: d, before: a, after: b }, { name: partner, date: d, before: b, after: a });
    });
    if (!cells.length) throw new Error('2人とも同じ勤務のため、入れ替えるものがありません。');
    const named = { '○': '日直', '入': '夜勤', '残': '残り当番' };
    summary = name + 'の' + md_(myDate) + named[mine] + ' ⇄ ' + partner + 'の' + md_(pDate) + named[theirs];
  } else if (kind === 'furi') {
    const myDate = String(p.myDate || ''), pDate = String(p.partnerDate || '');
    if (!isFuriLabel_(cell(name, myDate))) throw new Error('自分の振休の日を選んでください。');
    if (!isFuriLabel_(cell(partner, pDate))) throw new Error('相手の振休の日を選んでください。');
    if (myDate === pDate) throw new Error('同じ日の振休どうしは入れ替える必要がありません。');
    if (cell(name, pDate)) throw new Error(md_(pDate) + 'はあなたに「' + cell(name, pDate) + '」が入っているため、振休を移せません。');
    if (cell(partner, myDate)) throw new Error(md_(myDate) + 'は' + partner + 'さんに「' + cell(partner, myDate) + '」が入っているため、振休を移せません。');
    const myLb = cell(name, myDate), pLb = cell(partner, pDate);
    cells.push({ name: name, date: myDate, before: myLb, after: '' }, { name: name, date: pDate, before: '', after: myLb },
               { name: partner, date: pDate, before: pLb, after: '' }, { name: partner, date: myDate, before: '', after: pLb });
    summary = name + 'の振休 ' + md_(myDate) + '→' + md_(pDate) + '、' + partner + 'の振休 ' + md_(pDate) + '→' + md_(myDate);
  } else if (kind === 'hourly') {
    // 時間休: 平日の勤務の日（空きマス）に「有12-17」を入れる／時刻を変える／取り消す
    const cfg = hourlyCfg_();
    const d = String(p.date || '');
    if (!dateSet.has(d)) throw new Error('時間休を取る日を選んでください。');
    if (confRest_(conf, d)) throw new Error('時間休は平日の勤務の日だけ取れます。');
    if ((conf.leaves || []).some(l => l.name === name && l.from <= d && d <= l.to)) throw new Error(md_(d) + 'は長期休暇の期間です。');
    const from = cell(name, d);
    if (from && !isHourly_(from)) throw new Error(md_(d) + 'は「' + from + '」が入っています。時間休は、ふつうの勤務の日だけ取れます。');
    const fromH = from ? recordedHours_(name, d, from, cfg) : 0;
    let to = '', toH = 0;
    if (p.way === 'cancel') {
      if (!from) throw new Error(md_(d) + 'に時間休はありません。');
    } else {
      const f = toMin_(p.from), t = toMin_(p.to), bi = Number(p.brk) === 1 && breaks_(cfg).length > 1 ? 1 : 0;
      toH = checkHourly_(cfg, f, t, bi);
      to = hourlyMark_(f, t);
    }
    if (to === from) throw new Error('今と同じ内容です。');
    const add = toH - fromH;
    const fy = fiscalOf_(d, cfg), used = hourlyUsed_(name, fy, cfg), cap = hourlyCap_(cfg);
    if (add > 0 && used + add > cap)
      throw new Error('時間休は1年度に' + cfg.yearDays + '日分（' + cap + '時間）までです。' + fy.label + 'は申請中を含めて' + used + '時間使っているため、あと' + Math.max(0, cap - used) + '時間までです。');
    const x = { name: name, date: d, before: from, after: to };
    if (from) x.beforeHours = fromH;
    if (to) x.afterHours = toH;
    cells.push(x);
    summary = name + ' ' + md_(d) + '：' + (to ? '時間休（' + hourlyText_(cfg, to, toH) + '）' + (from ? '　変更前：' + hourlyText_(cfg, from, fromH) : '') : '時間休の取り消し（' + hourlyText_(cfg, from, fromH) + '）');
    hoursNote = fy.label + 'の時間休：申請中を含めて' + used + '時間' + (add ? (add > 0 ? '＋今回' + add : '－今回' + (-add)) + '時間＝' + Math.max(0, used + add) + '時間' : '') + '（上限' + cap + '時間＝' + cfg.yearDays + '日×' + cfg.dayHours + '時間）';
  } else {
    const d = String(p.date || ''), to = String(p.mark || '');
    if (!dateSet.has(d)) throw new Error('変更する日を選んでください。');
    const from = cell(name, d), rest = confRest_(conf, d);
    if (String(from).indexOf('振') >= 0) throw new Error('振休は「振休の交換」で、ほかの人の振休と入れ替えてください。');
    if (SELF_MARKS.indexOf(from) < 0 && !isHourly_(from)) throw new Error(md_(d) + 'は「' + from + '」です。日直・夜勤・残り当番は「交代」で、ほかの人と入れ替えてください。');
    if (SELF_MARKS.indexOf(to) < 0) throw new Error('変更後の勤務を選んでください。');
    if (to === from) throw new Error('今と同じ内容です。');
    if (rest && ['有', '夏', '特'].indexOf(to) >= 0) throw new Error('土日祝に「' + to + '」は入れられません。');
    if (!rest && to === '×') throw new Error('「×」は土日祝だけに入れられます。');
    cells.push({ name: name, date: d, before: from, after: to });
    const empty = rest ? '休み' : '勤務';
    summary = name + ' ' + md_(d) + '：' + (from || empty) + ' → ' + (to || empty);
  }
  const deviations = deviations_(conf, act, cells);
  const hcfg = hourlyCfg_();
  cells.forEach(x => {
    x.rest = confRest_(conf, x.date);   // 画面で空きマスを「勤務」「休み」と書き分けるため
    // 時間休の時間数は申請時の設定で記録する（あとで勤務時間の設定を変えても、使った時間が変わらないように）
    if (isHourly_(x.before) && x.beforeHours === undefined) x.beforeHours = recordedHours_(x.name, x.date, x.before, hcfg);
    if (isHourly_(x.after) && x.afterHours === undefined) x.afterHours = hourlyHours_(hcfg, x.after);
  });
  return { kind: kind, partner: partner, cells: cells, summary: summary, deviations: deviations, hoursNote: hoursNote, revertOf: revertOf };
}
// 変更によって新しく起きる、きまりから外れること
function deviations_(conf, act, cells) {
  const after = JSON.parse(JSON.stringify(act));
  cells.forEach(x => { after[x.name] = after[x.name] || {}; if (x.after) after[x.name][x.date] = x.after; else delete after[x.name][x.date]; });
  const dates = periodDates_(conf.period);
  const names = [].concat.apply([], conf.teams.map(t => t[1]));
  const onLeave = (n, d) => (conf.leaves || []).some(l => l.name === n && l.from <= d && d <= l.to);
  const out = [];
  const people = [], days = [];
  cells.forEach(x => { if (people.indexOf(x.name) < 0) people.push(x.name); if (days.indexOf(x.date) < 0) days.push(x.date); });
  // 1) 平日の休みが上限を超える
  days.forEach(d => {
    if (confRest_(conf, d)) return;
    const cnt = data => names.filter(n => !onLeave(n, d) && isCountMark_((data[n] || {})[d])).length;
    const b = cnt(act), a = cnt(after);
    if (a > DAY_CAP && a > b) out.push(md_(d) + 'の休みが' + a + '人になり、上限（' + DAY_CAP + '人）を超えます');
  });
  // 2) 連続勤務 3) 夜勤明けの翌日の勤務
  const isWork = (data, n, d) => {
    if (onLeave(n, d)) return false;
    const mk = (data[n] || {})[d] || '';
    if (['○', '入', '明', '残', '業', '出', '研'].indexOf(mk) >= 0) return true;
    if (!mk || isHourly_(mk)) return !confRest_(conf, d);   // 時間休の日も勤務の日
    return false;   // 有・夏・特・×・振休
  };
  const longest = (data, n) => { let best = 0, cur = 0; dates.forEach(d => { cur = isWork(data, n, d) ? cur + 1 : 0; best = Math.max(best, cur); }); return best; };
  people.forEach(n => {
    const b = longest(act, n), a = longest(after, n);
    if (a > MAX_STREAK && a > b) out.push(n + 'さんが' + a + '日連続の勤務になります（' + MAX_STREAK + '日まで）');
    dates.forEach(d => {
      const nx = addDays_(d, 1);
      const bad = data => (data[n] || {})[d] === '明' && dates.indexOf(nx) >= 0 && isWork(data, n, nx) && ((data[n] || {})[nx] || '') !== '入';
      if (bad(after) && !bad(act)) out.push(n + 'さんの夜勤明け（' + md_(d) + '）の翌日が勤務になります');
    });
  });
  // 4) 振休の付与期限（前回繰越の振休は、期間内に置けばよいので対象外。勤務表作成アプリと同じ）
  cells.forEach(x => {
    if (!isFuriLabel_(x.after)) return;
    const duty = furiDuty_(x.after, conf);
    if (!duty || duty < dates[0]) return;
    const diff = daysBetween_(duty, x.date);
    if (diff > FURI_AFTER_DAYS || diff < -FURI_BEFORE_DAYS)
      out.push(x.name + 'さんの振休（' + md_(duty) + '出勤分）が' + md_(x.date) + 'になり、付与期限（出勤後' + FURI_AFTER_DAYS + '日・前' + FURI_BEFORE_DAYS + '日）を外れます');
  });
  return out;
}
// アプリ内のお知らせを入れる（操作した本人には入れない）
function notify_(to, text, link, changeId, actor) {
  if (!to || (actor && to === actor.name)) return;
  writeRow_('notices', { id: Utilities.getUuid().slice(0, 8), to: to, at: new Date().toISOString(), text: String(text).slice(0, 300),
    link: link || '', changeId: changeId || '', read: '' });
}
// 承認者（とシステム管理者）全員に知らせる（その申請に関わる人は承認できないので除く。ただしシステム管理者は除かない）
function notifyApprovers_(r, text, actor) {
  rows_('users').filter(u => u.active === '1' && (hasRole_(u, 'approver') || hasRole_(u, 'sysadmin')))
    .filter(u => hasRole_(u, 'sysadmin') || (u.name !== r.requester && u.name !== r.partner))
    .forEach(u => notify_(u.name, text, 'chgadm', r.id, actor));
}
// 画面に返す形（理由はシステム管理者・承認者・申請者本人にだけ見せる）
function publicChange_(r, me) {
  const canSeeReason = hasRole_(me, 'sysadmin') || hasRole_(me, 'approver') || r.requester === me.name;
  return { id: r.id, kind: r.kind, kindLabel: CHANGE_KINDS[r.kind], requester: r.requester, partner: r.partner, status: r.status,
    statusLabel: CHANGE_STATUS[r.status] || r.status, cells: JSON.parse(r.cells || '[]'), summary: r.summary,
    deviations: JSON.parse(r.deviations || '[]'), reason: canSeeReason ? r.reason : (r.reason ? '（理由は管理者だけが見られます）' : ''),
    createdAt: r.createdAt, updatedAt: r.updatedAt, partnerAt: r.partnerAt, partnerBy: r.partnerBy, approverAt: r.approverAt,
    approverBy: r.approverBy, rejectedBy: r.rejectedBy, note: r.note, revertOf: r.revertOf || '', revertedBy: r.revertedBy || '' };
}

// 勤務表（state）を保存するたびに版（rev）を1つ上げる。作成画面の自動保存が古い内容で上書きしないための目印
function saveState_(state) {
  state.rev = (state.rev || 0) + 1;
  docPut_('state', state);
  return state.rev;
}
function findUser_(id) {
  id = String(id || '');
  return rows_('users').find(u => u.id === id) || null;
}

// ---- 大きなデータ（JSON）を分割して保存 ----
const DOC_CHUNK = 40000;   // 1マスの上限（5万文字）より少なく
const DOC_MEMO = {};       // 1回の操作の中では読み直さない
function docGet_(key, table) {
  table = table || 'docs';
  const mk = table + ':' + key;
  if (mk in DOC_MEMO) return DOC_MEMO[mk];
  const parts = rows_(table).filter(r => r.key === key).sort((a, b) => Number(a.part) - Number(b.part));
  return (DOC_MEMO[mk] = parts.length ? JSON.parse(parts.map(r => r.text).join('')) : null);
}
function docPut_(key, obj, table) {
  table = table || 'docs';
  withLock_(() => {
    const text = JSON.stringify(obj);
    const chunks = [];
    for (let i = 0; i < text.length; i += DOC_CHUNK) chunks.push(text.slice(i, i + DOC_CHUNK));
    const old = rows_(table).filter(r => r.key === key).sort((a, b) => Number(a.part) - Number(b.part));
    const now = new Date().toISOString();
    chunks.forEach((t, i) => { const r = old[i] || {}; r.key = key; r.part = String(i); r.text = t; r.updatedAt = now; writeRow_(table, r); });
    for (let i = chunks.length; i < old.length; i++) { const r = old[i]; r.key = ''; r.part = ''; r.text = ''; r.updatedAt = ''; writeRow_(table, r); }
    DOC_MEMO[table + ':' + key] = JSON.parse(text);
  });
}

// ---- 期間・流れ・申請のきまり ----
function defaultWorkflow_() {
  return { flow: 'request_first', split: true, published: false, status: {}, sched: {} };
}
function rounds_(wf) {
  const list = wf.flow === 'duty_first' && wf.split !== false
    ? [{ id: 'rest', label: '土日祝の×', days: 'rest' }, { id: 'weekday', label: '平日の希望休', days: 'weekday' }]
    : [{ id: 'all', label: '希望休', days: 'all' }];
  return list.map(r => {
    const s = (wf.sched || {})[r.id] || {};
    const manual = (wf.status || {})[r.id] || '';
    return Object.assign(r, { status: manual || statusByDate_(s) || 'before', manual: !!manual,
      openFrom: s.openFrom || '', openTo: s.openTo || '', adjustTo: s.adjustTo || '' });
  });
}
// 今日の日付（日本時間）
function todayJst_() { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); }
// 受付期間・調整期間の日付から、今の状態を決める（日付が入っていなければ null）
function statusByDate_(s) {
  if (!s.openFrom && !s.openTo) return null;
  const t = todayJst_();
  if (s.openFrom && t < s.openFrom) return 'before';
  if (!s.openTo || t <= s.openTo) return 'open';
  if (s.adjustTo && t <= s.adjustTo) return 'adjust';
  return 'closed';
}
function roundFor_(wf, rest) {
  return rounds_(wf).find(r => r.days === 'all' || r.days === (rest ? 'rest' : 'weekday')) || null;
}
function statusLabel_(s) { return { before: '受付前', open: '受付中', adjust: '調整中', closed: '締め切り' }[s] || s; }
// 平日で休みが上限を超えている日 {日付: {count, names（申請している人）}}
function overDays_(c) {
  const effOf = effective_(c);
  const names = allNames_(c);
  const out = {};
  c.dates.forEach(d => {
    if (isRestDay_(c, d)) return;
    const count = names.filter(n => isCountMark_(effOf(n)[d])).length;
    if (count <= DAY_CAP) return;
    const reqNames = [];
    c.reqs.forEach(r => { if (r.date === d && isCountMark_(effOf(r.name)[d]) && reqNames.indexOf(r.name) < 0) reqNames.push(r.name); });
    out[d] = { count: count, names: reqNames };
  });
  return out;
}
// 自分が申請している超過日（ほかに申請している人の名前つき。種類は見せない）
function overDaysFor_(c, name) {
  const over = overDays_(c);
  return Object.keys(over).sort().filter(d => over[d].names.indexOf(name) >= 0)
    .map(d => ({ date: d, count: over[d].count, others: over[d].names.filter(n => n !== name), fixed: over[d].count - over[d].names.length }));
}
function weekdayTypes_(wf, admin) {
  // 当番が先の流れでは「振◆」の代わりに「振休の移動」を使う
  const t = ['有', '夏', '特'].concat(wf.flow === 'duty_first' ? [] : ['振◆']);
  return admin ? t.concat(ADMIN_ONLY_TYPES) : t;
}
function ctx_() {
  const state = docGet_('state') || { schedule: {}, settings: {} };
  const settings = state.settings || {};
  const wf = Object.assign(defaultWorkflow_(), docGet_('workflow') || {});
  const dates = periodDates_(settings.period);
  const c = { state: state, settings: settings, wf: wf, period: settings.period || null, dates: dates, dateSet: new Set(dates),
           custom: new Set(settings.custom_holidays || []), data: state.schedule || {},
           reqs: rows_('requests').filter(r => r.status === 'active') };
  syncAdjustMembers_(c);
  return c;
}
// 調整期間に入ったときの「当該者」（超過日に申請していた人）を記録しておく。
// 本人が先に取り消してから別の日へ申請し直せるよう、途中で超過が解消しても当該者のままにする
function syncAdjustMembers_(c) {
  const wf = c.wf;
  wf.involved = wf.involved || {};
  let changed = false;
  rounds_(wf).forEach(r => {
    if (r.status === 'adjust' && !wf.involved[r.id]) {
      const over = overDays_(c), names = [];
      Object.keys(over).forEach(d => over[d].names.forEach(n => { if (names.indexOf(n) < 0) names.push(n); }));
      wf.involved[r.id] = names; changed = true;
    } else if (r.status !== 'adjust' && wf.involved[r.id]) {
      delete wf.involved[r.id]; changed = true;
    }
  });
  if (changed) withLock_(() => docPut_('workflow', wf));
}
function pad2_(n) { return ('0' + n).slice(-2); }
function periodDates_(p) {
  if (!p || !p.months || !p.months.length) return [];
  const out = [], seen = {};
  p.months.forEach(m => {
    const y = m >= p.months[0] ? p.year : p.year + 1;
    let from = 1, to = new Date(y, m, 0).getDate();
    if (p.start) { const s = p.start.split('-').map(Number); if (s[0] === y && s[1] === m) from = s[2]; }
    if (p.end) { const e = p.end.split('-').map(Number); if (e[0] === y && e[1] === m) to = e[2]; }
    for (let d = from; d <= to; d++) { const iso = y + '-' + pad2_(m) + '-' + pad2_(d); out.push(iso); seen[iso] = 1; }
  });
  (p.extraDates || []).forEach(iso => { if (!seen[iso]) out.push(iso); });
  return out;
}
function dowOf_(iso) { const a = iso.split('-').map(Number); return new Date(a[0], a[1] - 1, a[2]).getDay(); }
function isRestDay_(c, iso) { const w = dowOf_(iso); return w === 0 || w === 6 || !!HOLIDAYS[iso] || c.custom.has(iso); }
function periodInfo_(c) {
  if (!c.dates.length) return { label: '（期間が未設定）', dates: [] };
  const f = iso => { const a = iso.split('-').map(Number); return a[0] + '年' + a[1] + '月' + a[2] + '日'; };
  const sorted = c.dates.slice().sort();
  return {
    label: f(sorted[0]) + '〜' + f(sorted[sorted.length - 1]), start: sorted[0], end: sorted[sorted.length - 1],
    dates: c.dates.map(d => ({ date: d, dow: dowOf_(d), rest: isRestDay_(c, d), holiday: HOLIDAYS[d] || (c.custom.has(d) ? '休日' : '') })),
  };
}
function isCountMark_(mk) { return !!mk && (COUNT_MARKS.indexOf(mk) >= 0 || String(mk).indexOf('振') >= 0); }
function isMovableFuri_(mk) { return /^\d{1,2}\/\d{1,2}振$/.test(String(mk || '')); }   // 日付つきの振休だけ（夜勤明けの「振」は動かさない）
// 申請（取り込み前）を勤務表に重ねた、その時点の見込み
function effective_(c) {
  const eff = {};
  c.reqs.forEach(r => {
    const m = eff[r.name] || (eff[r.name] = Object.assign({}, c.data[r.name] || {}));
    if (r.kind === 'move') { const label = (c.data[r.name] || {})[r.fromDate]; if (label) { delete m[r.fromDate]; m[r.date] = label; } }
    else m[r.date] = r.type;
  });
  return name => eff[name] || c.data[name] || {};
}
function rosterTeams_(c) {
  // 勤務表のチーム編成（なければ登録スタッフのチーム）
  if (Array.isArray(c.settings.teams) && c.settings.teams.length) return c.settings.teams.map(t => [String(t[0]), (t[1] || []).map(String)]);
  const map = {};
  rows_('users').filter(u => u.active === '1' && (u.team || !hasRole_(u, 'sysadmin'))).forEach(u => {
    (map[u.team || 'チームなし'] = map[u.team || 'チームなし'] || []).push(u.name);
  });
  return Object.keys(map).map(k => [k, map[k]]);
}
function rosterNames_(c) {
  return Array.isArray(c.settings.teams) ? [].concat.apply([], c.settings.teams.map(t => (t[1] || []).map(String))) : [];
}
function allNames_(c) {
  const set = {};
  rosterTeams_(c).forEach(t => t[1].forEach(n => { set[n] = 1; }));
  Object.keys(c.data).forEach(n => { set[n] = 1; });
  c.reqs.forEach(r => { set[r.name] = 1; });
  return Object.keys(set);
}
function pickDates_(data, dateSet) {
  const out = {};
  Object.keys(data).forEach(n => {
    const o = {};
    Object.keys(data[n] || {}).forEach(d => { if (dateSet.has(d)) o[d] = data[n][d]; });
    out[n] = o;
  });
  return out;
}
function publicReq_(r) {
  return { id: r.id, name: r.name, date: r.date, type: r.type, kind: r.kind, fromDate: r.fromDate, status: r.status, createdAt: r.createdAt };
}
// 申請してよいかの確認（エラーなら理由の文、よければ null）
function checkRequest_(c, name, req, admin, force) {
  if (!c.dates.length) return '申請の期間がまだ決まっていません。';
  const md = iso => Number(iso.slice(5, 7)) + '/' + Number(iso.slice(8, 10));
  const date = req.date;
  if (!c.dateSet.has(date)) return 'この日は申請の期間に入っていません。';
  const rest = isRestDay_(c, date);
  const round = roundFor_(c.wf, rest);
  const status = round ? round.status : 'before';
  if (!admin && status !== 'open' && status !== 'adjust')
    return (rest ? '土日祝' : '平日') + 'の申請は' + (status === 'closed' ? '締め切りました' : 'まだ受け付けていません') + '。';
  // 調整期間は、人数を超えた日に申請している人だけが変更できる
  if (!admin && status === 'adjust' && ((c.wf.involved || {})[round.id] || []).indexOf(name) < 0)
    return '今は調整期間です。人数を超えた日に申請していた人だけが申請を変更できます。';
  const mine = c.data[name] || {};
  const effOf = effective_(c);
  if (req.kind === 'move') {
    if (c.wf.flow !== 'duty_first') return '振休の移動は「当番が先」の流れのときだけ申請できます。';
    if (rest) return '振休は平日にだけ移動できます。';
    if (!isMovableFuri_(mine[req.fromDate])) return '移動元に、日付つきの振休がありません。';
    if (req.fromDate === date) return '移動先には別の日を選んでください。';
    if (c.reqs.some(r => r.name === name && r.kind === 'leave' && r.date === date)) return md(date) + 'にはすでに希望休を申請しています。';
  } else {
    const allowed = rest ? ['×'].concat(admin ? ADMIN_ONLY_TYPES : []) : weekdayTypes_(c.wf, admin);
    if (allowed.indexOf(req.type) < 0)
      return ADMIN_ONLY_TYPES.indexOf(req.type) >= 0 ? '「' + req.type + '」は本人では申請できません。システム管理者に依頼してください。' : 'この日には「' + req.type + '」は申請できません。';
  }
  // 勤務表（日直・夜勤・振休など）がすでに入っている日は選べない
  if (mine[date] && !force)
    return md(date) + 'は勤務表に' + (admin || c.wf.published ? '「' + mine[date] + '」' : '予定') + 'が入っているため申請できません。休みたい場合は勤務変更（交代）で対応します。';
  // 受付期間中は5人を超えても申請できる（超えた日は全員に注意を出す）。
  // 調整期間中は、新しく休みを入れる日は5人未満の日だけ（超過を増やさない）
  const newMark = req.kind === 'move' ? mine[req.fromDate] : req.type;
  if (!admin && status === 'adjust' && !rest && isCountMark_(newMark)) {
    const others = allNames_(c).filter(n => n !== name && isCountMark_(effOf(n)[date])).length;
    if (others >= DAY_CAP) return '調整期間中は、休みが' + DAY_CAP + '人未満の日にだけ移せます（' + md(date) + 'はすでに' + others + '人）。';
  }
  return null;
}
