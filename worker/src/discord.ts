// Discord API 連携 — チャンネル・スレッド管理対応

const DISCORD_API = 'https://discord.com/api/v10';

// --- 署名検証 ---

export async function verifyDiscordSignature(
  publicKey: string,
  signature: string,
  timestamp: string,
  body: string
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    hexToUint8Array(publicKey),
    { name: 'Ed25519', namedCurve: 'Ed25519' },
    false,
    ['verify']
  );
  const message = new TextEncoder().encode(timestamp + body);
  return await crypto.subtle.verify('Ed25519', key, hexToUint8Array(signature), message);
}

function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

// --- セッション専用チャンネル作成 ---

const CATEGORY_CHANNEL_LIMIT = 50; // Discord の上限
const CHANNELS_TO_KEEP = 10;       // 最新N個を残して古いものを削除

/** カテゴリ内チャンネルが上限に近づいたら古い順に削除して空きを確保 */
async function pruneOldChannels(
  botToken: string,
  guildId: string,
  categoryId: string
): Promise<void> {
  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/channels`, {
    headers: { Authorization: `Bot ${botToken}` },
  });
  if (!res.ok) return;

  const all = (await res.json()) as { id: string; parent_id?: string; type: number }[];
  const categoryChannels = all
    .filter(c => c.parent_id === categoryId && c.type === 0)
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)); // 古い順

  // 最新 CHANNELS_TO_KEEP 本だけ残して古いものを削除
  const deleteCount = categoryChannels.length - CHANNELS_TO_KEEP;
  if (deleteCount <= 0) return;

  const toDelete = categoryChannels.slice(0, deleteCount);
  for (const ch of toDelete) {
    await fetch(`${DISCORD_API}/channels/${ch.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bot ${botToken}` },
    });
  }
}

export async function createSessionChannel(
  botToken: string,
  guildId: string,
  categoryId: string,
  workingDir: string | null
): Promise<string> {
  // 上限に近い場合は古いチャンネルを事前削除
  await pruneOldChannels(botToken, guildId, categoryId);
  // チャンネル名: 作業ディレクトリの末尾フォルダ名 + 時刻
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');

  let channelName: string;
  if (workingDir) {
    const parts = workingDir.replace(/\\/g, '/').split('/').filter(Boolean);
    const lastDir = parts[parts.length - 1] || 'session';
    // Discordチャンネル名: 小文字・半角記号のみ（スペース→ハイフン）
    const safeName = lastDir.toLowerCase().replace(/[^a-z0-9\u3040-\u9fff-]/g, '-').substring(0, 20);
    channelName = `${safeName}-${mm}${dd}-${hh}${min}`;
  } else {
    channelName = `sess-${mm}${dd}-${hh}${min}`;
  }

  const topic = workingDir
    ? `📂 ${workingDir} | 開始: ${now.toISOString().replace('T', ' ').substring(0, 16)} JST`
    : `セッション開始: ${now.toISOString().replace('T', ' ').substring(0, 16)}`;

  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/channels`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: channelName,
      type: 0, // GUILD_TEXT
      parent_id: categoryId,
      topic,
    }),
  });

  const data = (await res.json()) as any;
  if (!res.ok || !data.id) {
    throw new Error(`セッションチャンネル作成失敗: ${JSON.stringify(data)}`);
  }
  return data.id;
}

// --- スレッド作成 ---

export async function createThread(
  botToken: string,
  channelId: string,
  name: string,
  messageContent?: string
): Promise<string> {
  // まずメッセージを送ってからスレッドを開始する（公開スレッド）
  // メッセージなしでスレッドを作る場合
  const threadName = name.length > 100 ? name.substring(0, 97) + '...' : name;

  const res = await fetch(`${DISCORD_API}/channels/${channelId}/threads`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: threadName,
      type: 11, // PUBLIC_THREAD
      auto_archive_duration: 1440, // 24時間で自動アーカイブ
    }),
  });

  const thread = (await res.json()) as { id: string };

  // スレッドに初期メッセージを投稿
  if (messageContent) {
    await sendMessage(botToken, thread.id, { content: messageContent });
  }

  return thread.id;
}

// --- メッセージ送信（汎用） ---

interface MessagePayload {
  content?: string;
  embeds?: any[];
  components?: any[];
}

export async function sendMessage(
  botToken: string,
  channelOrThreadId: string,
  payload: MessagePayload
): Promise<string> {
  const res = await fetch(`${DISCORD_API}/channels/${channelOrThreadId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const msg = (await res.json()) as { id: string };
  return msg.id;
}

// --- 承認リクエスト（スレッド内に投稿） ---

const MENTION_USER = '<@597453476578197518>';

// ────────────────────────────────────────────────────────────────
// Bash コマンドの日本語解説ジェネレーター
// ────────────────────────────────────────────────────────────────

/** フォーマット済み toolInput からコマンド文字列を抽出 */
function extractCommand(toolInput: string): string {
  const match = toolInput.match(/実行されるコマンド:\n([\s\S]+)/);
  return match ? match[1].trim() : toolInput.trim();
}

/** パスを短く表示（/Users/foo/bar/baz → ~/bar/baz） */
function shortenPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

/** 単一コマンドトークン（スペース区切り）を解析して日本語説明を返す */
function explainSingleCommand(cmd: string): string {
  const t = cmd.trim();
  if (!t) return '';

  const parts = t.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [t];
  const bin = parts[0].replace(/^.*\//, ''); // basename
  const args = parts.slice(1);

  // ── cd ──
  if (bin === 'cd') {
    const dir = shortenPath(args[0] ?? '');
    return `「${dir}」フォルダに移動`;
  }

  // ── git ──
  if (bin === 'git') {
    const sub = args[0];
    const sub2 = args[1];
    if (sub === 'status')  return 'Gitの変更状態を確認';
    if (sub === 'log')     return 'Gitのコミット履歴を確認';
    if (sub === 'diff')    return 'Gitの変更差分を確認';
    if (sub === 'fetch')   return 'リモートリポジトリの最新情報を取得（ローカルは変更しない）';
    if (sub === 'pull')    return 'リモートリポジトリから最新の変更を取り込む';
    if (sub === 'stash')   return 'まだコミットしていない変更を一時退避';
    if (sub === 'show')    return '特定のコミット内容を確認';
    if (sub === 'branch')  return 'ブランチ一覧を確認';
    if (sub === 'checkout' || sub === 'switch') {
      const target = args.find(a => !a.startsWith('-')) ?? '';
      return target ? `「${target}」ブランチに切り替え` : 'ブランチを切り替え';
    }
    if (sub === 'add') {
      const files = args.filter(a => !a.startsWith('-')).join(', ');
      return `ファイルをコミット対象に追加（${files || 'すべて'}）`;
    }
    if (sub === 'commit') {
      const msgIdx = args.findIndex(a => a === '-m');
      const msg = msgIdx >= 0 ? (args[msgIdx + 1] ?? '').replace(/^["']|["']$/g, '') : '';
      const hasNoVerify = args.includes('--no-verify');
      let desc = msg ? `コミットメッセージ「${msg.substring(0, 40)}」でコミット` : 'コミットを作成';
      if (hasNoVerify) desc += '（フック検証をスキップ）';
      return desc;
    }
    if (sub === 'push') {
      const force = args.some(a => a === '--force' || a === '-f');
      const remote = args.find(a => !a.startsWith('-') && a !== sub) ?? 'origin';
      return force
        ? `⚠️ リモート「${remote}」に強制プッシュ（履歴を上書きします）`
        : `リモート「${remote}」にプッシュ（変更をアップロード）`;
    }
    if (sub === 'reset') {
      const hard = args.includes('--hard');
      return hard
        ? '⚠️ git reset --hard：コミットされていない変更をすべて破棄して巻き戻し'
        : 'コミットを取り消してファイルの変更は残す';
    }
    if (sub === 'merge') {
      const branch = args.find(a => !a.startsWith('-')) ?? '';
      return `「${branch}」ブランチをマージ`;
    }
    if (sub === 'rebase') return 'コミット履歴をリベース（整理）';
    if (sub === 'tag')    return 'タグを操作';
    if (sub === 'clone') {
      const repo = args.find(a => !a.startsWith('-')) ?? '';
      return `「${repo}」リポジトリをクローン（ダウンロード）`;
    }
    return `Git操作（git ${sub}）`;
  }

  // ── npm / pnpm / yarn ──
  if (bin === 'npm' || bin === 'pnpm' || bin === 'yarn') {
    const mgr = bin;
    const sub = args[0];
    if (sub === 'install' || sub === 'i') {
      const pkg = args.find(a => !a.startsWith('-') && a !== sub);
      return pkg
        ? `「${pkg}」パッケージをインストール`
        : 'package.jsonに記載された全パッケージをインストール';
    }
    if (sub === 'run') {
      const script = args[1] ?? '';
      const scriptDescMap: Record<string, string> = {
        build:  'プロジェクトをビルド（本番用に変換）',
        test:   'テストを実行',
        dev:    '開発サーバーを起動',
        start:  'サーバーを起動',
        lint:   'コードのスタイルチェックを実行',
        format: 'コードのフォーマットを整える',
        check:  '型チェックを実行',
        deploy: 'デプロイを実行',
      };
      return scriptDescMap[script] ?? `「${script}」スクリプトを実行（${mgr} run ${script}）`;
    }
    if (sub === 'build')   return 'プロジェクトをビルド（本番用に変換）';
    if (sub === 'test')    return 'テストを実行';
    if (sub === 'dev')     return '開発サーバーを起動';
    if (sub === 'start')   return 'サーバーを起動';
    if (sub === 'lint')    return 'コードのスタイルチェックを実行';
    if (sub === 'format')  return 'コードのフォーマットを整える';
    if (sub === 'check')   return '型チェックを実行';
    if (sub === 'deploy')  return 'デプロイを実行';
    if (sub === 'add')     return `パッケージを追加（${args.filter(a => !a.startsWith('-')).slice(1).join(', ')}）`;
    if (sub === 'remove' || sub === 'uninstall') return `パッケージを削除`;
    if (sub === 'update')  return 'パッケージを更新';
    return `${mgr}コマンドを実行（${mgr} ${sub}）`;
  }

  // ── npx ──
  if (bin === 'npx') {
    const tool = args.find(a => !a.startsWith('-')) ?? '';
    if (tool === 'tsc') {
      const noEmit = args.includes('--noEmit');
      return noEmit ? 'TypeScriptの型チェックのみ実行（ファイルは生成しない）' : 'TypeScriptをJavaScriptにコンパイル';
    }
    if (tool === 'wrangler') {
      const sub = args[args.indexOf(tool) + 1] ?? '';
      if (sub === 'deploy') return 'Cloudflare Workersにデプロイ（公開サーバーに反映）';
      if (sub === 'dev')    return 'Cloudflare Workersをローカルで起動';
      if (sub === 'd1')     return 'Cloudflare D1データベースを操作';
      return `Wranglerコマンドを実行（${sub}）`;
    }
    return `「${tool}」ツールをnpxで実行`;
  }

  // ── tsc ──
  if (bin === 'tsc') {
    const noEmit = args.includes('--noEmit') || args.includes('--no-emit');
    return noEmit ? 'TypeScriptの型チェックのみ実行（ファイルは生成しない）' : 'TypeScriptをJavaScriptにコンパイル';
  }

  // ── python / python3 ──
  if (bin === 'python' || bin === 'python3' || t.match(/\.venv\/bin\/python|venv\/bin\/python/)) {
    const moduleFlag = args.findIndex(a => a === '-m');
    if (moduleFlag >= 0) {
      const mod = args[moduleFlag + 1] ?? '';
      if (mod === 'pytest') {
        const verbose = args.includes('-v') || args.includes('--verbose');
        const target = args.find(a => !a.startsWith('-') && a !== 'pytest') ?? 'tests/';
        const venvNote = t.includes('.venv') || t.includes('venv/') ? '仮想環境（.venv）のPythonを使って、' : '';
        return `${venvNote}「${shortenPath(target)}」のテストを実行${verbose ? '（詳細ログあり）' : ''}`;
      }
      if (mod === 'pip') {
        const sub = args[moduleFlag + 2] ?? '';
        const pkg = args.find(a => !a.startsWith('-') && a !== 'pip' && a !== sub);
        if (sub === 'install') return pkg ? `「${pkg}」をpipでインストール` : 'pipパッケージをインストール';
        if (sub === 'uninstall') return `pipパッケージを削除`;
        return `pipコマンドを実行（pip ${sub}）`;
      }
      if (mod === 'uvicorn' || mod === 'gunicorn') return `${mod}でWebサーバーを起動`;
      if (mod === 'flask')   return 'Flaskサーバーを起動';
      if (mod === 'django')  return 'Djangoコマンドを実行';
      return `Pythonモジュール「${mod}」を実行`;
    }
    const script = args.find(a => a.endsWith('.py'));
    if (script) {
      const venvNote = t.includes('.venv') || t.includes('venv/') ? '仮想環境のPythonで' : '';
      return `${venvNote}Pythonスクリプト「${shortenPath(script)}」を実行`;
    }
    return 'Pythonを実行';
  }

  // ── node ──
  if (bin === 'node') {
    const script = args.find(a => a.endsWith('.js') || a.endsWith('.mjs') || a.endsWith('.cjs'));
    return script ? `Node.jsスクリプト「${shortenPath(script)}」を実行` : 'Node.jsを実行';
  }

  // ── vitest ──
  if (bin === 'vitest') {
    const run = args.includes('run');
    return run ? 'Vitestでテストを一度実行' : 'Vitestでテストを実行（ウォッチモード）';
  }

  // ── curl ──
  if (bin === 'curl') {
    const url = args.find(a => !a.startsWith('-')) ?? '';
    const method = (() => {
      const xi = args.findIndex(a => a === '-X' || a === '--request');
      return xi >= 0 ? args[xi + 1] : 'GET';
    })();
    return `「${url}」にHTTP ${method}リクエストを送信`;
  }

  // ── docker ──
  if (bin === 'docker' || bin === 'docker-compose') {
    const sub = args[0];
    if (sub === 'build')   return 'Dockerイメージをビルド';
    if (sub === 'run')     return 'Dockerコンテナを起動して実行';
    if (sub === 'up')      return 'Docker Composeでサービスを起動';
    if (sub === 'down')    return 'Docker Composeでサービスを停止・削除';
    if (sub === 'exec')    return '実行中のコンテナ内でコマンドを実行';
    if (sub === 'ps')      return '起動中のコンテナ一覧を確認';
    if (sub === 'logs')    return 'コンテナのログを確認';
    if (sub === 'pull')    return 'DockerイメージをDocker Hubから取得';
    if (sub === 'push')    return 'DockerイメージをDocker Hubにアップロード';
    return `Dockerコマンドを実行（${bin} ${sub}）`;
  }

  // ── gh（GitHub CLI）──
  if (bin === 'gh') {
    const sub = args[0];
    const sub2 = args[1];
    if (sub === 'pr') {
      if (sub2 === 'create') return 'GitHubにプルリクエストを作成';
      if (sub2 === 'merge')  return 'プルリクエストをマージ';
      if (sub2 === 'list')   return 'プルリクエスト一覧を確認';
      if (sub2 === 'view')   return 'プルリクエストの内容を確認';
    }
    if (sub === 'issue') {
      if (sub2 === 'create') return 'GitHubにIssueを作成';
      if (sub2 === 'list')   return 'Issue一覧を確認';
    }
    if (sub === 'run') {
      if (sub2 === 'view')   return 'GitHub Actions（CI/CD）の実行状況を確認';
      if (sub2 === 'list')   return 'GitHub Actions実行一覧を確認';
    }
    return `GitHub CLIを実行（gh ${sub} ${sub2 ?? ''}）`;
  }

  // ── ファイル操作 ──
  if (bin === 'rm') {
    const recursive = args.some(a => a.includes('r'));
    const force = args.some(a => a.includes('f'));
    const targets = args.filter(a => !a.startsWith('-')).map(shortenPath).join(', ');
    const note = recursive ? '（フォルダごと削除）' : '';
    const warn = force ? '⚠️ 強制削除・確認なし' : '';
    return `${warn}「${targets}」を削除${note}`;
  }
  if (bin === 'mkdir') {
    const targets = args.filter(a => !a.startsWith('-')).map(shortenPath).join(', ');
    return `「${targets}」フォルダを作成`;
  }
  if (bin === 'cp') {
    const files = args.filter(a => !a.startsWith('-'));
    const src = files[0] ? shortenPath(files[0]) : '';
    const dst = files[1] ? shortenPath(files[1]) : '';
    return `「${src}」を「${dst}」にコピー`;
  }
  if (bin === 'mv') {
    const files = args.filter(a => !a.startsWith('-'));
    const src = files[0] ? shortenPath(files[0]) : '';
    const dst = files[1] ? shortenPath(files[1]) : '';
    return `「${src}」を「${dst}」に移動（またはリネーム）`;
  }
  if (bin === 'chmod') {
    const perm = args.find(a => !a.startsWith('-') ) ?? '';
    const target = args.filter(a => !a.startsWith('-'))[1] ?? '';
    return `「${shortenPath(target)}」のアクセス権限を「${perm}」に変更`;
  }
  if (bin === 'chown') {
    return `ファイルの所有者を変更`;
  }
  if (bin === 'cat' || bin === 'head' || bin === 'tail') {
    const file = args.find(a => !a.startsWith('-')) ?? '';
    const action = bin === 'cat' ? '全体を表示' : bin === 'head' ? '先頭を表示' : '末尾を表示';
    return `「${shortenPath(file)}」の${action}`;
  }
  if (bin === 'grep') {
    const pattern = args.find(a => !a.startsWith('-')) ?? '';
    const file = args.filter(a => !a.startsWith('-'))[1] ?? '';
    return `「${file ? shortenPath(file) : 'ファイル内'}」から「${pattern}」を検索`;
  }
  if (bin === 'find') {
    const dir = args.find(a => !a.startsWith('-')) ?? '.';
    return `「${shortenPath(dir)}」配下のファイルを検索`;
  }
  if (bin === 'echo') return `テキストを出力`;
  if (bin === 'export') return `環境変数を設定`;
  if (bin === 'source' || bin === '.') {
    const file = args[0] ? shortenPath(args[0]) : '';
    return `「${file}」を読み込んで環境変数を反映`;
  }
  if (bin === 'sudo') {
    const rest = parts.slice(1).join(' ');
    return `⚠️ 管理者権限で実行：${explainSingleCommand(rest)}`;
  }

  // ── wrangler 直接 ──
  if (bin === 'wrangler') {
    const sub = args[0];
    if (sub === 'deploy') return 'Cloudflare Workersにデプロイ（公開サーバーに反映）';
    if (sub === 'dev')    return 'Cloudflare Workersをローカルで起動';
    if (sub === 'd1')     return 'Cloudflare D1データベースを操作';
    return `Wranglerコマンドを実行（${sub}）`;
  }

  // ── その他 ──
  return `「${t.substring(0, 60)}」を実行`;
}

/** リダイレクト・パイプを考慮してコマンド全体を日本語で説明 */
function explainBashCommand(rawCmd: string): string {
  // 2>&1 や >/dev/null などのリダイレクト注釈を収集
  const redirectNotes: string[] = [];
  if (/2>&1/.test(rawCmd)) redirectNotes.push('エラーも一緒に出力');
  if (/>\s*\/dev\/null/.test(rawCmd)) redirectNotes.push('出力を破棄');
  if (/>\s*[^&\s]/.test(rawCmd.replace(/2>&1/g, ''))) redirectNotes.push('結果をファイルに保存');
  if (/>>/.test(rawCmd)) redirectNotes.push('結果をファイルに追記');

  // クリーンアップ（リダイレクト除去してコマンドのみ取り出す）
  const clean = rawCmd
    .replace(/\s*2>&1/g, '')
    .replace(/\s*>+\s*\/dev\/null/g, '')
    .replace(/\s*>+\s*\S+/g, '')
    .trim();

  // パイプ分割
  const pipeParts = clean.split(/\s*\|\s*/);

  // && と ; で分割して各コマンドを説明
  const explainChain = (chain: string): string[] => {
    return chain
      .split(/\s*(?:&&|;)\s*/)
      .map(c => c.trim())
      .filter(Boolean)
      .map(explainSingleCommand)
      .filter(Boolean);
  };

  let steps: string[];
  if (pipeParts.length > 1) {
    const mainSteps = explainChain(pipeParts[0]);
    const pipeSteps = pipeParts.slice(1).map(p => {
      const ps = explainSingleCommand(p.trim());
      return `その結果を ${ps}`;
    });
    steps = [...mainSteps, ...pipeSteps];
  } else {
    steps = explainChain(clean);
  }

  const suffix = redirectNotes.length > 0 ? `（${redirectNotes.join('・')}）` : '';
  if (steps.length === 1) return steps[0] + suffix;
  return steps.map((s, i) => `${i + 1}. ${s}`).join('\n') + (suffix ? `\n${suffix}` : '');
}

// ツール名 → サマリー（1行）
function toolSummary(toolName: string): string {
  const map: Record<string, string> = {
    Bash:        '💻 コマンドを実行しようとしています',
    Edit:        '✏️ ファイルを書き換えようとしています',
    Write:       '📄 ファイルを作成・上書きしようとしています',
    NotebookEdit:'📓 ノートブックを編集しようとしています',
    Read:        '👀 ファイルを読み込もうとしています',
    Grep:        '🔍 ファイルを検索しようとしています',
    Glob:        '🗂️ ファイル一覧を取得しようとしています',
    WebFetch:    '🌐 Webページを取得しようとしています',
    WebSearch:   '🔎 Web検索しようとしています',
  };
  return map[toolName] ?? '🤖 操作を実行しようとしています';
}

// コマンド全体からリスクレベルを判定
function assessRisk(toolName: string, rawCmd: string): { label: string; color: number } {
  if (toolName !== 'Bash') {
    if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
      return { label: '🟡 中（ファイルが変更されます）', color: 0xf59e0b };
    }
    return { label: '🟢 低（読み取りのみ）', color: 0x22c55e };
  }

  // 高リスクパターン
  const HIGH = [
    /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r/,  // rm -rf
    /\brm\b/,                       // rm 全般
    /\bgit\s+push\s+.*--force|-f\b/, // force push
    /\bgit\s+reset\s+--hard\b/,
    /--no-verify\b/,
    /\bsudo\b/,
    /\bchmod\b|\bchown\b/,
    />\s*\/etc\//,
    />\s*~\/\.(ssh|aws|env)/,
    /\bcurl\b[^|]*\|\s*(ba)?sh/,    // curl | sh
  ];
  // 中リスクパターン
  const MED = [
    /\bgit\s+push\b/,
    /\bgit\s+commit\b/,
    /\bgit\s+(merge|rebase)\b/,
    /\bnpm\s+install\b|\bpnpm\s+install\b|\byarn\s+(add|install)\b/,
    /\bdocker\s+(run|exec|up|down)\b/,
    /\bwrangler\s+deploy\b|\bnpm\s+run\s+deploy\b|\bpnpm\s+deploy\b/,
    /\bgh\s+pr\s+(merge|create)\b/,
    /\bmv\b|\bcp\b/,
    />\s*\S/,                        // リダイレクト書き込み
  ];

  if (HIGH.some(p => p.test(rawCmd))) return { label: '🔴 高（取り消しが難しい操作）', color: 0xef4444 };
  if (MED.some(p => p.test(rawCmd)))  return { label: '🟡 中（外部・ファイルへの影響あり）', color: 0xf59e0b };
  return { label: '🟢 低（確認・ビルド系）', color: 0x22c55e };
}

export async function sendApprovalMessage(
  botToken: string,
  threadId: string,
  requestId: string,
  toolName: string,
  toolInput: string | null,
  workingDir: string | null = null
): Promise<void> {
  const truncatedInput = toolInput
    ? toolInput.length > 500
      ? toolInput.substring(0, 500) + '...'
      : toolInput
    : '(なし)';

  const summary = toolSummary(toolName);
  const rawCmd = toolName === 'Bash' && toolInput ? extractCommand(toolInput) : '';
  const { label: riskLabel, color: riskColor } = assessRisk(toolName, rawCmd);

  // Bash の場合はコマンドを解析して日本語説明を生成
  const bashExplanation = toolName === 'Bash' && rawCmd
    ? explainBashCommand(rawCmd)
    : null;

  const SEP = '\n\n──────────────────────\n\n';

  const descParts: string[] = [];
  descParts.push(`**⚠️ リスク**\n\n${riskLabel}`);
  if (bashExplanation) {
    descParts.push(`**🗒️ このコマンドが行うこと**\n\n${bashExplanation}`);
  }
  if (workingDir) {
    descParts.push(`**📂 作業ディレクトリ**\n\n\`${workingDir}\``);
  }
  descParts.push(`**💻 コマンド内容**\n\n\`\`\`\n${truncatedInput}\n\`\`\``);

  const description = descParts.join(SEP);

  const fields = [
    { name: 'ツール', value: `\`${toolName}\``, inline: true },
    { name: 'ID',    value: `\`${requestId.substring(0, 8)}\``, inline: true },
  ];

  await sendMessage(botToken, threadId, {
    content: `${MENTION_USER} Claudeの操作に承認が必要です`,
    embeds: [
      {
        title: `🔧 ${summary}`,
        description,
        color: riskColor,
        fields,
        timestamp: new Date().toISOString(),
      },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 3, // Success
            label: 'Approve',
            emoji: { name: '✅' },
            custom_id: `approve:${requestId}`,
          },
          {
            type: 2,
            style: 4, // Danger
            label: 'Deny',
            emoji: { name: '❌' },
            custom_id: `deny:${requestId}`,
          },
        ],
      },
    ],
  });
}

// --- タスク受付通知（スレッド内に投稿） ---

export async function sendTaskReceived(
  botToken: string,
  threadId: string,
  commandId: string,
  content: string
): Promise<void> {
  const truncated = content.length > 300 ? content.substring(0, 300) + '...' : content;
  await sendMessage(botToken, threadId, {
    embeds: [
      {
        title: '📋 タスク受付完了',
        description: truncated,
        color: 0x3b82f6,
        footer: { text: `ID: ${commandId.substring(0, 8)} | Mac側で実行を待機中...` },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

// --- Agent Team 受付通知 ---

export async function sendAgentTeamReceived(
  botToken: string,
  channelId: string,
  commandId: string,
  instruction: string,
  model: string
): Promise<void> {
  const modelLabel = { 'claude-opus-4-6': 'Opus', 'claude-haiku-4-5-20251001': 'Haiku' }[model] ?? 'Sonnet';
  const truncated = instruction.length > 300 ? instruction.substring(0, 300) + '...' : instruction;
  await sendMessage(botToken, channelId, {
    embeds: [
      {
        title: '🤖 Agent Team 起動',
        description: truncated,
        color: 0x6366f1,
        fields: [
          { name: '🧑‍💼 Orchestrator', value: 'タスクを分析・分解中...', inline: true },
          { name: '🤝 チーム', value: 'product-owner / senior-engineer / api-reviewer', inline: true },
          { name: '⚡ モデル', value: modelLabel, inline: true },
        ],
        footer: { text: `ID: ${commandId.substring(0, 8)} | Mac側で実行を待機中...` },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

// --- タスク進捗更新（スレッド内） ---

export async function sendTaskStatusUpdate(
  botToken: string,
  threadId: string,
  commandId: string,
  status: 'running' | 'completed' | 'failed',
  result: string | null
): Promise<void> {
  const statusConfig = {
    running: { title: '⚡ 実行開始', color: 0xeab308 },
    completed: { title: '✅ タスク完了', color: 0x22c55e },
    failed: { title: '❌ タスク失敗', color: 0xef4444 },
  };

  const { title, color } = statusConfig[status];
  const description = result
    ? result.length > 1500
      ? `\`\`\`\n${result.substring(0, 1500)}...\n\`\`\``
      : `\`\`\`\n${result}\n\`\`\``
    : status === 'running'
      ? 'Mac側で実行中...'
      : '(出力なし)';

  await sendMessage(botToken, threadId, {
    embeds: [
      {
        title,
        description,
        color,
        footer: { text: `ID: ${commandId.substring(0, 8)}` },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

// --- Discordチャンネルのメッセージ取得 ---

interface DiscordMessage {
  id: string;
  content: string;
  author: { id: string; bot?: boolean };
}

export async function getChannelMessages(
  botToken: string,
  channelId: string,
  after?: string
): Promise<DiscordMessage[]> {
  const url = new URL(`${DISCORD_API}/channels/${channelId}/messages`);
  url.searchParams.set('limit', '10');
  if (after) url.searchParams.set('after', after);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bot ${botToken}` },
  });

  if (!res.ok) return [];
  return (await res.json()) as DiscordMessage[];
}

// --- ツール完了通知 ---

export async function sendToolDoneNotification(
  botToken: string,
  channelId: string,
  toolName: string,
  summary: string,
  output?: string
): Promise<void> {
  const toolEmoji: Record<string, string> = {
    Bash: '💻',
    Edit: '✏️',
    Write: '📄',
    NotebookEdit: '📓',
    Agent: '🤖',
  };
  const emoji = toolEmoji[toolName] || '✅';

  // outputがない場合（Edit/Writeなど）はシンプルなテキストメッセージ
  if (!output || output.length < 20) {
    await sendMessage(botToken, channelId, {
      content: `${emoji} **${toolName}** — ${summary}`,
    });
    return;
  }

  // Bashなどoutputがある場合はembedでコードブロック表示
  const truncated = output.length > 1800 ? output.substring(0, 1800) + '\n…（省略）' : output;
  const colorMap: Record<string, number> = {
    Bash: 0x22c55e,
    Edit: 0x3b82f6,
    Write: 0x8b5cf6,
    NotebookEdit: 0xf59e0b,
    Agent: 0x6366f1,
  };

  await sendMessage(botToken, channelId, {
    embeds: [
      {
        color: colorMap[toolName] ?? 0x6b7280,
        author: { name: `${emoji} ${toolName}` },
        description: summary ? `\`${summary}\`` : undefined,
        fields: [
          {
            name: '📤 出力',
            value: `\`\`\`\n${truncated}\n\`\`\``,
          },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

// --- ステータスボード更新 ---

export async function sendStatusUpdate(
  botToken: string,
  channelId: string,
  content: string
): Promise<void> {
  await sendMessage(botToken, channelId, { content });
}

// --- サーバー構造自動作成 ---

interface ServerStructure {
  categories: Record<string, string>; // name → id
  channels: Record<string, string>;   // key → id
}

export async function setupServerStructure(
  botToken: string,
  guildId: string
): Promise<ServerStructure> {
  const result: ServerStructure = { categories: {}, channels: {} };

  const categories = [
    { key: 'command_center', name: '🏢 COMMAND CENTER' },
    { key: 'workspaces',     name: '💻 WORKSPACES' },
    { key: 'agent_teams',    name: '🤖 AGENT TEAMS' },
    { key: 'archive',        name: '🗄️ ARCHIVE' },
  ];

  // カテゴリ作成
  for (const cat of categories) {
    const id = await createCategory(botToken, guildId, cat.name);
    result.categories[cat.key] = id;
  }

  // チャンネル定義（固定チャンネルのみ）
  // セッション/タスクチャンネルはWORKSPACESに動的作成
  const channels = [
    { key: 'dispatch', name: '🚀dispatch', category: 'command_center', topic: 'タスク指示専用 — /task で指示を出す' },
    { key: 'status_board', name: '📊status-board', category: 'command_center', topic: '稼働状況の確認 — /status で現在の状態を見る' },
    { key: 'completed_tasks', name: '📦completed-tasks', category: 'archive', topic: '完了タスクのログ' },
  ];

  for (const ch of channels) {
    const categoryId = result.categories[ch.category];
    const id = await createTextChannel(botToken, guildId, ch.name, categoryId, ch.topic);
    result.channels[ch.key] = id;
  }

  return result;
}

async function createCategory(
  botToken: string,
  guildId: string,
  name: string
): Promise<string> {
  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/channels`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, type: 4 }), // 4 = GUILD_CATEGORY
  });
  const data = (await res.json()) as any;
  if (!res.ok || !data.id) {
    throw new Error(`カテゴリ作成失敗 "${name}": ${JSON.stringify(data)}`);
  }
  return data.id;
}

async function createTextChannel(
  botToken: string,
  guildId: string,
  name: string,
  parentId: string,
  topic?: string
): Promise<string> {
  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/channels`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      type: 0, // GUILD_TEXT
      parent_id: parentId,
      topic,
    }),
  });
  const data = (await res.json()) as any;
  if (!res.ok || !data.id) {
    throw new Error(`チャンネル作成失敗 "${name}": ${JSON.stringify(data)}`);
  }
  return data.id;
}

// --- タスク専用チャンネル作成 ---

export async function createTaskChannel(
  botToken: string,
  guildId: string,
  categoryId: string,
  instruction: string,
  type: string
): Promise<string> {
  // 上限に近い場合は古いチャンネルを事前削除
  await pruneOldChannels(botToken, guildId, categoryId);

  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');

  // 指示の先頭20文字をチャンネル名に（記号はハイフンに変換）
  const safeName = instruction
    .substring(0, 20)
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u9fff]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'task';

  const typeEmoji = { task: '🛠', file: '📁', team: '👥', agents: '🤖' }[type] || '📋';
  const channelName = `${typeEmoji}${safeName}-${mm}${dd}-${hh}${min}`;

  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/channels`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: channelName,
      type: 0, // GUILD_TEXT
      parent_id: categoryId,
      topic: instruction.length > 1024 ? instruction.substring(0, 1021) + '...' : instruction,
    }),
  });

  const data = (await res.json()) as any;
  if (!res.ok || !data.id) {
    throw new Error(`タスクチャンネル作成失敗: ${JSON.stringify(data)}`);
  }
  return data.id;
}
