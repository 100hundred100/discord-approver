#!/usr/bin/env node
// Claude Code PreToolUse フック — セッション同期対応 + Auto Mode
// stdinからツール情報を受け取り、安全な操作は即承認、危険な操作のみDiscordに送る
// 同じClaude Codeセッションの承認は同じDiscordスレッドにまとまる

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from './config.mjs';

// ── Auto Mode: 安全な操作を即承認 ──────────────────────────
// Discord承認をスキップするルール。上から順に評価し、1つでもマッチすれば即approve。
// 危険な操作（deny対象）は先にチェックして必ずDiscord経由にする。

const DANGEROUS_BASH_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*)?/,              // rm コマンド
  /\bgit\s+push\b/,                     // git push（force含む）
  /\bgit\s+reset\s+--hard\b/,           // git reset --hard
  /\bgit\s+commit\s+(-[a-zA-Z]*)*\s*--no-verify/,  // --no-verify
  /\bsudo\b/,                            // sudo
  /\bcurl\b[^|]*\|\s*(ba)?sh/,           // curl | sh パイプ
  /\bchmod\b/,                           // 権限変更
  /\bchown\b/,                           // 所有者変更
  />\s*\/etc\//,                          // /etc/ への書き込み
  />\s*~\/\.(ssh|aws|env)/,              // 秘密ディレクトリへの書き込み
];

const SAFE_TOOL_NAMES = [
  'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch',
  'TodoWrite', 'Agent', 'AskUserQuestion',
];

const SAFE_BASH_PATTERNS = [
  /^(cd\s+\S+\s*&&\s*)?git\s+(status|log|diff|branch|fetch|pull|stash|show|ls-files|rev-parse)\b/,
  /^(cd\s+\S+\s*&&\s*)?git\s+add\b/,
  /^(cd\s+\S+\s*&&\s*)?git\s+commit\b(?!.*--no-verify)/,
  /^(cd\s+\S+\s*&&\s*)?git\s+checkout\b/,
  /^pnpm\s+(test|check|build|dev|format|install)\b/,
  /^npm\s+(run|test|install)\b/,
  /^npx\s/,
  /^node\s/,
  /^tsx\s/,
  /^python3?\s/,
  /^(cat|head|tail|wc|sort|uniq|diff|comm|ls|stat|file|which|echo|printf|mkdir|cp|mv|ln)\b/,
  /^docker(-compose)?\s/,
  /^vitest\b/,
  /^tsc\b/,
  /^gh\s+(pr|issue|api|run)\b/,
  /^find\s/,
  /^grep\s/,
  /^(export\s+)?PATH=/,
];

function shouldAutoApprove(toolName, toolInput) {
  // 1. 安全なツール名は即承認
  if (SAFE_TOOL_NAMES.includes(toolName)) return true;

  // 2. Edit/Write はプロジェクト内ファイルのみ即承認
  if (toolName === 'Edit' || toolName === 'Write') {
    const filePath = toolInput?.file_path || '';
    const cwd = process.cwd();
    // プロジェクトディレクトリ内 or /tmp or ~/.claude/ なら安全
    // worktree の場合、cwd が worktree パス内にある
    // また、同じ親プロジェクト配下のファイルも安全とする
    if (filePath.startsWith(cwd) || filePath.startsWith('/tmp/')) return true;
    // ~/.claude/ 配下（rules, settings, memory 等）
    const home = process.env.HOME || '';
    if (home && filePath.startsWith(`${home}/.claude/`)) return true;
    // cwd の親ディレクトリ（worktree の場合、メインリポジトリのパス）
    // 例: cwd=/path/project/.claude/worktrees/xxx → /path/project/ 配下を許可
    const worktreeMatch = cwd.match(/^(.+?)\/\.claude\/worktrees\//);
    if (worktreeMatch && filePath.startsWith(worktreeMatch[1])) return true;
    // AI_Workspace 配下のファイル操作は全て安全とする
    if (home && filePath.startsWith(`${home}/AI_Workspace/`)) return true;
    return false;
  }

  // 3. Bash コマンドのリスク判定
  if (toolName === 'Bash') {
    const cmd = (toolInput?.command || '').trim();

    // 3a. 危険パターンにマッチ → Discord承認必須
    if (DANGEROUS_BASH_PATTERNS.some(p => p.test(cmd))) return false;

    // 3b. 安全パターンにマッチ → 即承認
    if (SAFE_BASH_PATTERNS.some(p => p.test(cmd))) return true;

    // 3c. どちらにもマッチしない → Discord承認
    return false;
  }

  // 4. NotebookEdit は Discord承認
  if (toolName === 'NotebookEdit') return false;

  // 5. 未知のツールは即承認（MCP系など）
  return true;
}
// ── Auto Mode ここまで ──────────────────────────────────

// daemonが書いたchannelIDファイルを読む（親プロセス=claudeのPID）
function getPredefinedChannelId() {
  const channelFile = join(tmpdir(), `claude-remote-channel-${process.ppid}`);
  if (existsSync(channelFile)) {
    return readFileSync(channelFile, 'utf8').trim();
  }
  return null;
}

// セッションIDの管理（親プロセス=Claude Codeプロセス単位）
function getSessionId() {
  const ppid = process.ppid;
  const sessionFile = join(tmpdir(), `claude-remote-session-${ppid}`);

  if (existsSync(sessionFile)) {
    return readFileSync(sessionFile, 'utf8').trim();
  }

  // 新しいセッションID生成
  const sessionId = crypto.randomUUID();
  writeFileSync(sessionFile, sessionId);
  return sessionId;
}

async function main() {
  const input = await readStdin();

  let toolInfo;
  try {
    toolInfo = JSON.parse(input);
  } catch {
    // パースできない場合はそのまま承認
    console.log(JSON.stringify({ decision: 'approve' }));
    process.exit(0);
  }

  const toolName = toolInfo.tool_name || 'unknown';
  const rawInput = toolInfo.tool_input;
  const autoApproved = shouldAutoApprove(toolName, rawInput);

  const toolInput = formatToolInput(toolName, rawInput);
  const requestId = crypto.randomUUID();
  const sessionId = getSessionId();

  const requestBody = {
    id: requestId,
    tool_name: toolName,
    tool_input: toolInput,
    session_id: sessionId,
    working_dir: process.cwd(),
    ...(autoApproved ? { auto_approved: true } : {}),
    ...(getPredefinedChannelId()
      ? { predefined_channel_id: getPredefinedChannelId() }
      : {}),
  };

  if (autoApproved) {
    // 即承認を返してから Discord に通知を送る
    console.log(JSON.stringify({ decision: 'approve' }));
    await fetch(`${config.workerUrl}/api/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    }).catch(() => {}); // 通知失敗は無視
    process.exit(0);
  }

  try {
    const res = await fetch(`${config.workerUrl}/api/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      console.error(`[approve-hook] Worker error: ${res.status}`);
      console.log(JSON.stringify({ decision: 'approve' }));
      process.exit(0);
    }

    const decision = await pollForResult(requestId);
    console.log(JSON.stringify({ decision }));
  } catch (err) {
    console.error(`[approve-hook] Error: ${err.message}`);
    console.log(JSON.stringify({ decision: 'approve' }));
  }
}

async function pollForResult(requestId) {
  const startTime = Date.now();

  while (Date.now() - startTime < config.approval.timeoutMs) {
    await sleep(config.approval.pollIntervalMs);

    try {
      const res = await fetch(
        `${config.workerUrl}/api/request/${requestId}`,
        { headers: { Authorization: `Bearer ${config.apiKey}` } }
      );

      if (!res.ok) continue;

      const data = await res.json();
      if (data.status === 'approved') return 'approve';
      if (data.status === 'denied') return 'deny';
    } catch {
      // ネットワークエラーは無視して再試行
    }
  }

  console.error('[approve-hook] Timed out waiting for approval');
  return 'deny';
}

function formatToolInput(toolName, input) {
  if (!input) return null;

  try {
    if (toolName === 'Bash') {
      const cmd = input.command || '';
      const short = cmd.length > 300 ? cmd.substring(0, 300) + '...' : cmd;
      return `🔴 Claudeがあなたのパソコンでコマンドを実行しようとしています。\n承認すると実際に実行されます。\n\n💻 実行されるコマンド:\n${short}`;
    }

    if (toolName === 'Edit') {
      const file = input.file_path || '';
      const oldStr = (input.old_string || '').substring(0, 150);
      const newStr = (input.new_string || '').substring(0, 150);
      return `🔵 Claudeがファイルの一部を書き換えようとしています。\n承認するとファイルが変更されます。\n\n📝 対象ファイル: ${file}\n\n【変更前】\n${oldStr}\n\n【変更後】\n${newStr}`;
    }

    if (toolName === 'Write') {
      const file = input.file_path || '';
      const lines = (input.content || '').split('\n').length;
      return `🤖 Claudeが新しいファイルを作成（または上書き）しようとしています。\n承認するとファイルが保存されます。\n\n📄 ファイル: ${file}\n行数: ${lines}行`;
    }

    if (toolName === 'NotebookEdit') {
      const file = input.notebook_path || '';
      return `🤖 ClaudeがJupyterノートブックを編集しようとしています。\n承認するとノートブックが変更されます。\n\n📓 ファイル: ${file}`;
    }

    // その他のツール
    const str = JSON.stringify(input);
    return `🤖 Claudeが操作を実行しようとしています。\n\n` + (str.length > 400 ? str.substring(0, 400) + '...' : str);
  } catch {
    return String(input).substring(0, 500);
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 5000);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main();
