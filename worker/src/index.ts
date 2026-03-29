// メイン Worker — ルーティング
import { verifyDiscordSignature } from './discord';
import { handleCreateRequest, handleGetRequest } from './routes/approval';
import { handlePendingCommands, handleCommandResult } from './routes/command';
import { handleInteraction } from './routes/interaction';
import { handleSessionMessages, handleToolDone } from './routes/session';

export interface Env {
  DB: D1Database;
  API_KEY: string;
  DISCORD_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS（ローカルテスト用）
    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    // --- Discord Interaction ---
    if (method === 'POST' && path === '/api/interaction') {
      return handleDiscordInteraction(request, env);
    }

    // --- Mac側 API (認証必要) ---
    if (path.startsWith('/api/')) {
      const authError = verifyApiKey(request, env);
      if (authError) return authError;

      // 承認
      if (method === 'POST' && path === '/api/request') {
        return handleCreateRequest(request, env);
      }
      if (method === 'GET' && path.startsWith('/api/request/')) {
        const id = path.replace('/api/request/', '');
        return handleGetRequest(id, env);
      }

      // コマンド
      if (method === 'GET' && path === '/api/command/pending') {
        return handlePendingCommands(env);
      }
      if (method === 'POST' && path === '/api/command/result') {
        return handleCommandResult(request, env);
      }

      // セッション双方向同期
      if (method === 'GET' && path === '/api/session-messages') {
        return handleSessionMessages(env);
      }
      if (method === 'POST' && path === '/api/tool-done') {
        return handleToolDone(request, env);
      }
    }

    // ヘルスチェック
    if (path === '/' || path === '/health') {
      return Response.json({ status: 'ok', service: 'claude-remote-control' });
    }

    return Response.json({ error: 'not found' }, { status: 404 });
  },
};

function verifyApiKey(request: Request, env: Env): Response | null {
  const auth = request.headers.get('Authorization');
  if (!auth || auth !== `Bearer ${env.API_KEY}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}

async function handleDiscordInteraction(
  request: Request,
  env: Env
): Promise<Response> {
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');

  if (!signature || !timestamp) {
    return Response.json({ error: 'missing signature' }, { status: 401 });
  }

  const bodyText = await request.text();

  const isValid = await verifyDiscordSignature(
    env.DISCORD_PUBLIC_KEY,
    signature,
    timestamp,
    bodyText
  );

  if (!isValid) {
    return Response.json({ error: 'invalid signature' }, { status: 401 });
  }

  const body = JSON.parse(bodyText);
  return handleInteraction(body, env);
}
