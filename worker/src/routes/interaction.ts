// Discord Interaction 処理 — スラッシュコマンド拡張＆スレッド対応
import {
  resolveApprovalRequest,
  createCommand,
  getPendingApprovals,
  getRecentItems,
  getRunningAndPendingCommands,
  getConfig,
  getAllConfig,
  setConfig,
  registerTaskChannel,
  setTaskChannelAutoApprove,
  isAutoApprove,
} from '../db';
import {
  createTaskChannel,
  sendTaskReceived,
  sendAgentTeamReceived,
  sendStatusUpdate,
  setupServerStructure,
} from '../discord';
import type { Env } from '../index';

const INTERACTION_TYPE = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
} as const;

const RESPONSE_TYPE = {
  PONG: 1,
  CHANNEL_MESSAGE: 4,
  UPDATE_MESSAGE: 7,
} as const;

export async function handleInteraction(body: any, env: Env): Promise<Response> {
  if (body.type === INTERACTION_TYPE.PING) {
    return Response.json({ type: RESPONSE_TYPE.PONG });
  }

  if (body.type === INTERACTION_TYPE.MESSAGE_COMPONENT) {
    return handleButton(body, env);
  }

  if (body.type === INTERACTION_TYPE.APPLICATION_COMMAND) {
    return handleSlashCommand(body, env);
  }

  return Response.json({ error: 'unknown interaction type' }, { status: 400 });
}

// --- ボタンハンドラ ---

async function handleButton(body: any, env: Env): Promise<Response> {
  const customId: string = body.data.custom_id;
  const [action, requestId] = customId.split(':');

  if (!requestId || (action !== 'approve' && action !== 'deny')) {
    return ephemeralReply('不明なアクションです。');
  }

  const status = action === 'approve' ? 'approved' : 'denied';
  const resolved = await resolveApprovalRequest(env.DB, requestId, status);

  if (!resolved) {
    return ephemeralReply('⚠️ このリクエストは既に処理済みか、期限切れです。');
  }

  const emoji = action === 'approve' ? '✅' : '❌';
  const label = action === 'approve' ? '承認しました' : '拒否しました';

  return Response.json({
    type: RESPONSE_TYPE.UPDATE_MESSAGE,
    data: {
      embeds: body.message.embeds,
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: action === 'approve' ? 3 : 4,
              label: `${emoji} ${label}`,
              custom_id: 'resolved',
              disabled: true,
            },
          ],
        },
      ],
    },
  });
}

// --- スラッシュコマンドハンドラ ---

async function handleSlashCommand(body: any, env: Env): Promise<Response> {
  const name: string = body.data.name;

  switch (name) {
    case 'task':
      return handleTaskCommand(body, env, 'task');
    case 'file':
      return handleTaskCommand(body, env, 'file');
    case 'team':
      return handleTaskCommand(body, env, 'team');
    case 'agents':
      return handleAgentsCommand(body, env);
    case 'auto':
      return handleAutoCommand(body, env, true);
    case 'manual':
      return handleAutoCommand(body, env, false);
    case 'status':
      return handleStatusCommand(env);
    case 'history':
      return handleHistoryCommand(env);
    case 'setup':
      return handleSetupCommand(body, env);
    default:
      return ephemeralReply(`不明なコマンド: /${name}`);
  }
}

// --- /task, /file, /team — タスク投入 ---

async function handleTaskCommand(
  body: any,
  env: Env,
  type: string
): Promise<Response> {
  const options = body.data.options as { name: string; value: string }[] | undefined;
  const instruction = options?.find((o) => o.name === 'instruction')?.value;
  if (!instruction) {
    return ephemeralReply(`⚠️ 指示内容を入力してください。例: \`/${type} APIサーバーを作って\``);
  }

  // modelオプション: opus / haiku / sonnet（デフォルト）
  const MODEL_MAP: Record<string, string> = {
    opus: 'claude-opus-4-6',
    sonnet: 'claude-sonnet-4-6',
    haiku: 'claude-haiku-4-5-20251001',
  };
  const modelKey = options?.find((o) => o.name === 'model')?.value ?? 'sonnet';
  const model = MODEL_MAP[modelKey] ?? 'claude-sonnet-4-6';

  // チャンネルを先に作成してからコマンドを登録（race condition防止）
  const guildId = await getConfig(env.DB, 'guild_id');
  const categoryId = await getConfig(env.DB, 'category_workspaces');

  let channelId: string | null = null;
  if (guildId && categoryId) {
    channelId = await createTaskChannel(
      env.DISCORD_TOKEN,
      guildId,
      categoryId,
      instruction,
      type
    );
    await registerTaskChannel(env.DB, channelId);
  }

  // discord_thread_id・model をコマンド作成時に同時にセット
  const commandId = crypto.randomUUID();
  await createCommand(env.DB, commandId, type, instruction, [], null, 0, channelId, model);

  if (channelId) {
    await sendTaskReceived(env.DISCORD_TOKEN, channelId, commandId, instruction);
  }

  const modelLabel = { 'claude-opus-4-6': ' [Opus]', 'claude-haiku-4-5-20251001': ' [Haiku]' }[model] ?? '';
  const typeLabel = { task: '開発タスク', file: 'ファイル操作', team: 'チームタスク' }[type] || 'タスク';
  return ephemeralReply(
    `📋 **${typeLabel}${modelLabel}**を受け付けました！\n> ${instruction}\n\nID: \`${commandId.substring(0, 8)}\`\nMac側で実行されます。`
  );
}

// --- /agents — Orchestrator Agent Team 起動 ---

async function handleAgentsCommand(body: any, env: Env): Promise<Response> {
  const options = body.data.options as { name: string; value: string }[] | undefined;
  const instruction = options?.find((o) => o.name === 'instruction')?.value;
  if (!instruction) {
    return ephemeralReply('⚠️ タスクを入力してください。例: `/agents APIサーバーを設計・実装して`');
  }

  const MODEL_MAP: Record<string, string> = {
    opus: 'claude-opus-4-6',
    sonnet: 'claude-sonnet-4-6',
    haiku: 'claude-haiku-4-5-20251001',
  };
  const modelKey = options?.find((o) => o.name === 'model')?.value ?? 'sonnet';
  const model = MODEL_MAP[modelKey] ?? 'claude-sonnet-4-6';

  const guildId = await getConfig(env.DB, 'guild_id');
  const categoryId = await getConfig(env.DB, 'category_agent_teams');

  let channelId: string | null = null;
  if (guildId && categoryId) {
    channelId = await createTaskChannel(env.DISCORD_TOKEN, guildId, categoryId, instruction, 'agents');
    await registerTaskChannel(env.DB, channelId);
  }

  const commandId = crypto.randomUUID();
  await createCommand(env.DB, commandId, 'agents', instruction, [], null, 0, channelId, model);

  if (channelId) {
    await sendAgentTeamReceived(env.DISCORD_TOKEN, channelId, commandId, instruction, model);
  }

  const modelLabel = { 'claude-opus-4-6': ' [Opus]', 'claude-haiku-4-5-20251001': ' [Haiku]' }[model] ?? '';
  return ephemeralReply(
    `🤖 **Agent Team${modelLabel}**を起動しました！\n> ${instruction}\n\nID: \`${commandId.substring(0, 8)}\`\nOrchestrator → product-owner / senior-engineer / api-reviewer が連携して実行します。`
  );
}

// --- /auto, /manual — 自動承認モード切替 ---

async function handleAutoCommand(body: any, env: Env, enable: boolean): Promise<Response> {
  const channelId: string | undefined = body.channel_id;
  if (!channelId) {
    return ephemeralReply('⚠️ チャンネル情報が取得できませんでした。');
  }

  await setTaskChannelAutoApprove(env.DB, channelId, enable);

  if (enable) {
    return ephemeralReply('✅ **permission-mode auto ON** — `--permission-mode auto` で実行します。\nAnthropic社の安全しきい値を超える操作のみ Discord で手動承認が必要です。\n`/manual` で全操作スキップ（`--dangerously-skip-permissions`）に戻せます。');
  } else {
    return ephemeralReply('🔔 **全操作スキップモード** — `--dangerously-skip-permissions` で実行します。全ての操作が自動承認されます。');
  }
}

// --- /status ---

async function handleStatusCommand(env: Env): Promise<Response> {
  const pendingApprovals = await getPendingApprovals(env.DB);
  const activeCommands = await getRunningAndPendingCommands(env.DB);

  const running = activeCommands.filter((c) => c.status === 'running');
  const pending = activeCommands.filter((c) => c.status === 'pending');

  let msg = '📊 **現在の状況**\n\n';

  if (pendingApprovals.length > 0) {
    msg += `🔔 **承認待ち: ${pendingApprovals.length}件**\n`;
    for (const a of pendingApprovals.slice(0, 5)) {
      msg += `  \`${a.tool_name}\` (${a.id.substring(0, 8)})\n`;
    }
    msg += '\n';
  } else {
    msg += '🔔 承認待ち: なし\n\n';
  }

  if (running.length > 0) {
    msg += `⚡ **実行中: ${running.length}件**\n`;
    for (const c of running) {
      const t = c.content.length > 50 ? c.content.substring(0, 50) + '...' : c.content;
      msg += `  [${c.type}] ${t}\n`;
    }
    msg += '\n';
  } else {
    msg += '⚡ 実行中: なし\n\n';
  }

  if (pending.length > 0) {
    msg += `📋 **待機中: ${pending.length}件**\n`;
    for (const c of pending) {
      const t = c.content.length > 50 ? c.content.substring(0, 50) + '...' : c.content;
      msg += `  [${c.type}] ${t}\n`;
    }
  } else {
    msg += '📋 待機中: なし\n';
  }

  // ステータスボードにも投稿
  const statusChannelId = await getConfig(env.DB, 'channel_status_board');
  if (statusChannelId) {
    await sendStatusUpdate(env.DISCORD_TOKEN, statusChannelId, msg);
  }

  return ephemeralReply(msg);
}

// --- /history ---

async function handleHistoryCommand(env: Env): Promise<Response> {
  const { approvals, commands } = await getRecentItems(env.DB, 10);

  let msg = '📜 **直近の履歴**\n\n';

  if (approvals.length > 0) {
    msg += '**承認リクエスト:**\n';
    for (const a of approvals.slice(0, 5)) {
      const emoji = a.status === 'approved' ? '✅' : a.status === 'denied' ? '❌' : '⏳';
      msg += `${emoji} \`${a.tool_name}\` — ${a.status}\n`;
    }
    msg += '\n';
  }

  if (commands.length > 0) {
    msg += '**タスク:**\n';
    for (const c of commands.slice(0, 5)) {
      const emoji = c.status === 'completed' ? '✅' : c.status === 'failed' ? '❌' : c.status === 'running' ? '⚡' : '📋';
      const t = c.content.length > 40 ? c.content.substring(0, 40) + '...' : c.content;
      msg += `${emoji} [${c.type}] ${t} — ${c.status}\n`;
    }
  }

  if (approvals.length === 0 && commands.length === 0) {
    msg += '(まだ履歴がありません)';
  }

  return ephemeralReply(msg);
}

// --- /setup — サーバー構造の自動作成 ---

async function handleSetupCommand(body: any, env: Env): Promise<Response> {
  const guildId = body.guild_id;
  if (!guildId) {
    return ephemeralReply('⚠️ サーバー内でのみ使用できます。');
  }

  // 既にセットアップ済みか確認（category_workspaces の有無で判定）
  const existing = await getConfig(env.DB, 'category_workspaces');
  if (existing) {
    return ephemeralReply('⚠️ サーバーは既にセットアップ済みです。再セットアップする場合は `/setup reset` または D1 の server_config を削除してください。');
  }

  try {
    const structure = await setupServerStructure(env.DISCORD_TOKEN, guildId);

    // チャンネルIDをD1に保存
    await setConfig(env.DB, 'guild_id', guildId);
    for (const [key, id] of Object.entries(structure.channels)) {
      await setConfig(env.DB, `channel_${key}`, id);
    }
    for (const [key, id] of Object.entries(structure.categories)) {
      await setConfig(env.DB, `category_${key}`, id);
    }

    // セットアップ完了メッセージをdispatchチャンネルに投稿
    const dispatchId = structure.channels['dispatch'];
    if (dispatchId) {
      await fetch(`https://discord.com/api/v10/channels/${dispatchId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${env.DISCORD_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          embeds: [{
            title: '🎉 Claude Code Remote Control — セットアップ完了',
            description: [
              '**使い方:**',
              '`/task <指示>` — 開発タスクを指示',
              '`/file <指示>` — ファイル操作を指示',
              '`/team <指示>` — チーム（長期）タスクを指示',
              '`/status` — 現在の状況を確認',
              '`/history` — 履歴を確認',
              '',
              'Claude Codeのセッション・タスクは **💻 WORKSPACES** にチャンネルとして自動作成されます。',
              '承認リクエスト・ツール通知・タスク結果はそれぞれのチャンネルに届きます。',
            ].join('\n'),
            color: 0x22c55e,
            timestamp: new Date().toISOString(),
          }],
        }),
      });
    }

    return ephemeralReply('✅ サーバー構造のセットアップが完了しました！各カテゴリとチャンネルが作成されました。');
  } catch (err: any) {
    return ephemeralReply(`❌ セットアップエラー: ${err.message}`);
  }
}

// --- ヘルパー ---

function ephemeralReply(content: string): Response {
  return Response.json({
    type: RESPONSE_TYPE.CHANNEL_MESSAGE,
    data: { content, flags: 64 },
  });
}
