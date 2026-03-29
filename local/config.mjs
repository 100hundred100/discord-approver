// 設定ファイル — セットアップ後に値を埋める
// 環境変数 > このファイルの値 の優先順位

export const config = {
  // Cloudflare Worker の URL（デプロイ後に設定）
  workerUrl: process.env.WORKER_URL || 'https://your-worker.workers.dev',

  // Mac↔Worker間の認証キー（Workerのsecretsと同じ値にする）
  // .env ファイルまたは環境変数 API_KEY に設定してください
  apiKey: process.env.API_KEY || '',

  // ポーリング設定
  approval: {
    pollIntervalMs: 5_000,   // 5秒ごとに確認
    timeoutMs: 600_000,      // 10分でタイムアウト
  },

  daemon: {
    pollIntervalMs: 10_000,  // 10秒ごとに新しいコマンドを確認
    // claude CLIのデフォルトワーキングディレクトリ
    defaultWorkingDir: process.env.DEFAULT_WORKING_DIR || process.env.HOME,
  },
};
