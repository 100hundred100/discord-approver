#!/usr/bin/env node
// Discord スラッシュコマンドをグローバル登録するスクリプト
// 使い方: DISCORD_TOKEN=xxx DISCORD_APPLICATION_ID=yyy node register-commands.mjs

const TOKEN = process.env.DISCORD_TOKEN;
const APP_ID = process.env.DISCORD_APPLICATION_ID;

if (!TOKEN || !APP_ID) {
  console.error('環境変数 DISCORD_TOKEN と DISCORD_APPLICATION_ID を設定してください');
  process.exit(1);
}

const modelOption = {
  name: 'model',
  description: '使用するモデル（デフォルト: Sonnet）',
  type: 3,
  required: false,
  choices: [
    { name: 'Sonnet（標準・推奨）', value: 'sonnet' },
    { name: 'Opus（高性能・低速）', value: 'opus' },
    { name: 'Haiku（軽量・高速）', value: 'haiku' },
  ],
};

const commands = [
  {
    name: 'task',
    description: '開発タスクをClaude Codeに指示する',
    options: [
      { name: 'instruction', description: '実行したい指示（自由テキスト）', type: 3, required: true },
      modelOption,
    ],
  },
  {
    name: 'file',
    description: 'ファイル操作をClaude Codeに指示する',
    options: [
      { name: 'instruction', description: '実行したい指示（自由テキスト）', type: 3, required: true },
      modelOption,
    ],
  },
  {
    name: 'team',
    description: '長期・自律タスクをClaude Codeに指示する',
    options: [
      { name: 'instruction', description: '実行したい指示（自由テキスト）', type: 3, required: true },
      modelOption,
    ],
  },
  {
    name: 'agents',
    description: 'Agent Teamに指示する（Orchestrator → product-owner / senior-engineer / api-reviewer）',
    options: [
      { name: 'instruction', description: '実行したい指示（自由テキスト）', type: 3, required: true },
      modelOption,
    ],
  },
  {
    name: 'auto',
    description: 'このチャンネルの承認リクエストを自動承認モードにする',
  },
  {
    name: 'manual',
    description: 'このチャンネルを手動承認モードに戻す',
  },
  {
    name: 'status',
    description: '現在の実行状況を確認する',
  },
  {
    name: 'history',
    description: '直近の承認・タスク履歴を表示する',
  },
  {
    name: 'setup',
    description: 'サーバーのカテゴリ・チャンネルを自動作成する（初回のみ）',
  },
];

const url = `https://discord.com/api/v10/applications/${APP_ID}/commands`;

console.log('スラッシュコマンドを登録中...');

const response = await fetch(url, {
  method: 'PUT',
  headers: {
    Authorization: `Bot ${TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(commands),
});

if (!response.ok) {
  const error = await response.text();
  console.error(`エラー: ${response.status} ${error}`);
  process.exit(1);
}

const result = await response.json();
console.log(`✅ ${result.length}個のコマンドを登録しました:`);
for (const cmd of result) {
  console.log(`  /${cmd.name} — ${cmd.description}`);
}
