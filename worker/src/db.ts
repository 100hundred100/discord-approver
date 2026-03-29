// D1 データベース操作

// --- 型定義 ---

export interface Session {
  id: string;
  discord_thread_id: string | null;
  name: string | null;
  status: 'active' | 'closed';
  working_dir: string | null;
  last_discord_message_id: string | null;
  created_at: string;
  last_activity_at: string;
}

export interface ApprovalRequest {
  id: string;
  session_id: string | null;
  tool_name: string;
  tool_input: string | null;
  status: 'pending' | 'approved' | 'denied';
  created_at: string;
  resolved_at: string | null;
}

export interface Command {
  id: string;
  type: string;
  content: string;
  tags: string;
  working_dir: string | null;
  priority: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result: string | null;
  discord_thread_id: string | null;
  model: string | null;
  created_at: string;
  completed_at: string | null;
}

// --- サーバー設定 ---

export async function getConfig(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM server_config WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setConfig(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT OR REPLACE INTO server_config (key, value) VALUES (?, ?)')
    .bind(key, value)
    .run();
}

export async function getAllConfig(db: D1Database): Promise<Record<string, string>> {
  const rows = await db
    .prepare('SELECT key, value FROM server_config')
    .all<{ key: string; value: string }>();
  const config: Record<string, string> = {};
  for (const row of rows.results) {
    config[row.key] = row.value;
  }
  return config;
}

// --- セッション ---

export async function getOrCreateSession(
  db: D1Database,
  sessionId: string,
  name?: string,
  workingDir?: string | null
): Promise<Session> {
  const existing = await db
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .bind(sessionId)
    .first<Session>();

  if (existing) {
    if (workingDir && !existing.working_dir) {
      await db
        .prepare('UPDATE sessions SET last_activity_at = ?, working_dir = ? WHERE id = ?')
        .bind(new Date().toISOString(), workingDir, sessionId)
        .run();
    } else {
      await db
        .prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?')
        .bind(new Date().toISOString(), sessionId)
        .run();
    }
    return existing;
  }

  const now = new Date().toISOString();
  const sessionName = name || `Session ${now.replace('T', ' ').substring(0, 16)}`;
  await db
    .prepare('INSERT INTO sessions (id, name, status, working_dir, created_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(sessionId, sessionName, 'active', workingDir ?? null, now, now)
    .run();

  return { id: sessionId, discord_thread_id: null, name: sessionName, status: 'active', working_dir: workingDir ?? null, last_discord_message_id: null, created_at: now, last_activity_at: now };
}

export async function getActiveSessions(db: D1Database): Promise<Session[]> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const result = await db
    .prepare("SELECT * FROM sessions WHERE status = 'active' AND discord_thread_id IS NOT NULL AND last_activity_at > ?")
    .bind(cutoff)
    .all<Session>();
  return result.results;
}

export async function updateSessionLastMessageId(
  db: D1Database,
  sessionId: string,
  messageId: string
): Promise<void> {
  await db
    .prepare('UPDATE sessions SET last_discord_message_id = ? WHERE id = ?')
    .bind(messageId, sessionId)
    .run();
}

export async function updateSessionThread(
  db: D1Database,
  sessionId: string,
  threadId: string
): Promise<void> {
  await db
    .prepare('UPDATE sessions SET discord_thread_id = ? WHERE id = ?')
    .bind(threadId, sessionId)
    .run();
}

// --- 承認リクエスト ---

export async function createApprovalRequest(
  db: D1Database,
  id: string,
  sessionId: string | null,
  toolName: string,
  toolInput: string | null
): Promise<void> {
  await db
    .prepare('INSERT INTO approval_requests (id, session_id, tool_name, tool_input, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, sessionId, toolName, toolInput, 'pending', new Date().toISOString())
    .run();
}

export async function getApprovalRequest(
  db: D1Database,
  id: string
): Promise<ApprovalRequest | null> {
  return await db
    .prepare('SELECT * FROM approval_requests WHERE id = ?')
    .bind(id)
    .first<ApprovalRequest>();
}

export async function resolveApprovalRequest(
  db: D1Database,
  id: string,
  status: 'approved' | 'denied'
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE approval_requests SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'")
    .bind(status, new Date().toISOString(), id)
    .run();
  return result.meta.changes > 0;
}

export async function getPendingApprovals(db: D1Database): Promise<ApprovalRequest[]> {
  const result = await db
    .prepare("SELECT * FROM approval_requests WHERE status = 'pending' ORDER BY created_at DESC LIMIT 20")
    .all<ApprovalRequest>();
  return result.results;
}

// --- コマンド ---

const DEFAULT_MODEL = 'claude-sonnet-4-6';

export async function createCommand(
  db: D1Database,
  id: string,
  type: string,
  content: string,
  tags: string[] = [],
  workingDir: string | null = null,
  priority: number = 0,
  discordThreadId: string | null = null,
  model: string | null = null
): Promise<void> {
  await db
    .prepare('INSERT INTO commands (id, type, content, tags, working_dir, priority, status, discord_thread_id, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, type, content, JSON.stringify(tags), workingDir, priority, 'pending', discordThreadId, model ?? DEFAULT_MODEL, new Date().toISOString())
    .run();
}

export async function updateCommandThread(
  db: D1Database,
  id: string,
  threadId: string
): Promise<void> {
  await db
    .prepare('UPDATE commands SET discord_thread_id = ? WHERE id = ?')
    .bind(threadId, id)
    .run();
}

export async function getPendingCommands(db: D1Database): Promise<(Command & { auto_approve?: number })[]> {
  const result = await db
    .prepare(`
      SELECT c.*, tc.auto_approve
      FROM commands c
      LEFT JOIN task_channels tc ON c.discord_thread_id = tc.channel_id
      WHERE c.status = 'pending'
      ORDER BY c.priority DESC, c.created_at ASC
      LIMIT 10
    `)
    .all<Command & { auto_approve?: number }>();
  return result.results;
}

export async function getCommand(db: D1Database, id: string): Promise<Command | null> {
  return await db.prepare('SELECT * FROM commands WHERE id = ?').bind(id).first<Command>();
}

export async function updateCommandStatus(
  db: D1Database,
  id: string,
  status: 'running' | 'completed' | 'failed',
  result: string | null = null
): Promise<Command | null> {
  const completedAt = status === 'completed' || status === 'failed' ? new Date().toISOString() : null;
  await db
    .prepare('UPDATE commands SET status = ?, result = ?, completed_at = ? WHERE id = ?')
    .bind(status, result, completedAt, id)
    .run();
  return await getCommand(db, id);
}

export async function getRecentItems(
  db: D1Database,
  limit: number = 10
): Promise<{ approvals: ApprovalRequest[]; commands: Command[] }> {
  const [approvals, commands] = await Promise.all([
    db.prepare('SELECT * FROM approval_requests ORDER BY created_at DESC LIMIT ?').bind(limit).all<ApprovalRequest>(),
    db.prepare('SELECT * FROM commands ORDER BY created_at DESC LIMIT ?').bind(limit).all<Command>(),
  ]);
  return { approvals: approvals.results, commands: commands.results };
}

// --- タスクチャンネル ---

export interface TaskChannel {
  channel_id: string;
  working_dir: string | null;
  last_message_id: string | null;
  auto_approve: number; // 0 = 手動承認, 1 = 自動承認
}

export async function registerTaskChannel(
  db: D1Database,
  channelId: string,
  workingDir: string | null = null
): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO task_channels (channel_id, working_dir) VALUES (?, ?)')
    .bind(channelId, workingDir)
    .run();
}

export async function getTaskChannels(db: D1Database): Promise<TaskChannel[]> {
  const result = await db
    .prepare('SELECT * FROM task_channels')
    .all<TaskChannel>();
  return result.results;
}

export async function updateTaskChannelLastMessage(
  db: D1Database,
  channelId: string,
  messageId: string
): Promise<void> {
  await db
    .prepare('UPDATE task_channels SET last_message_id = ? WHERE channel_id = ?')
    .bind(messageId, channelId)
    .run();
}

export async function setTaskChannelAutoApprove(
  db: D1Database,
  channelId: string,
  enabled: boolean,
  workingDir: string | null = null
): Promise<void> {
  // チャンネルが task_channels に存在しない場合は INSERT、存在する場合は auto_approve を更新
  await db
    .prepare(`
      INSERT INTO task_channels (channel_id, working_dir, auto_approve)
      VALUES (?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET auto_approve = excluded.auto_approve
    `)
    .bind(channelId, workingDir, enabled ? 1 : 0)
    .run();
}

export async function isAutoApprove(db: D1Database, channelId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT auto_approve FROM task_channels WHERE channel_id = ?')
    .bind(channelId)
    .first<{ auto_approve: number }>();
  return (row?.auto_approve ?? 0) === 1;
}

export async function getRunningAndPendingCommands(db: D1Database): Promise<Command[]> {
  const result = await db
    .prepare("SELECT * FROM commands WHERE status IN ('pending', 'running') ORDER BY created_at DESC LIMIT 20")
    .all<Command>();
  return result.results;
}
