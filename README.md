# Aivis Cloud MCP サーバー

Aivis Cloud APIを使用したMCPサーバー 音声合成機能を利用できるようにします。
音声合成と再生はバックグラウンドで行うよう工夫してるので開発効率の邪魔をしません。

# デモ

https://github.com/user-attachments/assets/c42722bd-8f2f-4543-bdc6-71668db3751d

## 特徴

- **即座にレスポンス**:
  バックグラウンドで音声生成・再生を行い、即座に`OK (R:xxxxms)`を返します
- **ストリーミング再生**: 音声データを受信しながらリアルタイムで再生
- **キューで順次再生**:
  Redisキューで順番に再生し、複数プロセス/複数同時呼び出しでも音声の重なりを防止
- **クロスプラットフォーム対応?**:
  Windows、macOSで動作するはず(macでしか動作確認してない)

## 必要条件

- Node.js 18.x以上
- npm 9.x以上
- Aivis Cloud
  APIキー（[Aivis Hub](https://hub.aivis-project.com/cloud-api/api-keys)から取得）
- 音声プレイヤー（ffplay推奨、mpv、afplayも対応?）
- Redis（ローカルで起動）

## インストール

```bash
# リポジトリをクローン
git clone https://github.com/MocA-Love/aivis-mcp.git
cd aivis-mcp

# 依存関係のインストール（自動でビルド＋aivisコマンドのグローバル登録も行われます）
npm install

# 環境変数の設定
cp .env.example .env
# .envファイルを編集してAPIキーを設定
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

## 環境設定

`.env`ファイルで以下の設定を行います：

```env
AIVIS_API_KEY=your_api_key_here  # 必須：Aivis Cloud APIキー
AIVIS_API_URL=https://api.aivis-project.com/v1  # APIエンドポイント（通常は変更不要）
REDIS_URL=redis://127.0.0.1:6379  # Redis接続先（通常は変更不要）
```

> [!TIP]
> `.env`ファイルを編集すると自動的に変更が検知され、次のリクエストから新しい設定が反映されます。Claude
> Desktopの再起動は不要です。

## Claude Codeへの登録

```bash
# MCPサーバーを登録
claude mcp add aivis \
  -s user \
  -- node /full/path/to/aivis-mcp/dist/index.js

# 登録を削除する場合
claude mcp remove aivis
```

## Codexへの登録

```bash
codex mcp add aivis -- node /Users/magu/github/aivis-mcp/dist/index.js
```

## Antigravityへの登録

Antigravity
IDEでは、`~/.gemini/antigravity/mcp_config.json`に以下のように設定します：

```json
{
  "mcpServers": {
    "aivis": {
      "command": "node",
      "args": [
        "/full/path/to/aivis-mcp/dist/index.js"
      ],
      "env": {
        "AIVIS_API_KEY": "your_api_key_here",
        "AIVIS_API_URL": "https://api.aivis-project.com/v1",
        "AIVIS_MODEL_UUID": "your_model_uuid_here"
      }
    }
  }
}
```

## CLIコマンドとして使う

MCPサーバーとしてだけでなく、ターミナルから直接音声合成を実行できます。
`npm install` 時に自動で `aivis` コマンドがグローバル登録されます。

```bash
# 基本的な使い方
aivis "こんにちは"

# モデルを指定
aivis "こんにちは" --model your-model-uuid

# 待機時間を指定（ミリ秒）
aivis "こんにちは" --wait 1000

# ヘルスチェック（Redis・ワーカー・プレイヤー・プロセス多重起動等の状態確認）
aivis --health

# 再起動（全プロセス停止→Redis初期化→ワーカー再起動）
aivis --reboot
```

CLIはMCPと同じRedisキュー経由で再生されるため、即座にコマンドが返ります。
MCP経由の再生とも排他制御されており、同時に音声が重なることはありません。
ワーカーが起動していない場合は自動的に起動します。

`--reboot` はビルド後に最新のコードでワーカーを立ち上げ直したい時に使います。
MCPサーバーはクライアント（Claude Desktop等）が自動で再起動します。


## カスタムコマンド

Claude
Codeでカスタムコマンドとして[aivis.md](./aivis.md)のように登録することで簡単に音声で報告してくれるようにできます

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
