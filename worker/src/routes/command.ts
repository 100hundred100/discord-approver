// コマンド関連のルート — スレッド＆チャンネルルーティング対応
import {
  getPendingCommands,
  updateCommandStatus,
  getCommand,
  getConfig,
} from '../db';
import { sendTaskStatusUpdate } from '../discord';
import type { Env } from '../index';

// GET /api/command/pending — Mac側から未実行コマンド取得
export async function handlePendingCommands(env: Env): Promise<Response> {
  const commands = await getPendingCommands(env.DB);
  return Response.json({ commands });
}

// POST /api/command/result — Mac側からコマンド実行結果を報告
export async function handleCommandResult(
  request: Request,
  env: Env
): Promise<Response> {
  const body = (await request.json()) as {
    id: string;
    status: 'running' | 'completed' | 'failed';
    result?: string;
  };

  if (!body.id || !body.status) {
    return Response.json({ error: 'id and status are required' }, { status: 400 });
  }

  const cmd = await updateCommandStatus(
    env.DB,
    body.id,
    body.status,
    body.result ?? null
  );

  if (!cmd) {
    return Response.json({ error: 'command not found' }, { status: 404 });
  }

  // タスクのDiscordスレッドに進捗を投稿
  if (cmd.discord_thread_id) {
    await sendTaskStatusUpdate(
      env.DISCORD_TOKEN,
      cmd.discord_thread_id,
      body.id,
      body.status,
      body.result ?? null
    );
  }

  // 完了/失敗したタスクのログをアーカイブチャンネルに投稿
  if (body.status === 'completed' || body.status === 'failed') {
    const archiveChannelId = await getConfig(env.DB, 'channel_completed_tasks');
    if (archiveChannelId) {
      const emoji = body.status === 'completed' ? '✅' : '❌';
      const truncatedContent = cmd.content.length > 100
        ? cmd.content.substring(0, 100) + '...'
        : cmd.content;
      const truncatedResult = body.result
        ? body.result.length > 300
          ? body.result.substring(0, 300) + '...'
          : body.result
        : '(出力なし)';

      await fetch(`https://discord.com/api/v10/channels/${archiveChannelId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${env.DISCORD_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          embeds: [{
            title: `${emoji} [${cmd.type}] ${truncatedContent}`,
            description: `\`\`\`\n${truncatedResult}\n\`\`\``,
            color: body.status === 'completed' ? 0x22c55e : 0xef4444,
            footer: { text: `ID: ${cmd.id.substring(0, 8)}` },
            timestamp: new Date().toISOString(),
          }],
        }),
      });
    }
  }

  return Response.json({ ok: true });
}
