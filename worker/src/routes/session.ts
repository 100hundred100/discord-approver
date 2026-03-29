// セッションチャンネル双方向同期

const MODEL_MAP: Record<string, string> = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};
const DEFAULT_MODEL = 'claude-sonnet-4-6';

// [opus] / [sonnet] / [haiku] プレフィックスを解析してモデルと指示テキストを分離
function parseModelPrefix(content: string): { model: string; instruction: string } {
  const match = content.match(/^\[(opus|sonnet|haiku)\]\s*/i);
  if (match) {
    return {
      model: MODEL_MAP[match[1].toLowerCase()],
      instruction: content.slice(match[0].length).trim(),
    };
  }
  return { model: DEFAULT_MODEL, instruction: content };
}

import {
  getActiveSessions,
  updateSessionLastMessageId,
  createCommand,
  getTaskChannels,
  updateTaskChannelLastMessage,
  setTaskChannelAutoApprove,
} from '../db';
import { getChannelMessages, sendToolDoneNotification, sendMessage } from '../discord';
import type { Env } from '../index';

// GET /api/session-messages
// セッションチャンネルの新しいユーザーメッセージを commands にキューイング
export async function handleSessionMessages(env: Env): Promise<Response> {
  const sessions = await getActiveSessions(env.DB);
  const botId = env.DISCORD_APPLICATION_ID;
  let queued = 0;

  for (const session of sessions) {
    if (!session.discord_thread_id) continue;

    const messages = await getChannelMessages(
      env.DISCORD_TOKEN,
      session.discord_thread_id,
      session.last_discord_message_id ?? undefined
    );

    // まだ last_discord_message_id がない場合は初期スナップショットを取るだけ
    if (!session.last_discord_message_id) {
      if (messages.length > 0) {
        const latestId = messages.reduce((max, m) => (m.id > max ? m.id : max), '0');
        await updateSessionLastMessageId(env.DB, session.id, latestId);
      }
      continue;
    }

    // ボットを除く人間のメッセージのみ処理
    const humanMessages = messages.filter((m) => !m.author.bot && m.content.trim());

    if (humanMessages.length > 0) {
      const latestId = humanMessages.reduce((max, m) => (m.id > max ? m.id : max), '0');
      await updateSessionLastMessageId(env.DB, session.id, latestId);

      for (const msg of humanMessages) {
        const raw = msg.content.trim();

        // @mention + auto/manual をセッションチャンネルでも検出
        const mentionStripped = raw.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
        const keyword = mentionStripped.toLowerCase();
        const hasMention = raw.includes(`<@${botId}>`) || raw.includes(`<@!${botId}>`);

        if (hasMention && keyword === 'auto') {
          await setTaskChannelAutoApprove(env.DB, session.discord_thread_id!, true, session.working_dir ?? null);
          await sendMessage(env.DISCORD_TOKEN, session.discord_thread_id!, {
            content: '✅ **自動承認モード ON** — このチャンネルの承認リクエストは全て自動でApproveされます。\n解除するには `@bot manual` と送ってください。',
          });
          continue;
        }
        if (hasMention && keyword === 'manual') {
          await setTaskChannelAutoApprove(env.DB, session.discord_thread_id!, false, session.working_dir ?? null);
          await sendMessage(env.DISCORD_TOKEN, session.discord_thread_id!, {
            content: '🔒 **自動承認モード OFF** — 承認リクエストは手動で確認します。',
          });
          continue;
        }

        const { model, instruction } = parseModelPrefix(raw);
        const commandId = crypto.randomUUID();
        await createCommand(
          env.DB,
          commandId,
          'session',
          instruction,
          [],
          session.working_dir ?? null,
          0,
          session.discord_thread_id,
          model
        );
        queued++;
      }
    }
  }

  // タスクチャンネル（WORKSPACES）の @mention メッセージをコマンドにキューイング
  const taskChannels = await getTaskChannels(env.DB);

  for (const tc of taskChannels) {
    const messages = await getChannelMessages(
      env.DISCORD_TOKEN,
      tc.channel_id,
      tc.last_message_id ?? undefined
    );

    if (messages.length === 0) continue;

    // カーソルを最新メッセージIDに進める
    const latestId = messages.reduce((max, m) => (m.id > max ? m.id : max), '0');

    // 初回スナップショット（既存メッセージを指示として拾わない）
    if (!tc.last_message_id) {
      await updateTaskChannelLastMessage(env.DB, tc.channel_id, latestId);
      continue;
    }

    // Claudeくん（このbot）へのメンションのみ処理
    const mentionMessages = messages.filter(
      (m) =>
        !m.author.bot &&
        (m.content.includes(`<@${botId}>`) || m.content.includes(`<@!${botId}>`))
    );

    // カーソルを進める（mention有無に関わらず）
    await updateTaskChannelLastMessage(env.DB, tc.channel_id, latestId);

    for (const msg of mentionMessages) {
      // @mention部分を除去してから[model]プレフィックスを解析
      const raw = msg.content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
      if (!raw) continue;

      // auto / manual コマンドを検出して承認モードを切り替える
      const keyword = raw.toLowerCase();
      if (keyword === 'auto') {
        await setTaskChannelAutoApprove(env.DB, tc.channel_id, true);
        await sendMessage(env.DISCORD_TOKEN, tc.channel_id, {
          content: '✅ **自動承認モード ON** — このチャンネルの承認リクエストは全て自動でApproveされます。\n解除するには `@bot manual` と送ってください。',
        });
        continue;
      }
      if (keyword === 'manual') {
        await setTaskChannelAutoApprove(env.DB, tc.channel_id, false);
        await sendMessage(env.DISCORD_TOKEN, tc.channel_id, {
          content: '🔒 **自動承認モード OFF** — 承認リクエストは手動で確認します。',
        });
        continue;
      }

      const { model, instruction } = parseModelPrefix(raw);
      const commandId = crypto.randomUUID();
      await createCommand(
        env.DB,
        commandId,
        'task',
        instruction,
        [],
        tc.working_dir,
        0,
        tc.channel_id,
        model
      );
      queued++;
    }
  }

  return Response.json({ ok: true, queued });
}

// POST /api/tool-done
// PostToolUseフックからツール完了通知を受けて、セッションチャンネルに投稿
export async function handleToolDone(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as {
    session_id: string;
    tool_name: string;
    summary: string;
    output?: string;
  };

  if (!body.session_id || !body.tool_name) {
    return Response.json({ error: 'session_id and tool_name required' }, { status: 400 });
  }

  // セッションのDiscordチャンネルに通知
  const session = await env.DB
    .prepare('SELECT discord_thread_id FROM sessions WHERE id = ?')
    .bind(body.session_id)
    .first<{ discord_thread_id: string | null }>();

  if (session?.discord_thread_id) {
    await sendToolDoneNotification(
      env.DISCORD_TOKEN,
      session.discord_thread_id,
      body.tool_name,
      body.summary,
      body.output
    );
  }

  return Response.json({ ok: true });
}
