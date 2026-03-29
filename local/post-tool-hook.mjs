#!/usr/bin/env node
// PostToolUse フック — ツール完了時にセッションのDiscordチャンネルに通知
// Claude Codeがツールを実行し終えた直後に呼ばれる

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from './config.mjs';

function getSessionId() {
  const ppid = process.ppid;
  const sessionFile = join(tmpdir(), `claude-remote-session-${ppid}`);
  if (existsSync(sessionFile)) {
    return readFileSync(sessionFile, 'utf8').trim();
  }
  return null;
}

async function main() {
  const input = await readStdin();

  let toolInfo;
  try {
    toolInfo = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const sessionId = getSessionId();
  if (!sessionId) process.exit(0);

  const toolName = toolInfo.tool_name || 'unknown';
  const summary = formatSummary(toolName, toolInfo.tool_input);
  const output = formatOutput(toolName, toolInfo.tool_input, toolInfo.tool_response);

  try {
    await fetch(`${config.workerUrl}/api/tool-done`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ session_id: sessionId, tool_name: toolName, summary, output }),
    });
  } catch {
    // エラーは無視（Claude Codeの動作を止めない）
  }

  process.exit(0);
}

function formatSummary(toolName, input) {
  try {
    if (toolName === 'Edit') return `${input?.file_path || ''}`;
    if (toolName === 'Write') return `${input?.file_path || ''} を作成`;
    if (toolName === 'Bash') return (input?.command || '').substring(0, 120);
    if (toolName === 'NotebookEdit') return `${input?.notebook_path || ''}`;
    if (toolName === 'Agent') {
      const agentType = input?.subagent_type || 'agent';
      const desc = (input?.description || input?.prompt || '').substring(0, 80);
      return `${agentType}${desc ? ` — ${desc}` : ''}`;
    }
    return '';
  } catch {
    return '';
  }
}

// tool_response からDiscordに表示するアウトプットテキストを生成
function formatOutput(toolName, input, response) {
  if (!response) return null;

  try {
    if (toolName === 'Bash') {
      // tool_response は文字列 or { output, error, interrupted } オブジェクト
      let text = '';
      if (typeof response === 'string') {
        text = response;
      } else if (typeof response === 'object') {
        const out = response.output || '';
        const err = response.error || '';
        text = out + (err ? '\n[stderr]\n' + err : '');
      }
      text = text.trim();
      if (!text) return null;
      // 長すぎる場合は末尾を省略
      return text.length > 800 ? text.substring(0, 800) + '\n…（省略）' : text;
    }

    if (toolName === 'Edit') {
      const file = input?.file_path || '';
      return `✏️ 編集: ${file}`;
    }

    if (toolName === 'Write') {
      const file = input?.file_path || '';
      const lines = (input?.content || '').split('\n').length;
      return `📄 作成: ${file} (${lines}行)`;
    }

    if (toolName === 'NotebookEdit') {
      const file = input?.notebook_path || '';
      return `📓 編集: ${file}`;
    }

    if (toolName === 'Agent') {
      const agentType = input?.subagent_type || 'agent';
      const task = (input?.description || input?.prompt || '').substring(0, 200);
      // レスポンスからエージェントの出力サマリーを取る
      let result = '';
      if (typeof response === 'string') {
        result = response.substring(0, 400);
      } else if (response?.result) {
        result = String(response.result).substring(0, 400);
      }
      return `🤖 **${agentType}**\n> ${task}${result ? `\n\n${result}` : ''}`;
    }

    return null;
  } catch {
    return null;
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 3000);
  });
}

main();
