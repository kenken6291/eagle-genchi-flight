/******************************************************************
 * 現地集合フライト（eagle-genchi-flight）
 * 「イーグル隊長の空中散歩」連動型 仮想イベント＆目的地フライト
 * Google Apps Script バックエンド
 *
 * ■ スクリプトプロパティ（プロジェクトの設定 → スクリプト プロパティ）
 *   GEMINI_API_KEY   : 必須  Gemini APIキー
 *   ※ Googleマップのリンク解析は組み込みの Maps サービス（キー不要）を使用
 *   GOOGLE_MAPS_API_KEY : 任意  Google Maps APIキー（ブラウザ用。ログイン済み会員にのみ返す）
 *   GOOGLE_MAPS_SERVER_KEY : 任意  サーバー用キー（Street View Static API / Maps Static API。
 *                         ビデオ通話の背景画像をGASで取得するのに使用。リファラー制限なし・API制限あり）
 *   GEMINI_MODEL     : 任意  既定 gemini-2.5-flash
 *   TTS_MODEL        : 任意  既定 gemini-2.5-flash-preview-tts
 *   TTS_VOICE        : 任意  既定 Puck
 *   TTS_FOLDER_ID    : 任意  生成音声(wav)をキャッシュ保存するDriveフォルダID
 *   FACE_FOLDER_ID   : 任意  顔写真の保存先DriveフォルダID（未設定なら自動作成して記録）
 *   SPREADSHEET_ID   : 任意  スタンドアロンGASの場合のみ（コンテナバインドなら不要）
 *   ADMIN_EMAILS     : 任意  管理者メール（カンマ区切り）
 *   SHOW_TEMP_PASSWORD : 任意  'true' で新規登録時に仮PWを画面にも表示
 *   PEPPER           : setup() が自動生成（変更するとログイン不可になるので注意）
 *
 * ■ 初回：エディタで setup() を実行 → デプロイ → ウェブアプリ
 *   （実行ユーザー：自分 / アクセス：全員）
 * ■ コード変更後は「デプロイを管理 → 編集 → 新バージョン」で再デプロイが必要
 ******************************************************************/

const APP = { NAME: '現地集合フライト', VERSION: 'v1.6.0', BUILD: '20261013' };

const SHEET_DEF = {
  Users: ['email', 'nickname', 'salt', 'hash', 'mustChange', 'role', 'status',
          'failCount', 'lockedUntil', 'avatar', 'createdAt', 'lastLogin', 'faces', 'faceVer'],
  Spots: ['spot_id', 'name', 'lat', 'lng', 'description', 'category',
          'flight_video_url', 'activity_tags', 'image_url', 'source', 'createdAt', 'updatedAt',
          'address', 'maps_url'],
  ActivityLogs: ['id', 'ts', 'spot_id', 'email', 'nickname', 'type', 'payload'],
  Presence: ['key', 'spot_id', 'email', 'nickname', 'avatar', 'x', 'y', 'lastSeen', 'expr'],
  Calls: ['id', 'spot_id', 'service', 'url', 'title', 'email', 'nickname', 'createdAt', 'expiresAt', 'status']
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
  saveFaces: saveFaces_,
  deleteFaces: deleteFaces_,
  getFaces: getFaces_,
  clientConfig: clientConfig_,
  // スポット
  getSpots: getSpots_,
  upsertSpot: upsertSpot_,
  deleteSpot: deleteSpot_,
  deleteSpotsBySource: deleteSpotsBySource_,
  importPreview: importPreview_,
  importCommit: importCommit_,
  resolveMapUrl: resolveMapUrl_,
  // エンタメ・AI
  recommend: recommend_,
  narration: narration_,
  speak: speak_,
  // 現地広場
  plazaJoin: plazaJoin_,
  plazaPoll: plazaPoll_,
  plazaPost: plazaPost_,
  plazaLeave: plazaLeave_,
  npcTick: npcTick_,
  // ビデオ通話
  callPost: callPost_,
  callEnd: callEnd_,
  callBackground: callBackground_
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
    mustChange: isTrue_(u.mustChange),
    memberId: memberId_(u.email),
    faceVer: Number(u.faceVer || 0),
    faceExprs: Object.keys(safeJson_(u.faces))
  };
}

/* =================================================================
 * 顔写真（普通・笑顔・困った顔・驚いた顔）
 *   画像は非公開のDriveフォルダに保存し、ログイン中の会員にだけ base64 で配る
 * ================================================================= */
const EXPRS = ['normal', 'smile', 'trouble', 'surprise'];
const FACE_MAX_B64 = 300000; // 1枚あたり約220KBまで（フロントで256px程度に縮小済み）

function faceFolder_() {
  const id = prop_('FACE_FOLDER_ID', '');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* 作り直す */ } }
  const f = DriveApp.createFolder(APP.NAME + '_顔写真');
  props_().setProperty('FACE_FOLDER_ID', f.getId());
  return f;
}

function saveFaces_(req) {
  const u = auth_(req);
  const input = req.faces || {};
  const keys = EXPRS.filter(k => input[k]);
  if (!keys.length) fail_('empty', '保存する顔写真がありません');
  const faces = safeJson_(u.faces);
  const folder = faceFolder_();
  const mid = memberId_(u.email);
  keys.forEach(k => {
    const m = String(input[k]).match(/^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) fail_('bad_image', '画像の形式が正しくありません（JPEG/PNG/WebP）');
    if (m[3].length > FACE_MAX_B64) fail_('too_large', '画像が大きすぎます。撮り直してください');
    if (faces[k]) { try { DriveApp.getFileById(faces[k]).setTrashed(true); } catch (e) { /* 既に無い */ } }
    const blob = Utilities.newBlob(Utilities.base64Decode(m[3]), m[1], 'face_' + mid + '_' + k + '.' + (m[2] === 'jpeg' ? 'jpg' : m[2]));
    faces[k] = folder.createFile(blob).getId();
  });
  updateObj_('Users', u._row, { faces: JSON.stringify(faces), faceVer: Date.now() });
  return { user: publicUser_(findUser_(u.email)), message: '顔写真を保存しました' };
}

function deleteFaces_(req) {
  const u = auth_(req);
  const faces = safeJson_(u.faces);
  Object.keys(faces).forEach(k => { try { DriveApp.getFileById(faces[k]).setTrashed(true); } catch (e) { /* 既に無い */ } });
  updateObj_('Users', u._row, { faces: '', faceVer: 0 });
  return { user: publicUser_(findUser_(u.email)), message: '顔写真を削除しました' };
}

/** ids: 広場のメンバーID（最大30人分）→ { id: { ver, normal, smile, trouble, surprise } } */
function getFaces_(req) {
  auth_(req);
  const want = (Array.isArray(req.ids) ? req.ids : []).map(String).slice(0, 30);
  const out = {};
  if (!want.length) return { faces: out };
  readAll_('Users').forEach(u => {
    const mid = memberId_(u.email);
    if (want.indexOf(mid) < 0 || !Number(u.faceVer)) return;
    const faces = safeJson_(u.faces);
    const item = { ver: Number(u.faceVer) };
    EXPRS.forEach(k => {
      if (!faces[k]) return;
      try {
        const b = DriveApp.getFileById(faces[k]).getBlob();
        item[k] = 'data:' + b.getContentType() + ';base64,' + Utilities.base64Encode(b.getBytes());
      } catch (e) { /* 削除済みなど */ }
    });
    out[mid] = item;
  });
  return { faces: out };
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
    source: String(r.source || ''),
    address: String(r.address || ''),
    maps_url: String(r.maps_url || '')
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
      const source = String((req.spot && req.spot.source) || 'manual').slice(0, 40);
      appendObj_('Spots', Object.assign({ source, createdAt: now, updatedAt: now }, s));
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

  // 貼り付けた中の Googleマップのリンクを先に解析して、正確な座標をAIに渡す
  const links = extractMapsLinks_(src).slice(0, 20);
  const resolved = [];
  links.forEach(u => {
    try { const r = mapsLinkToPlace_(u); if (r) resolved.push(r); }
    catch (e) { console.warn('リンク解析失敗: ' + u + ' ' + e); }
  });
  if (resolved.length) {
    src += '\n\n[Googleマップのリンク解析結果（name・lat・lng・address はこの値をそのまま使うこと）]\n' +
      JSON.stringify(resolved.map(r => ({ name: r.name, lat: r.lat, lng: r.lng, address: r.address })));
  }

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
  // 解析済みリンクと座標が近いものに、地図URLと住所を付ける
  items.forEach(s => {
    const hit = resolved.find(r => Math.abs(r.lat - s.lat) < 0.01 && Math.abs(r.lng - s.lng) < 0.01);
    if (hit) { s.maps_url = hit.maps_url; s.address = s.address || hit.address; }
  });
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

/* =================================================================
 * Googleマップのリンク → 行き先
 *   https://maps.app.goo.gl/xxxx（共有の短縮リンク）
 *   https://www.google.com/maps/place/名前/@35.6,139.7,17z/data=!3d..!4d..
 *   https://maps.google.com/?q=35.6,139.7  など
 * ================================================================= */
function resolveMapUrl_(req) {
  requireAdmin_(req);
  const text = String(req.text || req.url || '').trim();
  const url = extractMapsLinks_(text)[0];
  if (!url) fail_('bad_url', 'Googleマップのリンクが見つかりません。マップの「共有」→「リンクをコピー」で取得したURLを貼り付けてください');
  // 共有テキストに含まれる店名など（URL以外の行）をヒントに使う
  const hint = text.replace(url, ' ').split(/\n/).map(s => s.trim()).filter(Boolean)[0] || '';
  const place = mapsLinkToPlace_(url, hint);
  if (!place) fail_('not_found', 'リンクから場所を読み取れませんでした。別のリンクか、緯度・経度の手入力をお試しください');
  const extra = enrichSpot_(place);
  return { spot: sanitizeSpot_(Object.assign({}, place, extra)) };
}

function extractMapsLinks_(text) {
  const re = /https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|(?:www\.)?google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)[^\s"'<>）」]*/gi;
  const found = String(text || '').match(re) || [];
  return found.filter((u, i) => found.indexOf(u) === i);
}

/** 短縮リンクを展開し、名前・座標・住所を得る */
function mapsLinkToPlace_(url, hint) {
  const longUrl = expandMapsUrl_(url);
  const p = parseMapsUrl_(longUrl);
  let name = p.name || hint || '';
  let lat = p.lat, lng = p.lng, address = '';

  if ((!isFinite(lat) || !isFinite(lng)) && name) {
    const g = geocode_(name);
    if (g) { lat = g.lat; lng = g.lng; address = g.address; }
  }
  if (!isFinite(lat) || !isFinite(lng)) return null;
  if (!address) {
    const rg = reverseGeocode_(lat, lng);
    if (rg) address = rg.address;
  }
  if (!name) name = address || (lat.toFixed(4) + ',' + lng.toFixed(4));
  return { name: name.slice(0, 60), lat: round6_(lat), lng: round6_(lng), address, maps_url: url };
}

function expandMapsUrl_(url) {
  let cur = url;
  for (let i = 0; i < 6; i++) {
    if (!/goo\.gl/.test(cur)) return cur;
    const res = UrlFetchApp.fetch(cur, { followRedirects: false, muteHttpExceptions: true });
    const h = res.getAllHeaders();
    const loc = h.Location || h.location;
    if (loc) { cur = Array.isArray(loc) ? loc[0] : loc; continue; }
    // リダイレクトせずHTMLで返る場合は本文からマップURLを探す
    const m = res.getContentText().match(/https:\/\/www\.google\.[a-z.]+\/maps[^"'\s<>]+/);
    return m ? m[0].replace(/\\u0026/g, '&').replace(/&amp;/g, '&') : cur;
  }
  return cur;
}

function parseMapsUrl_(u) {
  let s = String(u || '');
  try { s = decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { /* そのまま */ }
  const out = { name: '', lat: NaN, lng: NaN };
  let m;
  if ((m = s.match(/\/maps\/place\/([^/@?]+)/))) out.name = m[1].trim();
  else if ((m = s.match(/\/maps\/search\/([^/@?]+)/))) out.name = m[1].trim();
  // 場所そのものの座標（!3d緯度!4d経度）を最優先、次に @中心座標
  if ((m = s.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/))) { out.lat = +m[1]; out.lng = +m[2]; }
  else if ((m = s.match(/[?&](?:q|query|ll|center|destination|daddr)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/))) { out.lat = +m[1]; out.lng = +m[2]; }
  else if ((m = s.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/))) { out.lat = +m[1]; out.lng = +m[2]; }
  if (!out.name && (m = s.match(/[?&](?:q|query)=([^&]+)/)) && !/^-?\d+(\.\d+)?,/.test(m[1])) out.name = m[1].trim();
  // 「緯度,経度」だけの名前は名前として使わない
  if (/^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(out.name)) out.name = '';
  return out;
}

/** Apps Script 組み込みの Maps サービス（APIキー不要） */
function geocode_(q) {
  try {
    const r = Maps.newGeocoder().setLanguage('ja').setRegion('jp').geocode(q);
    const g = r && r.results && r.results[0];
    return g ? { lat: g.geometry.location.lat, lng: g.geometry.location.lng, address: cleanAddress_(g.formatted_address) } : null;
  } catch (e) { console.warn('geocode失敗: ' + e); return null; }
}

function reverseGeocode_(lat, lng) {
  try {
    const r = Maps.newGeocoder().setLanguage('ja').reverseGeocode(lat, lng);
    const g = r && r.results && r.results[0];
    return g ? { address: cleanAddress_(g.formatted_address) } : null;
  } catch (e) { console.warn('reverseGeocode失敗: ' + e); return null; }
}

function cleanAddress_(a) { return String(a || '').replace(/^日本、\s*/, '').replace(/〒\d{3}-\d{4}\s*/, '').trim(); }
function round6_(v) { return Math.round(Number(v) * 1e6) / 1e6; }

/** 名前と住所から紹介文・カテゴリ・アクティビティをGeminiで補う（失敗しても登録は続行） */
function enrichSpot_(place) {
  try {
    const r = geminiJson_(
      '次の場所を、仮想フライトの目的地として紹介します。JSONだけで返してください。\n' +
      '{"description":"80字以内の紹介文","category":"' + CATEGORIES.join('|') + ' のいずれか","activity_tags":["bbq","sing","dance","talk","stargazing","photo","walk","onsen" などから該当するもの]}\n' +
      '場所：' + place.name + '\n住所：' + (place.address || '不明') + '\n座標：' + place.lat + ',' + place.lng, 0.5) || {};
    return { description: r.description || '', category: r.category, activity_tags: r.activity_tags || [] };
  } catch (e) {
    return { description: '', category: 'その他', activity_tags: [] };
  }
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
    image_url: String(s.image_url || '').trim(),
    address: String(s.address || '').trim().slice(0, 120),
    maps_url: String(s.maps_url || '').trim().slice(0, 500)
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
    calls: calls_(spotId, u),
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
  return { members: members_(spotId), logs: recentLogs_(spotId, since, 60), calls: calls_(spotId, u), serverTs: Date.now() };
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
      const expr = EXPRS.indexOf(payload.expr) >= 0 ? payload.expr : '';
      return { id: appendLog_(spotId, u.email, u.nickname, 'chat', { text, expr }) };
    }
    if (type === 'expr') {
      // 自分で選んだ表情（次に変えるまで続く）
      const expr = EXPRS.indexOf(payload.expr) >= 0 ? payload.expr : 'normal';
      const key = spotId + '|' + normEmail_(u.email);
      const p = readAll_('Presence').find(r => r.key === key);
      if (p) updateObj_('Presence', p._row, { expr, lastSeen: Date.now() });
      return {};
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

/* =================================================================
 * 現地ビデオ通話（Google Meet / Zoom / LINE / Facebook Messenger）
 *   通話そのものは各サービスで行い、このアプリでは「現地に通話リンクを掲示」する
 * ================================================================= */
const CALL_SERVICES = [
  { id: 'meet',      name: 'Google Meet', re: /^https:\/\/meet\.google\.com\//i },
  { id: 'zoom',      name: 'Zoom',        re: /^https:\/\/([\w-]+\.)?zoom\.(us|com)\//i },
  { id: 'line',      name: 'LINE',        re: /^https:\/\/(line\.me|lin\.ee|liff\.line\.me)\//i },
  { id: 'messenger', name: 'Messenger',   re: /^https:\/\/(www\.)?(messenger\.com|m\.me|msngr\.com|facebook\.com|fb\.me)\//i }
];
const CALL_TTL_MS = 3 * 3600000; // 3時間で自動的に終了扱い

function detectCallService_(url) {
  return CALL_SERVICES.find(s => s.re.test(url)) || null;
}

function callPost_(req) {
  const u = auth_(req);
  const spotId = String(req.spot_id || '');
  getSpot_(spotId);
  const url = String(req.url || '').trim().match(/https:\/\/[^\s"'<>）」]+/);
  if (!url) fail_('bad_url', '通話のリンク（https://…）を貼り付けてください');
  const svc = detectCallService_(url[0]);
  if (!svc) fail_('bad_service', '対応している通話リンクは Google Meet・Zoom・LINE・Messenger(Facebook) です');
  const title = String(req.title || '').trim().slice(0, 30) || (u.nickname + 'さんの' + svc.name);
  return withLock_(() => {
    const id = newId_('C');
    const now = Date.now();
    appendObj_('Calls', {
      id, spot_id: spotId, service: svc.id, url: url[0], title,
      email: normEmail_(u.email), nickname: u.nickname,
      createdAt: now, expiresAt: now + CALL_TTL_MS, status: 'open'
    });
    appendLog_(spotId, u.email, u.nickname, 'call', { service: svc.id, name: svc.name, title, state: 'open' });
    return { calls: calls_(spotId, u), message: svc.name + 'の通話を現地に掲示しました' };
  });
}

function callEnd_(req) {
  const u = auth_(req);
  return withLock_(() => {
    const c = readAll_('Calls').find(r => String(r.id) === String(req.id));
    if (!c) fail_('not_found', '通話が見つかりません');
    if (normEmail_(c.email) !== normEmail_(u.email) && !isAdmin_(u)) fail_('forbidden', '通話を終了できるのは始めた人だけです');
    updateObj_('Calls', c._row, { status: 'ended' });
    appendLog_(String(c.spot_id), u.email, u.nickname, 'call', { service: c.service, title: c.title, state: 'ended' });
    return { calls: calls_(String(c.spot_id), u), message: '通話の掲示を終了しました' };
  });
}

function calls_(spotId, u) {
  const now = Date.now();
  const me = u ? normEmail_(u.email) : '';
  return readAll_('Calls')
    .filter(r => String(r.spot_id) === spotId && r.status !== 'ended' && Number(r.expiresAt) > now)
    .map(r => {
      const svc = CALL_SERVICES.find(s => s.id === r.service) || { name: r.service };
      return {
        id: String(r.id), service: r.service, serviceName: svc.name, url: String(r.url), title: String(r.title),
        nickname: String(r.nickname), createdAt: Number(r.createdAt), mine: normEmail_(r.email) === me
      };
    })
    .reverse();
}

/** ビデオ通話の背景用に、現地の画像を取得して base64 で返す
 *  kind: street（ストリートビュー）/ aerial（航空写真）/ photo（スポットの背景画像） */
function callBackground_(req) {
  auth_(req);
  const spot = getSpot_(req.spot_id);
  const kind = String(req.kind || 'street');
  const key = prop_('GOOGLE_MAPS_SERVER_KEY', '') || prop_('GOOGLE_MAPS_API_KEY', '');
  const ll = spot.lat + ',' + spot.lng;
  let url;

  if (kind === 'photo') {
    if (!spot.image_url) fail_('no_image', 'このスポットには背景画像が登録されていません');
    const m = spot.image_url.match(/\/d\/([\w-]{20,})/) || spot.image_url.match(/[?&]id=([\w-]{20,})/);
    const id = m ? m[1] : (/^[\w-]{20,}$/.test(spot.image_url) ? spot.image_url : '');
    if (id) {
      const blob = DriveApp.getFileById(id).getBlob();
      return { base64: Utilities.base64Encode(blob.getBytes()), mime: blob.getContentType() };
    }
    url = spot.image_url;
  } else {
    if (!key) fail_('no_key', 'Googleマップのキーが未設定です（GOOGLE_MAPS_SERVER_KEY）');
    if (kind === 'aerial') {
      url = 'https://maps.googleapis.com/maps/api/staticmap?center=' + ll + '&zoom=17&size=640x360&scale=2&maptype=satellite&key=' + key;
    } else {
      const meta = JSON.parse(UrlFetchApp.fetch(
        'https://maps.googleapis.com/maps/api/streetview/metadata?location=' + ll + '&radius=300&source=outdoor&key=' + key,
        { muteHttpExceptions: true }).getContentText() || '{}');
      if (meta.status === 'REQUEST_DENIED') fail_('key_denied', 'サーバー用のキーが使えません。GOOGLE_MAPS_SERVER_KEY（リファラー制限なし）を設定してください');
      if (meta.status !== 'OK') fail_('no_streetview', 'この場所の近くにはストリートビューがありません。「航空写真」をお試しください');
      const heading = Math.round(Number(req.heading || 0)) % 360;
      url = 'https://maps.googleapis.com/maps/api/streetview?size=640x360&location=' + meta.location.lat + ',' + meta.location.lng +
        '&heading=' + heading + '&pitch=5&fov=100&source=outdoor&key=' + key;
    }
  }
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    fail_('image_error', '画像を取得できませんでした（' + res.getResponseCode() + '）。サーバー用キーのAPI有効化を確認してください');
  }
  const blob = res.getBlob();
  return { base64: Utilities.base64Encode(blob.getBytes()), mime: blob.getContentType() || 'image/jpeg' };
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
  const rows = readAll_('Presence').filter(r => String(r.spot_id) === spotId && Number(r.lastSeen) > limit);
  if (!rows.length) return [];
  const ver = {};
  readAll_('Users').forEach(u => { ver[normEmail_(u.email)] = Number(u.faceVer || 0); });
  return rows.map(r => ({
    id: memberId_(r.email), nickname: r.nickname, avatar: r.avatar || '🙂',
    x: Number(r.x), y: Number(r.y),
    expr: EXPRS.indexOf(r.expr) >= 0 ? r.expr : 'normal',
    faceVer: ver[normEmail_(r.email)] || 0
  }));
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
  } else if (sh.getLastColumn() < SHEET_DEF[name].length) {
    // 列を追加した版へ更新したときは見出しを補う
    sh.getRange(1, 1, 1, SHEET_DEF[name].length).setValues([SHEET_DEF[name]]).setFontWeight('bold');
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
