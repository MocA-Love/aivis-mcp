# Aivis Cloud MCP サーバー

[Aivis Cloud API](https://hub.aivis-project.com/)を使用したMCPサーバー 音声合成機能を利用できるようにします。
音声合成と再生はバックグラウンドで行うよう工夫してるので開発効率の邪魔をしません。

# デモ

https://github.com/user-attachments/assets/c42722bd-8f2f-4543-bdc6-71668db3751d

## 特徴

- **即座にレスポンス**:
  バックグラウンドで音声生成・再生を行い、即座に`OK`を返します
- **ストリーミング再生**: 音声データを受信しながらリアルタイムで再生
- **キューで順次再生**:
  Redisキューで順番に再生し、複数プロセス/複数同時呼び出しでも音声の重なりを防止
- **npxで即実行**: インストール不要、`npx aivis-mcp` ですぐ使える
- **環境変数は最小限**: 必須はAPIキーのみ、その他はCLI引数で設定可能

## 必要条件

- Node.js 18.x以上
- Aivis Cloud
  APIキー（[Aivis Hub](https://hub.aivis-project.com/cloud-api/api-keys)から取得）
- 音声プレイヤー（ffplay推奨、mpv、afplayも対応）
- Redis（ローカルで起動）

> [!TIP]
> `npx aivis-mcp --doctor` で依存ツールの確認・インストールができます

## セットアップ

### 1. 初期設定

```bash
npx aivis-mcp --init
```

APIキー等を `~/.config/aivis-mcp/config.json` に保存します。
一度設定すれば、CLI/MCPどちらでも自動で読み込まれます。

### 2. 依存ツールの確認

```bash
npx aivis-mcp --doctor
```

Redis や FFmpeg が未インストールの場合、対話的にインストールできます。

### 3. MCPサーバーの登録

#### Claude Code

```bash
claude mcp add aivis -s user -- npx -y aivis-mcp
```

#### Codex

```bash
codex mcp add aivis -- npx -y aivis-mcp
```

<details>
<summary>Claude Desktop / Cursor / Antigravity IDE / その他（JSON設定）</summary>

**Claude Desktop / Cursor / Antigravity IDE**

各クライアントのMCP設定ファイルに追加：

```json
{
  "mcpServers": {
    "aivis": {
      "command": "npx",
      "args": ["-y", "aivis-mcp"],
      "env": {
        "AIVIS_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

モデルや音声パラメータを指定する場合：

```json
{
  "mcpServers": {
    "aivis": {
      "command": "npx",
      "args": ["-y", "aivis-mcp", "--model", "your-model-uuid", "--rate", "1.2"],
      "env": {
        "AIVIS_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

</details>

## CLI引数

MCPサーバー起動時やCLIコマンドで使用できるオプション：

| 引数 | 短縮 | 説明 | デフォルト |
|------|------|------|----------|
| `--api-key` | `-k` | APIキー | 環境変数 `AIVIS_API_KEY` |
| `--model` | `-m` | モデルUUID | `a59cb814-...` |
| `--rate` | `-r` | 話速 | - |
| `--pitch` | `-p` | ピッチ | - |
| `--volume` | | 音量 | - |
| `--style-name` | | スタイル名 | - |
| `--style-id` | | スタイルID | - |
| `--emotional-intensity` | | 感情の強さ | - |
| `--tempo-dynamics` | | テンポダイナミクス | - |
| `--leading-silence` | | 先頭無音（秒） | - |
| `--trailing-silence` | | 末尾無音（秒） | - |
| `--line-break-silence` | | 改行無音（秒） | - |
| `--api-url` | | APIエンドポイント | `https://api.aivis-project.com/v1` |
| `--redis-url` | | Redis接続先 | `redis://127.0.0.1:6379` |
| `--debug` | `-d` | デバッグモード | off |

> [!NOTE]
> すべてのCLI引数は環境変数でも設定可能です（例: `--rate` → `AIVIS_SPEAKING_RATE`）。
> CLI引数 > 環境変数 > デフォルト値 の優先順位で適用されます。

## CLIコマンド

MCPサーバーとしてだけでなく、ターミナルから直接音声合成を実行できます。

```bash
# npx経由
npx aivis-mcp "こんにちは"
npx aivis-mcp "こんにちは" --model your-model-uuid
npx aivis-mcp "こんにちは" --rate 1.2 --pitch 0.5

# グローバルインストール済みの場合
aivis "こんにちは"
aivis "こんにちは" --model your-model-uuid

# ユーティリティ
npx aivis-mcp --doctor     # 依存ツール診断・インストール
npx aivis-mcp --health     # ヘルスチェック
npx aivis-mcp --reboot     # 全プロセス再起動
npx aivis-mcp --version    # バージョン表示
```

CLIはMCPと同じRedisキュー経由で再生されるため、即座にコマンドが返ります。
MCP経由の再生とも排他制御されており、同時に音声が重なることはありません。
ワーカーが起動していない場合は自動的に起動します。

## 開発者向け

```bash
git clone https://github.com/MocA-Love/aivis-mcp.git
cd aivis-mcp
npm install
```

<details>
<summary>Redisのインストール</summary>

### macOS

```bash
brew install redis
```

### Windows

```powershell
winget install Redis.Redis
```

### Linux (Ubuntu/Debian)

```bash
sudo apt update
sudo apt install redis-server
```

### Linux (Fedora)

```bash
sudo dnf install redis
```

</details>

<details>
<summary>FFmpegのインストール</summary>

### macOS

```bash
brew install ffmpeg
```

### Linux (Ubuntu/Debian)

```bash
sudo apt update
sudo apt install ffmpeg
```

### Linux (Fedora)

```bash
sudo dnf install ffmpeg
```

### Windows

- [FFmpeg公式サイト](https://ffmpeg.org/download.html)からダウンロード

> [!NOTE]
> ffplayがインストールされていない場合、一時ファイル経由での再生となり遅延が発生。

</details>

## 使用例

カスタムコマンドとして[aivis.md](./aivis.md)のように登録することで簡単に音声で報告してくれるようにできます

## アーキテクチャ

```
┌─────────────────┐     ┌─────────────────┐
│ Claude Desktop  │     │   Terminal      │
└────────┬────────┘     │  aivis "hello"  │
         │ MCP Protocol └────────┬────────┘
┌────────▼────────┐              │
│  MCP Server     │              │
│  (index.ts)     │              │
└────────┬────────┘              │
         │                       │
┌────────▼────────┐     ┌───────▼─────────┐
│  MCP Service    │     │   CLI           │
│ (mcp-service.ts)│     │  (cli.ts)       │
└────────┬────────┘     └───────┬─────────┘
         │                      │
         │    ┌───────────┐     │
         └───▶│   Redis   │◀───┘
              │   Queue   │  両方ともキューにエンキュー
              └─────┬─────┘
                    │ dequeue
           ┌────────▼──────────┐
           │  Worker Process   │
           │ (aivis-speech-svc)│
           │  play-lock で     │
           │  排他制御         │
           └────────┬──────────┘
                    │
            ┌───────▼───────┐     ┌──────────┐
            │ Aivis Cloud   │     │ ffplay/  │
            │     API       │────▶│   mpv    │
            └───────────────┘     └──────────┘
                音声生成           ストリーミング再生
```

## 変更履歴

[CHANGELOG.md](./CHANGELOG.md) を参照してください。
