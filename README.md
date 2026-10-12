# 現地集合フライト（eagle-genchi-flight）

「イーグル隊長の空中散歩」連動型 仮想イベント＆目的地フライトプラットフォーム  
`v1.3.0 (Build 20261013)`

## 1. アーキテクチャ

```
[ブラウザ / GitHub Pages]                    [Google Apps Script ウェブアプリ]
 index.html / style.css / app.js / config.js
   │  POST (Content-Type: text/plain, JSON)  ─►  doPost → ROUTES[action]
   │  GET  (ヘルスチェック)                  ─►  doGet
   │                                              ├ スプレッドシート（Users / Spots / ActivityLogs / Presence）
   │                                              ├ CacheService（セッション・ナビ台本・NPC間隔制御）
   │                                              ├ Gemini API（取り込み整形・気分レコメンド・台本・NPC）
   │                                              ├ Gemini TTS（隊長の声 → WAV、Driveにキャッシュ）
   │                                              └ MailApp（仮パスワード送付）
   └ Leaflet + OpenStreetMap（地図）
   └ Google Drive（Earth Studio動画=iframe再生、背景画像）
```

- Gemini APIキーはフロントに置かず、GASのスクリプトプロパティで保持します。
- 現地広場はリアルタイム通信ではなく **4秒間隔のポーリング** です（GASの制約）。数人〜十数人規模を想定。歌の同期は「同じメロディ番号を各端末で鳴らす」方式で、数秒のずれは出ます。

## 2. スプレッドシート設計

| シート | 列 | 用途 |
|---|---|---|
| Users | email, nickname, salt, hash, mustChange, role, status, failCount, lockedUntil, avatar, createdAt, lastLogin | 会員。hashはSHA-256×200回（salt＋pepper）。role=admin/member、status=active/suspended |
| Spots | spot_id, name, lat, lng, description, category, flight_video_url, activity_tags, image_url, source, createdAt, updatedAt | 目的地。activity_tagsはカンマ区切り。sourceは取り込み名（一括削除用） |
| ActivityLogs | id, ts, spot_id, email, nickname, type, payload | 広場のログ。type=join/leave/chat/action/npc、payloadはJSON |
| Presence | key, spot_id, email, nickname, avatar, x, y, lastSeen | 在室情報。key=`spot_id|email`、45秒更新なしで退出扱い |

Spots には v1.3.0 で `address, maps_url` 列を末尾に追加しました（既存シートは自動で見出しを補います）。

`category` は `BBQ / 音楽 / 観光 / 自然 / グルメ / 夜景 / その他`。

## 3. API仕様

すべて `POST GAS_URL`、本文は JSON 文字列。共通で `action` と（ログイン後は）`token` を送ります。

共通レスポンス：成功 `{ "ok": true, ... }` ／ 失敗 `{ "ok": false, "error": "コード", "message": "表示用文言" }`  
主なエラーコード：`auth_required`（再ログイン）, `must_change`（PW変更が必要）, `forbidden`, `locked`, `gemini_error`, `tts_error`, `busy`

### 認証
| action | リクエスト | レスポンス |
|---|---|---|
| register | `email, nickname` | `message, tempPassword?`（メール失敗時またはSHOW_TEMP_PASSWORD=true時のみ） |
| login | `email, password` | `token, user{email,nickname,avatar,role,mustChange}, mustChange` |
| changePassword | `token, current, newPassword` | `user, message` |
| resetPassword | `email` | `message`（登録有無に関わらず同じ文言） |
| me / logout | `token` | `user` / `{}` |
| clientConfig | `token` | `mapsApiKey, version, build` |
| updateProfile | `token, nickname?, avatar?` | `user, message` |

ログイン5回失敗で15分ロック。`mustChange` が真の間は `changePassword / me / logout` 以外は `must_change` で拒否されます。

### スポット
| action | リクエスト | レスポンス |
|---|---|---|
| getSpots | `token` | `spots[], categories[]` |
| upsertSpot（管理者） | `spot{spot_id?, name, lat, lng, category, description, activity_tags, flight_video_url, image_url}` | `spot, message` |
| deleteSpot（管理者） | `spot_id` | `message` |
| deleteSpotsBySource（管理者） | `source` | `deleted, message` |
| importPreview（管理者） | `text?, url?` | `items[]`（整形済み・未登録）, `count` |
| resolveMapUrl（管理者） | `text`（Googleマップの共有リンクを含む文字列） | `spot{name, lat, lng, address, maps_url, description, category, activity_tags}`（未登録の下書き） |
| importCommit（管理者） | `items[], source?` | `added, skipped, source, message` |

### エンタメ・ナビ
| action | リクエスト | レスポンス |
|---|---|---|
| recommend | `mood` | `spot_id, message`（隊長口調） |
| narration | `spot_id, mode(flight/mystery/arrival), withAudio?` | `script, audio{base64,mime}?, audioError?` |
| speak | `text`（300字まで） | `audio{base64,mime}` |

### 現地広場
| action | リクエスト | レスポンス |
|---|---|---|
| plazaJoin | `spot_id, x, y` | `me, members[], logs[], serverTs` |
| plazaPoll | `spot_id, since` | `members[], logs[], serverTs` |
| plazaPost | `spot_id, type(chat/action/move), payload` | `id?` |
| plazaLeave | `spot_id` | `{}` |
| npcTick | `spot_id` | `log?` または `skipped`（35秒に1回まで） |

`members[]` は `{id, nickname, avatar, x, y}`。`id` はメールのハッシュで、他の参加者にメールアドレスは渡りません。

## 4. セットアップ手順

1. Googleスプレッドシートを新規作成 →「拡張機能 → Apps Script」→ `gas/Code.gs` を貼り付け。
2. スクリプトプロパティに `GEMINI_API_KEY` を設定（必要に応じて `GOOGLE_MAPS_API_KEY`, `ADMIN_EMAILS`, `TTS_FOLDER_ID` なども）。
   - `GOOGLE_MAPS_API_KEY` は Maps Embed API 用。ログイン済み会員にだけ `clientConfig` で返し、スポットの「上空から見る／現地の景色」と広場のストリートビュー背景に使います。未設定ならボタンは出ません。
   - ブラウザで使うキーは通信上は見えるため、GCP の「認証情報」で **HTTPリファラー制限（`https://kenken6291.github.io/*`）** と **API制限（Maps Embed API のみ）** を必ず設定してください。
3. エディタで `setup` を実行（シート作成と PEPPER 生成。権限を承認）。
4. 「デプロイ → 新しいデプロイ → ウェブアプリ」。実行ユーザー：自分、アクセス：全員。
5. 発行された URL を `config.js` の `GAS_URL` に設定し、GitHub Pages（`kenken6291.github.io/eagle-genchi-flight/`）へ push。
   - push せずに試したい場合は、画面右上の「設定」→「接続先（GAS）」に URL を入れて「接続テスト」→「保存」でも動きます（その端末だけ有効、config.js より優先）。
   - 画面左下のバージョン表示をタップすると、画面・サーバー双方のバージョンと接続状態、更新履歴を確認できます。版が食い違っていれば警告が出ます。
6. `cleanupLogs` に「時間主導型・1日1回」のトリガーを設定。
7. **Code.gs を変更したら「デプロイを管理 → 編集 → バージョン：新バージョン」で再デプロイが必要です。**

## 5. Google Earth Studio → Google Drive 配信

1. Earth Studio でプロジェクト作成（「Fly To」テンプレートが手軽）。出発地→目的地を設定、1280×720 / 30fps / 20〜40秒程度を推奨（Driveの再生処理が軽くなります）。
2. Render で連番画像を書き出し → 動画編集ソフトまたは `ffmpeg -framerate 30 -i spot_%03d.jpeg -c:v libx264 -pix_fmt yuv420p -crf 23 flight.mp4` で MP4 化。
   - Earth Studio の利用規約に従い、映像内のGoogleロゴ・帰属表示は残してください。
3. Drive の配信用フォルダにアップロード →「共有 → リンクを知っている全員（閲覧者）」。
4. 共有URL `https://drive.google.com/file/d/【ファイルID】/view` を、管理画面の「フライト動画」欄にそのまま貼ります（IDだけでも可）。
5. アプリは `https://drive.google.com/file/d/【ID】/preview` を iframe で再生します（`config.js` の `DRIVE.VIDEO_PREVIEW`）。
   - Drive の iframe は自動再生できないため、隊長の音声は「出発！」で始まり、映像は再生ボタンを押して開始します。
   - 映像と音声を厳密に同期させたい場合は、MP4 を GitHub Pages などに置いて直接 URL（`.mp4`）を指定すると `<video>` で同時再生されます。
6. 背景画像も同様に共有し、URL/ID を「背景画像」欄へ。`lh3.googleusercontent.com/d/【ID】` 形式で表示します。

## 6. Gemini TTS の実装

- モデル：`gemini-2.5-flash-preview-tts`（プロパティ `TTS_MODEL` で変更可）、声：`Puck`（`TTS_VOICE`。落ち着いた声なら `Charon`、力強い声なら `Fenrir` など）。
- 返却は PCM（24kHz / 16bit / モノラル）なので、`pcmToWav_()` で WAV ヘッダを付けて base64 で返します。
- `TTS_FOLDER_ID` を設定すると `tts_【MD5】.wav` として Drive に保存し、同じ台本は再生成しません。フライト台本も CacheService に6時間保存するため、同じスポットへの2回目以降は速く、APIの消費も抑えられます。
- 呼び出し例（フロント）：

```js
const r = await api('narration', { spot_id: 'S...', mode: 'flight' });
const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(r.audio.base64), c => c.charCodeAt(0))], { type: 'audio/wav' }));
new Audio(url).play();
```

## 7. 既知の制約

- ポーリング方式のため、他の参加者の動きやチャットは最大4秒ほど遅れて届きます。
- GAS の同時実行・実行時間の上限があるため、大人数（数十人以上）の同時合流には向きません。本格運用時は広場部分のみ Firebase Realtime Database への置き換えを検討してください。
- 初回の音声生成は10秒前後かかることがあります（2回目以降はキャッシュ）。
