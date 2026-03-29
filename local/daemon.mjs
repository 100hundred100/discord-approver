#!/usr/bin/env node
// 常駐デーモン — Discordからのタスク指示をポーリングし、claude CLIを実行する
// タスクタイプ（task/file/team）に応じた実行を行う

import { spawn, execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from './config.mjs';

// claude CLI のフルパスを起動時に解決（nvm環境対応）
function findClaudePath() {
  try {
    return execSync('which claude', { encoding: 'utf8' }).trim();
  } catch {
    // which が失敗した場合は既知のnvmパスを試す
    const home = process.env.HOME || '/Users/' + process.env.USER;
    const candidates = [
      `${home}/.nvm/versions/node/v22.17.0/bin/claude`,
      `${home}/.nvm/versions/node/v20.0.0/bin/claude`,
      '/usr/local/bin/claude',
    ];
    for (const p of candidates) {
      try { execSync(`ls ${p}`); return p; } catch {}
    }
    throw new Error('claude CLI が見つかりません。`which claude` で確認してください。');
  }
}

const CLAUDE_PATH = findClaudePath();

let isProcessing = false;

async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║  Claude Code Remote Control — Daemon ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`Worker URL: ${config.workerUrl}`);
  console.log(`ポーリング間隔: ${config.daemon.pollIntervalMs / 1000}秒`);
  console.log(`デフォルト作業ディレクトリ: ${config.daemon.defaultWorkingDir}`);
  console.log(`claude CLI: ${CLAUDE_PATH}`);
  console.log('');

  process.on('SIGINT', () => {
    console.log('\n[daemon] シャットダウン...');
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    console.log('\n[daemon] シャットダウン...');
    process.exit(0);
  });

  while (true) {
    try {
      if (!isProcessing) {
        await checkAndExecuteCommands();
      }
      // セッションチャンネルの新しいメッセージをコマンドにキューイング
      await syncSessionMessages();
    } catch (err) {
      console.error(`[daemon] ポーリングエラー: ${err.message}`);
    }
    await sleep(config.daemon.pollIntervalMs);
  }
}

async function checkAndExecuteCommands() {
  const res = await fetch(`${config.workerUrl}/api/command/pending`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });

  if (!res.ok) {
    if (res.status !== 401) console.error(`[daemon] Worker応答: ${res.status}`);
    return;
  }

  const { commands } = await res.json();
  if (commands.length === 0) return;

  for (const cmd of commands) {
    await executeCommand(cmd);
  }
}

async function executeCommand(cmd) {
  isProcessing = true;
  const typeEmoji = { task: '🛠️', file: '📁', team: '👥', agents: '🤖' }[cmd.type] || '📋';
  const modeLabel = (cmd.auto_approve ?? 0) === 1 ? '🔒 permission-mode auto' : '⚡ dangerously-skip-permissions';
  console.log(`\n${typeEmoji} [${cmd.type}] タスク開始: ${cmd.id.substring(0, 8)} (${modeLabel})`);
  console.log(`  指示: ${cmd.content.substring(0, 100)}`);

  await reportStatus(cmd.id, 'running');

  // agents typeはエージェント定義があるプロジェクトルートで実行
  const workingDir = cmd.type === 'agents'
    ? config.daemon.defaultWorkingDir
    : (cmd.working_dir || config.daemon.defaultWorkingDir);

  try {
    // agents typeはオーケストレーター指示でラップする
    const instruction = cmd.type === 'agents'
      ? buildOrchestratorInstruction(cmd.content)
      : cmd.content;

    const useAutoMode = (cmd.auto_approve ?? 0) === 1;
    const result = await runClaude(instruction, workingDir, cmd.type, cmd.discord_thread_id || null, cmd.model || 'claude-sonnet-4-6', useAutoMode);
    console.log(`✅ [${cmd.type}] タスク完了: ${cmd.id.substring(0, 8)}`);
    await reportStatus(cmd.id, 'completed', result);
  } catch (err) {
    console.error(`❌ [${cmd.type}] タスク失敗: ${cmd.id.substring(0, 8)} — ${err.message}`);
    await reportStatus(cmd.id, 'failed', err.message);
  } finally {
    isProcessing = false;
  }
}

function buildOrchestratorInstruction(userInstruction) {
  return `あなたはOrchestratorです。以下のタスクをAgent Teamで進めてください。

利用可能なエージェント（Agent toolで呼び出す）:
- product-owner: 要件整理・仕様化・タスク分解
- senior-engineer: 実装・技術判断・テスト
- api-reviewer: コードレビュー（読み取り専用）

進め方:
1. タスクを分析し、必要なエージェントと順序を決める
2. Agent toolで各エージェントに明確な成果物と完了条件を渡して委任する
3. 独立したタスクは並列化する
4. 最後にビジネス要件・技術要件・検証結果をまとめて報告する

タスク: ${userInstruction}`;
}

function runClaude(instruction, cwd, type, channelId = null, model = 'claude-sonnet-4-6', useAutoMode = false) {
  return new Promise((resolve, reject) => {
    // タスクタイプに応じてタイムアウトを調整
    const timeouts = {
      task:   30 * 60 * 1000,  // 30分
      file:   10 * 60 * 1000,  // 10分
      team:   60 * 60 * 1000,  // 60分
      agents: 120 * 60 * 1000, // 120分（マルチエージェント）
    };
    const timeout = timeouts[type] || 30 * 60 * 1000;

    // CLAUDECODE環境変数を除去（ネストされたClaude Codeセッション起動エラーを防ぐ）
    const spawnEnv = { ...process.env };
    delete spawnEnv.CLAUDECODE;
    delete spawnEnv.CLAUDE_CODE_ENTRYPOINT;

    // --permission-mode auto: Anthropic社の安全しきい値で自動承認、超えたものはhook経由でDiscord手動承認
    // --dangerously-skip-permissions: 全操作を無条件承認（/auto未設定時のデフォルト）
    const permArgs = useAutoMode
      ? ['--permission-mode', 'auto']
      : ['--dangerously-skip-permissions'];
    const proc = spawn(CLAUDE_PATH, ['--print', ...permArgs, '--model', model, instruction], {
      cwd,
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    });

    // PID確定後、channel IDをファイルに書く（env var継承に依存しない）
    // approve-hook.mjs が process.ppid（= proc.pid）でこのファイルを読む
    if (channelId && proc.pid) {
      const channelFile = join(tmpdir(), `claude-remote-channel-${proc.pid}`);
      writeFileSync(channelFile, channelId);
    }

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      // channel IDファイルをクリーンアップ
      if (channelId && proc.pid) {
        try { unlinkSync(join(tmpdir(), `claude-remote-channel-${proc.pid}`)); } catch {}
      }
      if (code === 0) {
        const output = stdout.length > 3000
          ? '...(省略)...\n' + stdout.slice(-3000)
          : stdout;
        resolve(output || '(出力なし)');
      } else {
        const errorOutput = stderr || stdout || `exit code ${code}`;
        reject(new Error(errorOutput.substring(0, 2000)));
      }
    });

    proc.on('error', (err) => {
      if (channelId && proc.pid) {
        try { unlinkSync(join(tmpdir(), `claude-remote-channel-${proc.pid}`)); } catch {}
      }
      reject(new Error(`claude CLI起動失敗: ${err.message}`));
    });
  });
}

async function syncSessionMessages() {
  try {
    await fetch(`${config.workerUrl}/api/session-messages`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
  } catch {
    // ネットワークエラーは無視
  }
}

async function reportStatus(commandId, status, result = null) {
  try {
    await fetch(`${config.workerUrl}/api/command/result`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ id: commandId, status, result }),
    });
  } catch (err) {
    console.error(`[daemon] ステータス報告エラー: ${err.message}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main();
