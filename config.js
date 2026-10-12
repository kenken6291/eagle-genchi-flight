/* ==============================================================
 * 現地集合フライト 設定ファイル
 * GAS の URL やバージョン、表示用の定数はここで一元管理します。
 * ※ Gemini APIキーはフロントに置かず、GASのスクリプトプロパティ
 *   GEMINI_API_KEY に設定してください。
 * ============================================================== */
window.APP_CONFIG = {
  APP_NAME: '現地集合フライト',
  SUBTITLE: 'イーグル隊長の空中散歩',
  VERSION: 'v1.3.0',
  BUILD: '20261013',
  STATUS: 'β版',

  // GAS ウェブアプリの URL（デプロイ後に差し替え）
  // 画面の「設定」から端末ごとに上書きもできます（未設定時はこの値を使用）
  GAS_URL: 'https://script.google.com/macros/s/AKfycbx0Anh2ZMYHW55hnCc69PsYDh86iYNPfPAIePWvzjrY8uQ42HeNnRo9nRIH7q_tQpCPGg/exec',
  ALLOW_GAS_URL_OVERRIDE: true,
  GAS_URL_STORAGE_KEY: 'egf_gas_url',

  // 更新履歴（設定画面のバージョン情報に表示）
  CHANGELOG: [
    { version: 'v1.3.0', date: '2026-10-13', note: 'Googleマップの共有リンク（maps.app.goo.gl など）を貼るだけで行き先を登録できるように。一括取り込みにも対応' },
    { version: 'v1.2.0', date: '2026-10-13', note: 'Google Maps APIキーをスクリプトプロパティ管理に。スポットの「上空から見る／現地の景色」、広場の背景にストリートビューを追加' },
    { version: 'v1.1.0', date: '2026-10-13', note: '設定画面（GAS URLの設定・接続テスト）とバージョン情報画面を追加' },
    { version: 'v1.0.0', date: '2026-10-13', note: '初版公開（会員認証・行き先選定・フライト・現地広場・スポット管理）' }
  ],

  // APIキーの参照先（表示・説明用。キー自体はGASのスクリプトプロパティで保持）
  GEMINI_KEY_LOCATION: 'GAS スクリプトプロパティ GEMINI_API_KEY',
  GOOGLE_MAPS_KEY_LOCATION: 'GAS スクリプトプロパティ GOOGLE_MAPS_API_KEY（ログイン後に取得）',

  // Google Drive 配信URLの組み立てルール（{id} をファイルIDに置換）
  DRIVE: {
    VIDEO_PREVIEW: 'https://drive.google.com/file/d/{id}/preview',          // 動画：iframe再生（最も安定）
    VIDEO_DIRECT: 'https://drive.google.com/uc?export=download&id={id}',   // 小さい動画のみ<video>可
    IMAGE: 'https://lh3.googleusercontent.com/d/{id}=w1600',               // 背景画像
    ROOT_FOLDER_URL: 'https://drive.google.com/drive/folders/XXXXXXXXXXXX' // 配信用ルートフォルダ（管理用メモ）
  },

  MAP: {
    center: [36.2, 138.25],
    zoom: 5,
    tile: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors'
  },

  // カテゴリ → ピン絵文字・現地広場の情景
  CATEGORIES: {
    'BBQ':   { emoji: '🍖', scene: 'bbq',    prop: '🔥' },
    '音楽':  { emoji: '🎤', scene: 'stage',  prop: '🎪' },
    '観光':  { emoji: '🏯', scene: 'sight',  prop: '⛲' },
    '自然':  { emoji: '🌲', scene: 'nature', prop: '🏕️' },
    'グルメ': { emoji: '🍜', scene: 'sight',  prop: '🏮' },
    '夜景':  { emoji: '🌃', scene: 'night',  prop: '🔭' },
    'その他': { emoji: '📍', scene: 'sight',  prop: '🎈' }
  },

  MOODS: [
    '肉を焼いて騒ぎたい',
    '星空の下で静かに歌いたい',
    '海を見ながらのんびり',
    '山の空気で深呼吸',
    'ご当地グルメで乾杯',
    '夜景を見ながら語りたい'
  ],

  ACTIONS: [
    { id: 'bbq',   emoji: '🍖', label: '肉を焼く', fx: '🔥' },
    { id: 'dance', emoji: '💃', label: '踊る',     fx: '✨' },
    { id: 'sing',  emoji: '🎤', label: '歌う',     fx: '🎵' },
    { id: 'wave',  emoji: '👋', label: '手を振る', fx: '👋' },
    { id: 'cheer', emoji: '🥂', label: '乾杯',     fx: '🥂' }
  ],

  PHRASES: ['こんにちは！', 'いい景色ですね', 'お肉焼けましたよ〜', '一曲いきます！', '乾杯！', 'また会いましょう'],

  AVATARS: ['🙂', '😎', '🧑‍🦳', '👩‍🦰', '🧔', '👵', '👴', '🧢', '🐱', '🐶', '🦊', '🐼'],

  // GAS の NPCS と id を合わせる
  NPCS: [
    { id: 'take',  name: '焼き肉奉行タケさん', emoji: '🧔',   x: 22, y: 74 },
    { id: 'miko',  name: '歌好きミーコ',       emoji: '👩‍🎤', x: 76, y: 66 },
    { id: 'ponta', name: '旅人ポン太',         emoji: '🦝',   x: 52, y: 88 }
  ],

  POLL_MS: 4000,              // 広場の更新間隔
  NPC_MS: 30000,              // NPCの賑やかし間隔（サーバー側でも35秒に制限）
  ARRIVE_FALLBACK_MS: 20000,  // 音声が無い場合に「着陸する」を押せるまでの時間
  SESSION_KEY: 'egf_session'
};
