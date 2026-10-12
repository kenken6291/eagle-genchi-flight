/******************************************************************
 * 現地集合フライト（eagle-genchi-flight）
 * 「イーグル隊長の空中散歩」連動型 仮想イベント＆目的地フライト
 * Google Apps Script バックエンド
 *
 * ■ スクリプトプロパティ（プロジェクトの設定 → スクリプト プロパティ）
 *   GEMINI_API_KEY   : 必須  Gemini APIキー
 *   GOOGLE_MAPS_API_KEY : 任意  Google Maps APIキー（Maps Embed API。ログイン済み会員にのみ返す）
 *   GEMINI_MODEL     : 任意  既定 gemini-2.5-flash
 *   TTS_MODEL        : 任意  既定 gemini-2.5-flash-preview-tts
 *   TTS_VOICE        : 任意  既定 Puck
 *   TTS_FOLDER_ID    : 任意  生成音声(wav)をキャッシュ保存するDriveフォルダID
 *   SPREADSHEET_ID   : 任意  スタンドアロンGASの場合のみ（コンテナバインドなら不要）
 *   ADMIN_EMAILS     : 任意  管理者メール（カンマ区切り）
 *   SHOW_TEMP_PASSWORD : 任意  'true' で新規登録時に仮PWを画面にも表示
 *   PEPPER           : setup() が自動生成（変更するとログイン不可になるので注意）
 *
 * ■ 初回：エディタで setup() を実行 → デプロイ → ウェブアプリ
 *   （実行ユーザー：自分 / アクセス：全員）
 * ■ コード変更後は「デプロイを管理 → 編集 → 新バージョン」で再デプロイが必要
 ******************************************************************/

const APP = { NAME: '現地集合フライト', VERSION: 'v1.2.0', BUILD: '20261013' };

const SHEET_DEF = {
  Users: ['email', 'nickname', 'salt', 'hash', 'mustChange', 'role', 'status',
          'failCount', 'lockedUntil', 'avatar', 'createdAt', 'lastLogin'],
  Spots: ['spot_id', 'name', 'lat', 'lng', 'description', 'category',
          'flight_video_url', 'activity_tags', 'image_url', 'source', 'createdAt', 'updatedAt'],
  ActivityLogs: ['id', 'ts', 'spot_id', 'email', 'nickname', 'type', 'payload'],
  Presence: ['key', 'spot_id', 'email', 'nickname', 'avatar', 'x', 'y', 'lastSeen']
};

const CATEGORIES = ['BBQ', '音楽', '観光', '自然', 'グルメ', '夜景', 'その他'];
const SESSION_TTL_SEC = 21600;          // 6時間（CacheService上限）
const PRESENCE_TIMEOUT_MS = 45000;      // 45秒応答なしで退出扱い
const LOCK_LIMIT = 5;
const LOCK_MINUTES = 15;
const NPC_INTERVAL_SEC = 35;
const LOG_KEEP_DAYS = 7;

const CAPTAIN =
  'あなたは「イーグル隊長」。陽気で頼れる鷲の隊長です。一人称は「ワシ」、語尾は「〜じゃ！」「〜じゃぞ」。' +
  '乗客を「隊員諸君」と呼びます。50〜60代のアクティブな大人に向けて、明るく、わかりやすく話します。';

// フロントの config.js の NPCS と id を合わせること
const NPCS = [
  { id: 'take',  name: '焼き肉奉行タケさん', persona: 'BBQにうるさい陽気な60代男性。焼き加減に一家言ある' },
  { id: 'miko',  name: '歌好きミーコ',       persona: '歌とダンスが大好きな明るい50代女性。すぐ歌い出す' },
  { id: 'ponta', name: '旅人ポン太',         persona: '全国を旅する物知りなタヌキ。土地の豆知識を話す' }
];

/* =================================================================
 * エントリポイント
 * ================================================================= */
function doGet(e) {
  return json_({ ok: true, app: APP.NAME, version: APP.VERSION, build: APP.BUILD, time: Date.now() });
}

function doPost(e) {
  let res;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const fn = ROUTES[req.action];
    if (!fn) fail_('unknown_action', '不明な操作です: ' + req.action);
    res = fn(req) || {};
    res.ok = true;
  } catch (err) {
    res = {
      ok: false,
      error: err.code || 'server_error',
      message: err.userMessage || ('サーバーエラー: ' + (err.message || err))
    };
    if (!err.code) console.error(err && err.stack || err);
  }
  return json_(res);
}

const ROUTES = {
  // 認証
  register: register_,
  login: login_,
  logout: logout_,
  me: me_,
  changePassword: changePassword_,
  resetPassword: resetPassword_,
  updateProfile: updateProfile_,
  clientConfig: clientConfig_,
  // スポット
  getSpots: getSpots_,
  upsertSpot: upsertSpot_,
  deleteSpot: deleteSpot_,
  deleteSpotsBySource: deleteSpotsBySource_,
  importPreview: importPreview_,
  importCommit: importCommit_,
  // エンタメ・AI
  recommend: recommend_,
  narration: narration_,
  speak: speak_,
  // 現地広場
  plazaJoin: plazaJoin_,
  plazaPoll: plazaPoll_,
  plazaPost: plazaPost_,
  plazaLeave: plazaLeave_,
  npcTick: npcTick_
};

/* =================================================================
 * 初期化・メンテナンス
 * ================================================================= */
function setup() {
  Object.keys(SHEET_DEF).forEach(name => sheet_(name));
  // ハッシュや絵文字が数値・日付に化けないよう文字列書式に
  sheet_('Users').getRange('A:J').setNumberFormat('@');
  sheet_('Spots').getRange('A:A').setNumberFormat('@');
  if (!prop_('PEPPER', '')) {
    props_().setProperty('PEPPER', Utilities.getUuid() + Utilities.getUuid());
  }
  Logger.log('セットアップ完了: ' + ss_().getUrl());
}

/** 時間主導型トリガー（1日1回推奨）で実行：古いログ・在室情報を掃除 */
function cleanupLogs() {
  withLock_(() => {
    const sh = sheet_('ActivityLogs');
    const last = sh.getLastRow();
    if (last >= 2) {
      const cutoff = Date.now() - LOG_KEEP_DAYS * 86400000;
      const ts = sh.getRange(2, 2, last - 1, 1).getValues();
      let n = 0;
      while (n < ts.length && Number(ts[n][0]) < cutoff) n++;
      if (n > 0) sh.deleteRows(2, n);
    }
    const p = sheet_('Presence');
    const rows = readAll_('Presence');
    const old = Date.now() - 86400000;
    rows.filter(r => Number(r.lastSeen) < old)
        .map(r => r._row).sort((a, b) => b - a)
        .forEach(row => p.deleteRow(row));
  });
}

/* =================================================================
 * 認証
 * ================================================================= */
function register_(req) {
  const email = normEmail_(req.email);
  const nickname = String(req.nickname || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail_('bad_email', 'メールアドレスの形式が正しくありません');
  if (!nickname || nickname.length > 20) fail_('bad_nickname', 'ニックネームは1〜20文字で入力してください');

  return withLock_(() => {
    if (findUser_(email)) {
      fail_('exists', 'このメールアドレスは登録済みです。ログインするか、パスワード再発行をご利用ください');
    }
    const temp = tempPassword_();
    const salt = Utilities.getUuid();
    appendObj_('Users', {
      email, nickname, salt,
      hash: hash_(temp, salt),
      mustChange: 'TRUE',
      role: adminList_().indexOf(email) >= 0 ? 'admin' : 'member',
      status: 'active',
      failCount: 0, lockedUntil: '',
      avatar: '🙂',
      createdAt: new Date(), lastLogin: ''
    });
    const sent = sendMail_(email, '【' + APP.NAME + '】仮パスワードのお知らせ',
      nickname + ' 様\n\n' + APP.NAME + 'へようこそ！イーグル隊長がお待ちしております。\n\n' +
      '仮パスワード： ' + temp + '\n\n' +
      '初回ログイン時に新しいパスワードの設定をお願いします。\n' +
      '※このメールに心当たりがない場合は破棄してください。');
    const res = {
      message: sent
        ? '仮パスワードをメールで送りました。届いたパスワードでログインしてください'
        : 'メール送信に失敗したため、画面に仮パスワードを表示します'
    };
    if (!sent || prop_('SHOW_TEMP_PASSWORD', 'false') === 'true') res.tempPassword = temp;
    return res;
  });
}

function login_(req) {
  const email = normEmail_(req.email);
  const pw = String(req.password || '');
  const generic = 'メールアドレスまたはパスワードが違います';
  const u = findUser_(email);
  if (!u) fail_('bad_login', generic);
  if (u.status === 'suspended') fail_('suspended', 'このアカウントは利用停止中です');

  const now = Date.now();
  if (u.lockedUntil && Number(u.lockedUntil) > now) {
    fail_('locked', 'ログイン失敗が続いたためロック中です。' +
      Math.ceil((Number(u.lockedUntil) - now) / 60000) + '分後にもう一度お試しください');
  }
  if (hash_(pw, u.salt) !== String(u.hash)) {
    const fc = Number(u.failCount || 0) + 1;
    if (fc >= LOCK_LIMIT) {
      updateObj_('Users', u._row, { failCount: 0, lockedUntil: String(now + LOCK_MINUTES * 60000) });
      fail_('locked', LOCK_LIMIT + '回続けて失敗したため' + LOCK_MINUTES + '分間ロックしました');
    }
    updateObj_('Users', u._row, { failCount: fc });
    fail_('bad_login', generic + '（あと' + (LOCK_LIMIT - fc) + '回でロック）');
  }
  updateObj_('Users', u._row, { failCount: 0, lockedUntil: '', lastLogin: new Date() });
  const token = newSession_(email);
  return { token, user: publicUser_(u), mustChange: isTrue_(u.mustChange) };
}

function logout_(req) {
  if (req.token) CacheService.getScriptCache().remove('s_' + req.token);
  return {};
}

function me_(req) {
  const u = auth_(req, true);
  return { user: publicUser_(u) };
}

function changePassword_(req) {
  const u = auth_(req, true);
  const cur = String(req.current || '');
  const next = String(req.newPassword || '');
  if (hash_(cur, u.salt) !== String(u.hash)) fail_('bad_current', '現在のパスワード（仮パスワード）が違います');
  if (next.length < 8 || !/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) {
    fail_('weak_password', '新しいパスワードは英字と数字を含む8文字以上にしてください');
  }
  if (next === cur) fail_('same_password', '現在と異なるパスワードを設定してください');
  const salt = Utilities.getUuid();
  updateObj_('Users', u._row, { salt, hash: hash_(next, salt), mustChange: 'FALSE' });
  const fresh = findUser_(u.email);
  return { user: publicUser_(fresh), message: 'パスワードを変更しました' };
}

function resetPassword_(req) {
  const email = normEmail_(req.email);
  const msg = '登録済みのメールアドレスであれば、新しい仮パスワードを送りました。メールをご確認ください';
  withLock_(() => {
    const u = findUser_(email);
    if (!u || u.status === 'suspended') return;
    const temp = tempPassword_();
    const salt = Utilities.getUuid();
    updateObj_('Users', u._row, {
      salt, hash: hash_(temp, salt), mustChange: 'TRUE', failCount: 0, lockedUntil: ''
    });
    sendMail_(email, '【' + APP.NAME + '】仮パスワード再発行のお知らせ',
      u.nickname + ' 様\n\n新しい仮パスワード： ' + temp +
      '\n\nログイン後、新しいパスワードを設定してください。\n' +
      '※心当たりがない場合は、このメールを破棄してください（従来のパスワードは無効になっています）。');
  });
  return { message: msg };
}

function updateProfile_(req) {
  const u = auth_(req);
  const patch = {};
  if (req.nickname != null) {
    const n = String(req.nickname).trim();
    if (!n || n.length > 20) fail_('bad_nickname', 'ニックネームは1〜20文字で入力してください');
    patch.nickname = n;
  }
  if (req.avatar != null) patch.avatar = String(req.avatar).slice(0, 8);
  updateObj_('Users', u._row, patch);
  return { user: publicUser_(findUser_(u.email)), message: 'プロフィールを更新しました' };
}

/** フロントに渡してよい設定値（ログイン済みのみ）。
 *  ※ブラウザで使うキーは通信上は見えるため、GCPでHTTPリファラー制限を必ず設定すること */
function clientConfig_(req) {
  auth_(req);
  return {
    mapsApiKey: prop_('GOOGLE_MAPS_API_KEY', ''),
    version: APP.VERSION,
    build: APP.BUILD
  };
}

/* ---------- 認証ヘルパ ---------- */
function auth_(req, allowMustChange) {
  const t = String(req.token || '');
  const cache = CacheService.getScriptCache();
  const raw = t && cache.get('s_' + t);
  if (!raw) fail_('auth_required', 'ログインの有効期限が切れました。もう一度ログインしてください');
  cache.put('s_' + t, raw, SESSION_TTL_SEC); // スライド延長
  const u = findUser_(JSON.parse(raw).email);
  if (!u || u.status === 'suspended') fail_('auth_required', 'アカウントが見つかりません。もう一度ログインしてください');
  if (!allowMustChange && isTrue_(u.mustChange)) fail_('must_change', '新しいパスワードを設定してください');
  return u;
}

function requireAdmin_(req) {
  const u = auth_(req);
  if (!isAdmin_(u)) fail_('forbidden', '管理者のみ利用できる機能です');
  return u;
}

function newSession_(email) {
  const token = Utilities.getUuid() + '-' + Utilities.getUuid();
  CacheService.getScriptCache().put('s_' + token, JSON.stringify({ email }), SESSION_TTL_SEC);
  return token;
}

function hash_(pw, salt) {
  const pepper = prop_('PEPPER', '');
  let h = String(salt) + ':' + String(pw) + ':' + pepper;
  for (let i = 0; i < 200; i++) {
    h = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + pepper, Utilities.Charset.UTF_8));
  }
  return 'h' + h; // 先頭に文字を付けて数値化を防止
}

function tempPassword_() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 10; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s.replace(/^(.{9})./, '$1' + (Math.floor(Math.random() * 8) + 2)); // 数字を必ず含める
}

function findUser_(email) {
  email = normEmail_(email);
  if (!email) return null;
  return readAll_('Users').find(r => normEmail_(r.email) === email) || null;
}

function publicUser_(u) {
  return {
    email: u.email,
    nickname: u.nickname,
    avatar: u.avatar || '🙂',
    role: isAdmin_(u) ? 'admin' : 'member',
    mustChange: isTrue_(u.mustChange)
  };
}

function isAdmin_(u) {
  return u.role === 'admin' || adminList_().indexOf(normEmail_(u.email)) >= 0;
}

function adminList_() {
  return prop_('ADMIN_EMAILS', '').split(',').map(s => normEmail_(s)).filter(Boolean);
}

/* =================================================================
 * スポット
 * ================================================================= */
function getSpots_(req) {
  auth_(req);
  return { spots: allSpots_(), categories: CATEGORIES };
}

function allSpots_() {
  return readAll_('Spots').map(spotOut_).filter(s => s.spot_id && s.name);
}

function spotOut_(r) {
  return {
    spot_id: String(r.spot_id),
    name: String(r.name || ''),
    lat: Number(r.lat),
    lng: Number(r.lng),
    description: String(r.description || ''),
    category: CATEGORIES.indexOf(r.category) >= 0 ? r.category : 'その他',
    flight_video_url: String(r.flight_video_url || ''),
    activity_tags: String(r.activity_tags || '').split(',').map(s => s.trim()).filter(Boolean),
    image_url: String(r.image_url || ''),
    source: String(r.source || '')
  };
}

function getSpot_(id) {
  const r = readAll_('Spots').find(x => String(x.spot_id) === String(id));
  if (!r) fail_('not_found', 'スポットが見つかりません');
  return spotOut_(r);
}

function upsertSpot_(req) {
  requireAdmin_(req);
  const s = sanitizeSpot_(req.spot || {});
  if (!s.name) fail_('bad_spot', 'スポット名は必須です');
  if (!isFinite(s.lat) || !isFinite(s.lng)) fail_('bad_spot', '緯度・経度を数値で入力してください');
  return withLock_(() => {
    const rows = readAll_('Spots');
    const hit = s.spot_id && rows.find(r => String(r.spot_id) === String(s.spot_id));
    const now = new Date();
    if (hit) {
      updateObj_('Spots', hit._row, Object.assign({}, s, { updatedAt: now }));
    } else {
      s.spot_id = s.spot_id || newId_('S');
      appendObj_('Spots', Object.assign({ source: 'manual', createdAt: now, updatedAt: now }, s));
    }
    return { spot: getSpot_(s.spot_id), message: '保存しました' };
  });
}

function deleteSpot_(req) {
  requireAdmin_(req);
  return withLock_(() => {
    const hit = readAll_('Spots').find(r => String(r.spot_id) === String(req.spot_id));
    if (!hit) fail_('not_found', 'スポットが見つかりません');
    sheet_('Spots').deleteRow(hit._row);
    return { message: '削除しました' };
  });
}

function deleteSpotsBySource_(req) {
  requireAdmin_(req);
  const src = String(req.source || '');
  if (!src) fail_('bad_source', '取り込み元を指定してください');
  return withLock_(() => {
    const rows = readAll_('Spots').filter(r => String(r.source) === src).map(r => r._row).sort((a, b) => b - a);
    const sh = sheet_('Spots');
    rows.forEach(row => sh.deleteRow(row));
    return { deleted: rows.length, message: rows.length + '件削除しました' };
  });
}

/** 外部テキスト / URL / CSV / JSON / 自然文 → Geminiでスポット配列に整形（登録はしない） */
function importPreview_(req) {
  requireAdmin_(req);
  let src = String(req.text || '').slice(0, 30000);
  if (req.url) {
    const url = String(req.url).trim();
    if (!/^https?:\/\//.test(url)) fail_('bad_url', 'URLは http(s):// から入力してください');
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    if (res.getResponseCode() >= 400) fail_('fetch_error', 'URLを取得できませんでした（' + res.getResponseCode() + '）');
    src += '\n\n[URLの内容]\n' + stripHtml_(res.getContentText()).slice(0, 20000);
  }
  if (!src.trim()) fail_('empty', '取り込む内容を入力してください');

  const prompt =
    '次の入力から、仮想フライトの目的地となるスポットを抽出し、JSON配列だけを返してください。\n' +
    '入力が「日本の絶景BBQスポット5選」のような依頼文なら、実在するスポットを指定数（指定がなければ5件）選んで作成してください。\n' +
    '最大30件。各要素のキー：\n' +
    '- name: スポット名\n' +
    '- lat, lng: 数値（入力に無ければその場所の代表的な座標を推定）\n' +
    '- description: 80字以内の紹介文\n' +
    '- category: 次のいずれか ' + JSON.stringify(CATEGORIES) + '\n' +
    '- activity_tags: 文字列配列（bbq, dance, sing, talk, stargazing, photo, walk, onsen などから該当するもの）\n' +
    '- flight_video_url: 入力に動画URLやGoogleドライブIDが含まれていればそれ、無ければ空文字\n' +
    '- image_url: 入力に画像URLがあればそれ、無ければ空文字\n\n' +
    '[入力]\n' + src;

  const arr = geminiJson_(prompt, 0.4);
  if (!Array.isArray(arr)) fail_('parse_error', 'スポット一覧として読み取れませんでした。入力を見直してください');
  const items = arr.map(sanitizeSpot_).filter(s => s.name && isFinite(s.lat) && isFinite(s.lng)).slice(0, 30);
  return { items, count: items.length };
}

function importCommit_(req) {
  requireAdmin_(req);
  const items = Array.isArray(req.items) ? req.items : [];
  if (!items.length) fail_('empty', '登録するスポットがありません');
  const source = String(req.source || ('import_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmm'))).slice(0, 40);
  return withLock_(() => {
    const exist = readAll_('Spots');
    const now = new Date();
    let added = 0, skipped = 0;
    const sh = sheet_('Spots');
    const rows = [];
    items.map(sanitizeSpot_).forEach(s => {
      if (!s.name || !isFinite(s.lat) || !isFinite(s.lng)) { skipped++; return; }
      const dup = exist.some(r => r.name === s.name && Math.abs(Number(r.lat) - s.lat) < 0.01 && Math.abs(Number(r.lng) - s.lng) < 0.01);
      if (dup) { skipped++; return; }
      s.spot_id = newId_('S');
      const obj = Object.assign({}, s, { source, createdAt: now, updatedAt: now });
      rows.push(SHEET_DEF.Spots.map(h => obj[h] === undefined ? '' : obj[h]));
      added++;
    });
    if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, SHEET_DEF.Spots.length).setValues(rows);
    return { added, skipped, source, message: added + '件登録しました' + (skipped ? '（重複・不備で' + skipped + '件スキップ）' : '') };
  });
}

function sanitizeSpot_(s) {
  const tags = Array.isArray(s.activity_tags) ? s.activity_tags : String(s.activity_tags || '').split(',');
  return {
    spot_id: s.spot_id ? String(s.spot_id) : '',
    name: String(s.name || '').trim().slice(0, 60),
    lat: Number(s.lat),
    lng: Number(s.lng),
    description: String(s.description || '').trim().slice(0, 200),
    category: CATEGORIES.indexOf(s.category) >= 0 ? s.category : 'その他',
    flight_video_url: String(s.flight_video_url || '').trim(),
    activity_tags: tags.map(t => String(t).trim()).filter(Boolean).slice(0, 10).join(','),
    image_url: String(s.image_url || '').trim()
  };
}

/* =================================================================
 * エンタメ選定・ナビ音声
 * ================================================================= */
function recommend_(req) {
  auth_(req);
  const mood = String(req.mood || '').trim().slice(0, 200);
  if (!mood) fail_('empty', '今日の気分を入力してください');
  const spots = allSpots_();
  if (!spots.length) fail_('no_spots', 'スポットがまだ登録されていません');
  const list = spots.map(s => ({ id: s.spot_id, name: s.name, category: s.category, tags: s.activity_tags, desc: s.description.slice(0, 50) }));
  const prompt = CAPTAIN + '\n\n' +
    '隊員の今日の気分：「' + mood + '」\n' +
    '次の候補から最もふさわしいスポットを1つ選び、JSONだけで返してください。\n' +
    '{"spot_id": "候補のid", "message": "隊長口調で選んだ理由と誘い文句（100字以内）"}\n\n' +
    '[候補]\n' + JSON.stringify(list);
  const r = geminiJson_(prompt, 0.9) || {};
  const pick = spots.find(s => s.spot_id === String(r.spot_id)) || spots[Math.floor(Math.random() * spots.length)];
  return { spot_id: pick.spot_id, message: String(r.message || '風がそっちへ吹いておる！行ってみるのじゃ！') };
}

/** mode: flight（通常フライト）/ mystery（目的地を伏せたヒント）/ arrival（現地実況） */
function narration_(req) {
  auth_(req);
  const spot = getSpot_(req.spot_id);
  const mode = ['flight', 'mystery', 'arrival'].indexOf(req.mode) >= 0 ? req.mode : 'flight';
  const cache = CacheService.getScriptCache();
  const cacheKey = 'nar_' + mode + '_' + spot.spot_id;
  let script = mode !== 'arrival' ? cache.get(cacheKey) : null;

  if (!script) {
    const info = '[スポット情報] ' + JSON.stringify({ name: spot.name, category: spot.category, desc: spot.description, tags: spot.activity_tags });
    const tasks = {
      flight: 'これから隊員を足につかまらせて「' + spot.name + '」へ飛ぶ、フライト案内のセリフを書いてください。' +
              '離陸のかけ声→上空から見える景色→現地の見どころ→まもなく到着、の順で200〜260字。',
      mystery: '目的地は隊員に秘密のミステリーフライトです。スポット名・地名・都道府県名・固有名詞は絶対に出さず、' +
               'だんだん具体的になるヒントを3つ織り込んだ案内を200字程度で。最後は「さあ、どこじゃと思う？」で締めてください。',
      arrival: '「' + spot.name + '」の現地広場に到着した隊員たちを迎える実況セリフを120字程度で。' +
               '現地でできること（' + (spot.activity_tags.join('・') || '交流') + '）に触れ、BBQや歌、ダンスに誘ってください。'
    };
    script = gemini_(CAPTAIN + '\n\n' + tasks[mode] + '\n読み上げ用なので記号・絵文字・括弧書きは使わず、セリフ本文だけを出力。\n\n' + info, 0.9)
      .replace(/[*#「」]/g, '').trim();
    if (mode !== 'arrival') cache.put(cacheKey, script, 21600);
  }

  const out = { script };
  if (req.withAudio !== false) {
    try { out.audio = tts_(script); }
    catch (e) { out.audioError = e.userMessage || String(e.message || e); }
  }
  return out;
}

function speak_(req) {
  auth_(req);
  const text = String(req.text || '').trim().slice(0, 300);
  if (!text) fail_('empty', '読み上げる文章がありません');
  return { audio: tts_(text) };
}

/* =================================================================
 * 現地バーチャル合流広場（ポーリング方式）
 * ================================================================= */
function plazaJoin_(req) {
  const u = auth_(req);
  const spotId = String(req.spot_id || '');
  getSpot_(spotId);
  withLock_(() => {
    touchPresence_(u, spotId, { x: req.x, y: req.y }, true);
    appendLog_(spotId, u.email, u.nickname, 'join', { avatar: u.avatar || '🙂' });
  });
  return {
    me: memberId_(u.email),
    members: members_(spotId),
    logs: recentLogs_(spotId, Date.now() - 30 * 60000, 30),
    serverTs: Date.now()
  };
}

function plazaPoll_(req) {
  const u = auth_(req);
  const spotId = String(req.spot_id || '');
  const since = Number(req.since || 0);
  const rows = readAll_('Presence');
  const mine = rows.find(r => r.key === spotId + '|' + normEmail_(u.email));
  if (!mine || Date.now() - Number(mine.lastSeen) > 15000) {
    withLock_(() => touchPresence_(u, spotId, null, false));
  }
  return { members: members_(spotId), logs: recentLogs_(spotId, since, 60), serverTs: Date.now() };
}

/** type: chat / action / move */
function plazaPost_(req) {
  const u = auth_(req);
  const spotId = String(req.spot_id || '');
  const type = String(req.type || '');
  const payload = req.payload || {};
  return withLock_(() => {
    if (type === 'move') {
      touchPresence_(u, spotId, { x: payload.x, y: payload.y }, true);
      return {};
    }
    if (type === 'chat') {
      const text = String(payload.text || '').trim().slice(0, 140);
      if (!text) fail_('empty', 'メッセージを入力してください');
      return { id: appendLog_(spotId, u.email, u.nickname, 'chat', { text }) };
    }
    if (type === 'action') {
      const id = String(payload.id || '').slice(0, 20);
      return { id: appendLog_(spotId, u.email, u.nickname, 'action', { id, song: Number(payload.song || 0) }) };
    }
    fail_('bad_type', '不明な操作です');
  });
}

function plazaLeave_(req) {
  const u = auth_(req);
  const spotId = String(req.spot_id || '');
  withLock_(() => {
    const p = readAll_('Presence').find(r => r.key === spotId + '|' + normEmail_(u.email));
    if (p) updateObj_('Presence', p._row, { lastSeen: 0 });
    appendLog_(spotId, u.email, u.nickname, 'leave', {});
  });
  return {};
}

/** NPC参加者の自動賑やかし（35秒に1回まで / スポット単位） */
function npcTick_(req) {
  auth_(req);
  const spotId = String(req.spot_id || '');
  const cache = CacheService.getScriptCache();
  const key = 'npc_' + spotId;
  if (cache.get(key)) return { skipped: true };
  cache.put(key, '1', NPC_INTERVAL_SEC);

  const spot = getSpot_(spotId);
  const recent = recentLogs_(spotId, Date.now() - 10 * 60000, 12)
    .filter(l => l.type === 'chat' || l.type === 'npc')
    .map(l => l.nickname + '：' + (l.payload.text || ''));
  const prompt =
    'バーチャル現地広場「' + spot.name + '」（' + spot.category + '、' + spot.description + '）で交流が行われています。\n' +
    '次のNPC参加者から1人選び、場を盛り上げる次の一言を作ってください。直前の会話があれば自然に反応すること。\n' +
    'NPC: ' + JSON.stringify(NPCS) + '\n' +
    '直前の会話: ' + JSON.stringify(recent) + '\n' +
    'JSONだけで返す：{"npc_id":"take|miko|ponta","text":"40字以内のセリフ","action":"bbq|dance|sing|wave|cheer|none"}';
  const r = geminiJson_(prompt, 1.0) || {};
  const npc = NPCS.find(n => n.id === r.npc_id) || NPCS[Math.floor(Math.random() * NPCS.length)];
  const payload = {
    npc_id: npc.id,
    text: String(r.text || 'いい雰囲気ですねぇ！').slice(0, 60),
    action: ['bbq', 'dance', 'sing', 'wave', 'cheer'].indexOf(r.action) >= 0 ? r.action : 'none'
  };
  const id = withLock_(() => appendLog_(spotId, 'npc:' + npc.id, npc.name, 'npc', payload));
  return { log: { id, ts: Date.now(), member: 'npc:' + npc.id, nickname: npc.name, type: 'npc', payload } };
}

/* ---------- 広場ヘルパ ---------- */
function touchPresence_(u, spotId, pos, force) {
  const key = spotId + '|' + normEmail_(u.email);
  const p = readAll_('Presence').find(r => r.key === key);
  const obj = { key, spot_id: spotId, email: normEmail_(u.email), nickname: u.nickname, avatar: u.avatar || '🙂', lastSeen: Date.now() };
  if (pos && isFinite(Number(pos.x)) && isFinite(Number(pos.y))) {
    obj.x = clamp_(Number(pos.x), 3, 97);
    obj.y = clamp_(Number(pos.y), 45, 95);
  }
  if (p) updateObj_('Presence', p._row, obj);
  else appendObj_('Presence', Object.assign({ x: 50, y: 70 }, obj));
}

function members_(spotId) {
  const limit = Date.now() - PRESENCE_TIMEOUT_MS;
  return readAll_('Presence')
    .filter(r => String(r.spot_id) === spotId && Number(r.lastSeen) > limit)
    .map(r => ({ id: memberId_(r.email), nickname: r.nickname, avatar: r.avatar || '🙂', x: Number(r.x), y: Number(r.y) }));
}

function appendLog_(spotId, email, nickname, type, payload) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  appendObj_('ActivityLogs', { id, ts: Date.now(), spot_id: spotId, email, nickname, type, payload: JSON.stringify(payload || {}) });
  return id;
}

function recentLogs_(spotId, since, limit) {
  const sh = sheet_('ActivityLogs');
  const last = sh.getLastRow();
  if (last < 2) return [];
  const n = Math.min(400, last - 1);
  const vals = sh.getRange(last - n + 1, 1, n, SHEET_DEF.ActivityLogs.length).getValues();
  return vals
    .filter(r => String(r[2]) === spotId && Number(r[1]) > since)
    .slice(-limit)
    .map(r => ({
      id: String(r[0]), ts: Number(r[1]), member: memberId_(r[3]),
      nickname: String(r[4]), type: String(r[5]), payload: safeJson_(r[6])
    }));
}

/** メールアドレスを他の参加者に見せないための匿名ID */
function memberId_(email) {
  email = String(email || '');
  if (email.indexOf('npc:') === 0) return email;
  return 'm' + hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, normEmail_(email) + prop_('PEPPER', ''))).slice(0, 12);
}

/* =================================================================
 * Gemini / TTS
 * ================================================================= */
function gemini_(prompt, temperature, asJson) {
  const key = prop_('GEMINI_API_KEY', '');
  if (!key) fail_('no_key', 'GEMINI_API_KEY が未設定です（スクリプトプロパティ）');
  const model = prop_('GEMINI_MODEL', 'gemini-2.5-flash');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key;
  const gen = { temperature: temperature == null ? 0.7 : temperature };
  if (asJson) gen.responseMimeType = 'application/json';
  const res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: gen })
  });
  if (res.getResponseCode() !== 200) {
    console.error(res.getContentText());
    fail_('gemini_error', 'AIの応答に失敗しました（' + res.getResponseCode() + '）。しばらくしてからお試しください');
  }
  const body = JSON.parse(res.getContentText());
  const parts = (((body.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map(p => p.text || '').join('');
}

function geminiJson_(prompt, temperature) {
  const text = gemini_(prompt, temperature, true).replace(/```json|```/g, '').trim();
  try { return JSON.parse(text); }
  catch (e) {
    const m = text.match(/[\[{][\s\S]*[\]}]/);
    if (m) { try { return JSON.parse(m[0]); } catch (e2) { /* fallthrough */ } }
    fail_('parse_error', 'AIの応答を読み取れませんでした。もう一度お試しください');
  }
}

/** Gemini TTS → PCM(24kHz/16bit/mono) を WAV に包んで base64 で返す。Driveにキャッシュ */
function tts_(text) {
  const key = prop_('GEMINI_API_KEY', '');
  if (!key) fail_('no_key', 'GEMINI_API_KEY が未設定です');
  const voice = prop_('TTS_VOICE', 'Puck');
  const model = prop_('TTS_MODEL', 'gemini-2.5-flash-preview-tts');
  const fileName = 'tts_' + hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, voice + '|' + text, Utilities.Charset.UTF_8)) + '.wav';
  const folderId = prop_('TTS_FOLDER_ID', '');

  if (folderId) {
    const it = DriveApp.getFolderById(folderId).getFilesByName(fileName);
    if (it.hasNext()) return { base64: Utilities.base64Encode(it.next().getBlob().getBytes()), mime: 'audio/wav', cached: true };
  }

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key;
  const payload = {
    contents: [{ parts: [{ text: '陽気で頼もしい鷲の隊長として、元気よく、はきはきと、少し早口で読み上げてください：\n' + text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
    }
  };
  const res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    console.error(res.getContentText());
    fail_('tts_error', '音声生成に失敗しました（' + res.getResponseCode() + '）');
  }
  const parts = JSON.parse(res.getContentText()).candidates[0].content.parts;
  const part = parts.find(p => p.inlineData);
  if (!part) fail_('tts_error', '音声データが返りませんでした');
  const rate = Number((String(part.inlineData.mimeType).match(/rate=(\d+)/) || [])[1] || 24000);
  const wav = pcmToWav_(Utilities.base64Decode(part.inlineData.data), rate);

  if (folderId) {
    try { DriveApp.getFolderById(folderId).createFile(Utilities.newBlob(wav, 'audio/wav', fileName)); }
    catch (e) { console.warn('TTSキャッシュ保存失敗: ' + e); }
  }
  return { base64: Utilities.base64Encode(wav), mime: 'audio/wav' };
}

function pcmToWav_(pcm, sampleRate) {
  const ch = 1, bits = 16;
  const h = [];
  const str = s => { for (let i = 0; i < s.length; i++) h.push(s.charCodeAt(i)); };
  const u32 = v => h.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
  const u16 = v => h.push(v & 255, (v >> 8) & 255);
  str('RIFF'); u32(36 + pcm.length); str('WAVE');
  str('fmt '); u32(16); u16(1); u16(ch); u32(sampleRate); u32(sampleRate * ch * bits / 8); u16(ch * bits / 8); u16(bits);
  str('data'); u32(pcm.length);
  return h.map(b => (b > 127 ? b - 256 : b)).concat(pcm);
}

/* =================================================================
 * 共通ユーティリティ
 * ================================================================= */
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function fail_(code, msg) { const e = new Error(msg); e.code = code; e.userMessage = msg; throw e; }
function props_() { return PropertiesService.getScriptProperties(); }
function prop_(k, d) { const v = props_().getProperty(k); return v == null || v === '' ? d : v; }
function ss_() { const id = prop_('SPREADSHEET_ID', ''); return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet(); }

function sheet_(name) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, SHEET_DEF[name].length).setValues([SHEET_DEF[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function readAll_(name) {
  const sh = sheet_(name);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const head = SHEET_DEF[name];
  const vals = sh.getRange(2, 1, last - 1, head.length).getValues();
  return vals.map((r, i) => { const o = { _row: i + 2 }; head.forEach((h, j) => { o[h] = r[j]; }); return o; });
}

function appendObj_(name, obj) {
  sheet_(name).appendRow(SHEET_DEF[name].map(h => (obj[h] === undefined ? '' : obj[h])));
}

function updateObj_(name, row, patch) {
  const sh = sheet_(name);
  const head = SHEET_DEF[name];
  const range = sh.getRange(row, 1, 1, head.length);
  const cur = range.getValues()[0];
  head.forEach((h, j) => { if (patch[h] !== undefined) cur[j] = patch[h]; });
  range.setValues([cur]);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) fail_('busy', '混み合っています。少し待ってからもう一度お試しください');
  try { return fn(); } finally { lock.releaseLock(); }
}

function sendMail_(to, subject, body) {
  try { MailApp.sendEmail({ to, subject, body, name: APP.NAME }); return true; }
  catch (e) { console.warn('メール送信失敗: ' + e); return false; }
}

function stripHtml_(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function hex_(bytes) { return bytes.map(b => ('0' + (b & 255).toString(16)).slice(-2)).join(''); }
function normEmail_(e) { return String(e || '').trim().toLowerCase(); }
function isTrue_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function clamp_(v, a, b) { return Math.max(a, Math.min(b, v)); }
function newId_(p) { return p + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase(); }
function safeJson_(s) { try { return JSON.parse(s || '{}'); } catch (e) { return {}; } }
