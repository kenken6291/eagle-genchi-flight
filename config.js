/* ==============================================================
 * 現地集合フライト 設定ファイル
 * GAS の URL やバージョン、表示用の定数はここで一元管理します。
 * ※ Gemini APIキーはフロントに置かず、GASのスクリプトプロパティ
 *   GEMINI_API_KEY に設定してください。
 * ============================================================== */
window.APP_CONFIG = {
  APP_NAME: '現地集合フライト',
  SUBTITLE: 'イーグル隊長の空中散歩',
  VERSION: 'v1.7.1',
  BUILD: '20261013',
  STATUS: 'β版',

  // GAS ウェブアプリの URL（デプロイ後に差し替え）
  // 画面の「設定」から端末ごとに上書きもできます（未設定時はこの値を使用）
  GAS_URL: 'https://script.google.com/macros/s/AKfycbx0Anh2ZMYHW55hnCc69PsYDh86iYNPfPAIePWvzjrY8uQ42HeNnRo9nRIH7q_tQpCPGg/exec',
  ALLOW_GAS_URL_OVERRIDE: true,
  GAS_URL_STORAGE_KEY: 'egf_gas_url',

  // 更新履歴（設定画面のバージョン情報に表示）
  CHANGELOG: [
    { version: 'v1.7.1', date: '2026-10-13', note: '広場の「通話中」に停止ボタンを追加（掲示した本人と管理者）' },
    { version: 'v1.7.0', date: '2026-10-13', note: '音声のみの通話として X スペース・Clubhouse・stand.fm・Yay! を追加' },
    { version: 'v1.6.1', date: '2026-10-13', note: 'スマホでログアウトボタンが表示されない不具合を修正。プロフィール画面にもログアウトを追加' },
    { version: 'v1.6.0', date: '2026-10-13', note: '現地広場のアイコンを顔写真に。普通・笑顔・困った顔・驚いた顔の4表情を登録でき、会話や動作で表情が変わる' },
    { version: 'v1.5.0', date: '2026-10-13', note: '現地でビデオ通話（Google Meet・Zoom・LINE・Messenger）の掲示・参加と、現地の景色を使った通話用背景画像の作成を追加' },
    { version: 'v1.4.0', date: '2026-10-13', note: 'フライトをGoogleマップ3D（Earth Studio風のカメラ飛行）に。現在地から目的地へ飛び、イーグル隊長の吹き出し・一時停止/次へ・声/効果音の音量調整を追加' },
    { version: 'v1.3.1', date: '2026-10-13', note: 'ウインドウに常に表示される×（閉じる）ボタンを追加。背景クリックでも閉じられるように' },
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

  // 顔写真の表情（id は GAS の EXPRS と合わせる）
  EXPRESSIONS: [
    { id: 'normal',   label: '普通',     emoji: '🙂' },
    { id: 'smile',    label: '笑顔',     emoji: '😄' },
    { id: 'trouble',  label: '困った顔', emoji: '😥' },
    { id: 'surprise', label: '驚いた顔', emoji: '😲' }
  ],
  FACE_SIZE: 256,          // 保存する顔写真の大きさ（正方形px）
  EXPR_HOLD_MS: 8000,      // 会話・動作で変わった表情を保つ時間
  // 会話の言葉から表情を選ぶ（上から順に判定）
  EXPR_WORDS: {
    surprise: ['びっくり', '驚', 'まさか', 'えっ', 'えー', 'ええっ', '本当', 'ほんと', 'マジ', 'すごい', 'すご', 'なんと', '！？', '!?', '？！', '😲', '😮', '😱'],
    trouble:  ['困', '疲', '残念', 'ごめん', 'すみません', '悲し', 'つらい', '辛い', 'うーん', '大変', '寒', '暑', '迷', 'どうしよう', '焦げ', '😥', '😢', '💦'],
    smile:    ['笑', '嬉', 'うれし', '楽し', 'たのし', 'ありがと', '乾杯', '最高', 'いいね', 'おいし', '美味', 'きれい', '綺麗', 'こんにちは', 'よろしく', 'わーい', 'やった', 'www', '😊', '😄', '🎉', '♪', '！']
  },

  // GAS の NPCS と id を合わせる
  NPCS: [
    { id: 'take',  name: '焼き肉奉行タケさん', emoji: '🧔',   x: 22, y: 74 },
    { id: 'miko',  name: '歌好きミーコ',       emoji: '👩‍🎤', x: 76, y: 66 },
    { id: 'ponta', name: '旅人ポン太',         emoji: '🦝',   x: 52, y: 88 }
  ],

  // 現地ビデオ通話（通話そのものは各アプリ。ここでは開き方と案内）
  CALL_SERVICES: {
    meet:      { name: 'Google Meet', icon: '🟢', open: 'https://meet.google.com/new',
                 how: '開いたら「会議のリンク」をコピーして下に貼り付け' },
    zoom:      { name: 'Zoom',        icon: '🔵', open: 'https://zoom.us/start/videomeeting',
                 how: '開始後「参加者」→「招待」→「招待リンクをコピー」' },
    line:      { name: 'LINE',        icon: '💬', open: 'https://line.me/R/',
                 how: 'グループの通話で「通話リンクを作成」→コピー（スマホ）' },
    messenger: { name: 'Messenger',   icon: '💜', open: 'https://www.messenger.com/',
                 how: '通話を始めて「リンクを共有」→コピー' },
    // 音声のみ（audio: true）
    xspaces:   { name: 'X スペース',  icon: '✖️', audio: true, open: 'https://x.com/',
                 how: 'アプリの「＋」→「スペース」で開始→「共有」→「リンクをコピー」' },
    clubhouse: { name: 'Clubhouse',   icon: '👋', audio: true, open: 'https://www.clubhouse.com/',
                 how: 'ルームを開始→「共有」→「リンクをコピー」' },
    standfm:   { name: 'stand.fm',    icon: '🎙️', audio: true, open: 'https://stand.fm/',
                 how: 'ライブ配信を開始→「シェア」→「リンクをコピー」' },
    yay:       { name: 'Yay!',        icon: '🌈', audio: true, open: 'https://yay.space/',
                 how: '通話を開始→「共有」→「リンクをコピー」' }
  },

  // フライト演出
  FLIGHT: {
    PREFER: 'map3d',          // 'map3d'＝Googleマップ3Dで飛ぶ / 'video'＝スポットの動画があれば動画優先
    USE_GEOLOCATION: true,    // 現在地から出発（許可されない場合は START）
    START: { lat: 35.6812, lng: 139.7671, name: '東京駅' }
  },

  POLL_MS: 4000,              // 広場の更新間隔
  NPC_MS: 30000,              // NPCの賑やかし間隔（サーバー側でも35秒に制限）
  ARRIVE_FALLBACK_MS: 20000,  // 音声が無い場合に「着陸する」を押せるまでの時間
  SESSION_KEY: 'egf_session'
};
