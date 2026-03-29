# Discord Approver — CLAUDE.md

Discord と Claude Code を繋ぐ承認リレーシステム。
Cloudflare Worker が中継役となり、Mac 上の Claude Code セッションをリモート操作・承認できる。

---

## アーキテクチャ

```
Discord
  └─ Slash Command (/task, /auto, ...)
        ↓ Interaction API
Cloudflare Worker (TypeScript + D1)
  ├─ /api/interaction   — Discord Slash コマンド・ボタン処理
  ├─ /api/request       — ツール承認リクエスト受付
  ├─ /api/command/*     — タスクコマンド Polling
  └─ /api/tool-done     — PostToolUse 通知
        ↓ Bearer Token (API_KEY)
Mac Daemon (daemon.mjs)
  └─ claude --print [--permission-mode auto | --dangerously-skip-permissions]
        ↓ hooks
  ├─ approve-hook.mjs   (PreToolUse)  — 危険操作を Discord に送り手動承認
  └─ post-tool-hook.mjs (PostToolUse) — 完了通知を Discord チャンネルに投稿
```

---

## ディレクトリ構成

```
discord-approver/
├── worker/                  # Cloudflare Worker
│   ├── src/
│   │   ├── index.ts         # メインルーター・署名検証
│   │   ├── db.ts            # D1 CRUD
│   │   ├── discord.ts       # Discord API・メッセージ整形・チャンネル管理
│   │   └── routes/
│   │       ├── approval.ts  # 承認リクエスト処理
│   │       ├── command.ts   # タスクコマンド Polling
│   │       ├── interaction.ts # Slash コマンドハンドラ
│   │       └── session.ts   # セッション同期・@mention 検出
│   ├── schema.sql           # D1 テーブル定義
│   └── wrangler.toml        # Cloudflare 設定
├── local/                   # Mac 側常駐プロセス
│   ├── daemon.mjs           # タスク Polling・claude CLI 起動
│   ├── approve-hook.mjs     # PreToolUse フック（承認ゲート）
│   ├── post-tool-hook.mjs   # PostToolUse フック（進捗通知）
│   └── config.mjs           # URL・タイムアウト等設定
├── scripts/
│   └── register-commands.mjs # Discord Slash コマンド登録
└── spec/                    # 機能仕様書
```

---

## コマンド

### Worker
```bash
cd worker
npm run dev             # ローカル開発サーバー
npm run deploy          # Cloudflare にデプロイ
npm run db:migrate      # ローカル D1 にスキーマ適用
npm run db:migrate:prod # 本番 D1 にスキーマ適用
```

### Local Daemon
```bash
cd local
node daemon.mjs         # 常駐デーモン起動
```

### Discord コマンド登録
```bash
cd scripts
DISCORD_TOKEN=xxx DISCORD_APPLICATION_ID=xxx node register-commands.mjs
```

---

## 環境変数・シークレット

### Worker シークレット（`wrangler secret put` で設定）
| 変数名 | 説明 |
|---|---|
| `API_KEY` | Mac ↔ Worker 間認証トークン（UUID推奨） |
| `DISCORD_TOKEN` | Discord Bot トークン |
| `DISCORD_PUBLIC_KEY` | Interaction 署名検証用公開鍵 |
| `DISCORD_APPLICATION_ID` | Bot アプリケーション ID |
| `MENTION_USER_ID` | 承認リクエスト時にメンションする Discord ユーザー ID |

### Local（環境変数 or `.env`）
| 変数名 | 説明 |
|---|---|
| `WORKER_URL` | デプロイ済み Worker の URL |
| `API_KEY` | Worker と同じ値 |
| `DEFAULT_WORKING_DIR` | Claude の作業ディレクトリ（省略時は $HOME） |

---

## Discord Slash コマンド一覧

| コマンド | 説明 | タイムアウト |
|---|---|---|
| `/task <指示>` | 開発タスクを実行 | 30分 |
| `/file <指示>` | ファイル操作を実行 | 10分 |
| `/team <指示>` | 長期タスクを実行 | 60分 |
| `/agents <指示>` | マルチエージェント実行 | 120分 |
| `/auto` | `--permission-mode auto` を有効化 | — |
| `/manual` | `--dangerously-skip-permissions` に戻す | — |
| `/status` | 実行中・待機中タスクを確認 | — |
| `/history` | 直近の承認・タスク履歴を確認 | — |
| `/setup` | Discord サーバー構造を初期化 | — |

---

## 承認フロー

```
Claude Code がツールを実行しようとする
  └─ approve-hook.mjs が評価
       ├─ 安全な操作（Read/Grep/git log 等）→ 即承認
       ├─ --permission-mode auto の閾値内   → 即承認
       └─ 危険な操作（rm/git push 等）      → Discord に Approve/Deny ボタン投稿
                                                └─ ユーザーが手動承認
```

### 承認メッセージの構成
- **リスクレベル**: 🔴高 / 🟡中 / 🟢低（Embed 色も連動）
- **このコマンドが行うこと**: Bash コマンドを日本語で解説
- **コマンド内容**: 実際のコマンド（コードブロック）
- **メンション**: `@yas10io` に通知

---

## データベース（D1）

### 主要テーブル
| テーブル | 用途 |
|---|---|
| `server_config` | Discord チャンネル ID マッピング |
| `sessions` | Claude Code セッション ↔ Discord チャンネル |
| `approval_requests` | 承認リクエスト（pending/approved/denied） |
| `commands` | タスクコマンドキュー（pending/running/completed/failed） |
| `task_channels` | チャンネル別設定（`auto_approve` フラグ含む） |

---

## セットアップ手順

1. **Discord Bot 作成** — Developer Portal でボット作成・トークン取得
2. **Worker デプロイ**
   ```bash
   cd worker && npm install
   wrangler secret put API_KEY
   wrangler secret put DISCORD_TOKEN
   wrangler secret put DISCORD_PUBLIC_KEY
   wrangler secret put DISCORD_APPLICATION_ID
   npm run deploy
   npm run db:migrate:prod
   ```
3. **Slash コマンド登録**
   ```bash
   cd scripts && node register-commands.mjs
   ```
4. **Mac Daemon 起動**
   ```bash
   cd local
   WORKER_URL=https://xxx.workers.dev API_KEY=xxx node daemon.mjs
   ```
5. **Claude Code フック設定** — `~/.claude/settings.json`
   ```json
   {
     "hooks": {
       "PreToolUse": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node /path/to/local/approve-hook.mjs" }] }],
       "PostToolUse": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node /path/to/local/post-tool-hook.mjs" }] }]
     }
   }
   ```
6. **Discord サーバー初期化** — `/setup` を Discord で実行

---

## 実装上の注意点

- `local/config.mjs` に APIキーをハードコードしない。必ず環境変数 `API_KEY` を使う
- Worker シークレットは `wrangler.toml` に書かない
- チャンネル自動削除: カテゴリ内を常に最新 10 本に保つ（`pruneOldChannels`）
- `/auto` モード: Worker 側では自動承認しない。`--permission-mode auto` で Claude 側が判断し、超えた操作のみ Discord に来る
