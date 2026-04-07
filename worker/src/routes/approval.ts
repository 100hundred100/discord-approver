// 承認リクエスト関連のルート — セッション＆スレッド対応
import {
  createApprovalRequest,
  resolveApprovalRequest,
  getApprovalRequest,
  getOrCreateSession,
  updateSessionThread,
  getConfig,
} from '../db';
import { createSessionChannel, sendApprovalMessage, sendMessage } from '../discord';
import type { Env } from '../index';

// POST /api/request — Mac側からの承認リクエスト受付
export async function handleCreateRequest(
  request: Request,
  env: Env
): Promise<Response> {
  const body = (await request.json()) as {
    id: string;
    tool_name: string;
    tool_input?: string;
    session_id?: string;
    working_dir?: string;
    predefined_channel_id?: string; // /taskチャンネルを再利用する場合に指定
    auto_approved?: boolean;        // hook側Auto Modeで即承認済み（通知のみ）
  };

  if (!body.id || !body.tool_name) {
    return Response.json({ error: 'id and tool_name are required' }, { status: 400 });
  }

  const sessionId = body.session_id || 'default';

  // セッション取得 or 作成（working_dir を保存）
  const session = await getOrCreateSession(env.DB, sessionId, undefined, body.working_dir ?? null);

  // セッション用のDiscordチャンネルを取得 or 作成
  let threadId = session.discord_thread_id;
  if (!threadId) {
    if (body.predefined_channel_id) {
      // /task が作ったチャンネルを再利用（新チャンネル作成しない）
      threadId = body.predefined_channel_id;
      await updateSessionThread(env.DB, sessionId, threadId);
    } else {
      // 通常セッション: WORKSPACESカテゴリに新チャンネルを作成
      const guildId = await getConfig(env.DB, 'guild_id');
      const categoryId = await getConfig(env.DB, 'category_workspaces');
      if (guildId && categoryId) {
        try {
          threadId = await createSessionChannel(
            env.DISCORD_TOKEN,
            guildId,
            categoryId,
            body.working_dir ?? null
          );
          await updateSessionThread(env.DB, sessionId, threadId);
        } catch (e) {
          // チャンネル上限(50)等で作成失敗 → threadId なしで続行
          console.error('チャンネル作成失敗:', e instanceof Error ? e.message : e);
        }
      }
    }
  }

  // D1に承認リクエスト保存
  await createApprovalRequest(
    env.DB,
    body.id,
    sessionId,
    body.tool_name,
    body.tool_input ?? null
  );

  // hook側 Auto Mode: 既に即承認済み → 通知のみ送って終了
  if (body.auto_approved) {
    await resolveApprovalRequest(env.DB, body.id, 'approved');
    if (threadId) {
      const toolLabel = body.tool_name || 'ツール';
      const shortInput = formatAutoApproveNotification(body.tool_name, body.tool_input);
      await sendMessage(env.DISCORD_TOKEN, threadId, {
        content: `✅ \`${toolLabel}\`${shortInput}`,
      });
    }
    return Response.json({ ok: true, id: body.id, auto_approved: true });
  }

  // --permission-mode auto が処理できなかった操作がここに到達する
  // 常にDiscordスレッドにApprove/Denyボタンを投稿（手動承認）
  if (threadId) {
    await sendApprovalMessage(
      env.DISCORD_TOKEN,
      threadId,
      body.id,
      body.tool_name,
      body.tool_input ?? null,
      body.working_dir ?? null,
      env.MENTION_USER_ID
    );
  }

  return Response.json({ ok: true, id: body.id });
}

// Auto Mode 通知用: ツール種別に応じた短い要約を返す
function formatAutoApproveNotification(toolName: string, toolInput?: string): string {
  if (!toolInput) return '';
  try {
    if (toolName === 'Bash') {
      // formatToolInput で整形済みの場合「💻 実行されるコマンド:\n...」形式
      const match = toolInput.match(/実行されるコマンド:\n(.+)/s);
      const cmd = match ? match[1].trim() : toolInput;
      const short = cmd.length > 80 ? cmd.substring(0, 80) + '…' : cmd;
      return ` — \`${short}\``;
    }
    if (toolName === 'Edit') {
      const match = toolInput.match(/対象ファイル: (.+)/);
      return match ? ` — ${match[1]}` : '';
    }
    if (toolName === 'Write') {
      const match = toolInput.match(/ファイル: (.+)/);
      return match ? ` — ${match[1]}` : '';
    }
  } catch { /* ignore */ }
  return '';
}

// GET /api/request/:id — Mac側からの承認結果ポーリング
export async function handleGetRequest(
  id: string,
  env: Env
): Promise<Response> {
  const req = await getApprovalRequest(env.DB, id);

  if (!req) {
    return Response.json({ error: 'not found' }, { status: 404 });
  }

  return Response.json({
    id: req.id,
    status: req.status,
    resolved_at: req.resolved_at,
  });
}
