-- Discord サーバー設定（チャンネルIDマッピング）
CREATE TABLE IF NOT EXISTS server_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- セッション管理（Claude Codeセッション ↔ Discordスレッド同期）
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  discord_thread_id TEXT,
  name TEXT,
  status TEXT DEFAULT 'active',
  working_dir TEXT,
  last_discord_message_id TEXT,
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL
);

-- 承認リクエスト
CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  tool_name TEXT NOT NULL,
  tool_input TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

-- タスクコマンド（拡張可能）
CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'task',
  content TEXT NOT NULL,
  tags TEXT DEFAULT '[]',
  working_dir TEXT,
  priority INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  result TEXT,
  discord_thread_id TEXT,
  model TEXT DEFAULT 'claude-sonnet-4-6',
  created_at TEXT NOT NULL,
  completed_at TEXT
);

-- タスクチャンネル（WORKSPACESチャンネルと @mention polling用）
CREATE TABLE IF NOT EXISTS task_channels (
  channel_id TEXT PRIMARY KEY,
  working_dir TEXT,
  last_message_id TEXT
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_requests(status);
CREATE INDEX IF NOT EXISTS idx_approval_session ON approval_requests(session_id);
CREATE INDEX IF NOT EXISTS idx_commands_status ON commands(status);
CREATE INDEX IF NOT EXISTS idx_commands_type ON commands(type);
CREATE INDEX IF NOT EXISTS idx_commands_priority ON commands(priority DESC, created_at ASC);
