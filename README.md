# Aivis Cloud MCP サーバー

Aivis Cloud APIを使用したMCPサーバー
Claude Codeで音声合成機能を利用できるようにします。
音声合成と再生はバックグラウンドで行うよう工夫してるので開発効率の邪魔をしません。

# デモ
https://github.com/user-attachments/assets/6e66db38-8c8a-4315-bd7b-234eceef143c

## 特徴

- **即座にレスポンス**:
  バックグラウンドで音声生成・再生を行い、即座に"OK"を返します
- **ストリーミング再生**: 音声データを受信しながらリアルタイムで再生
- **クロスプラットフォーム対応?**:
  Windows、macOSで動作するはず(macでしか動作確認してない)

## 必要条件

- Node.js 18.x以上
- npm 9.x以上
- Aivis Cloud
  APIキー（[Aivis Hub](https://hub.aivis-project.com/cloud-api/api-keys)から取得）
- 音声プレイヤー（ffplay推奨、mpv、afplayも対応?）

## インストール

```bash
# リポジトリをクローン
git clone https://github.com/MocA-Love/aivis-mcp.git
cd aivis-mcp

# 依存関係のインストール
npm install

# ビルド
npm run build

# 環境変数の設定
cp .env.example .env
# .envファイルを編集してAPIキーを設定
```

## FFmpegのインストール

### macOS

```bash
brew install ffmpeg
```

### Windows

- [FFmpeg公式サイト](https://ffmpeg.org/download.html)からダウンロード

> [!NOTE]
> ffplayがインストールされていない場合、一時ファイル経由での再生となり遅延が発生。

## 環境設定

`.env`ファイルで以下の設定を行います：

```env
AIVIS_API_KEY=your_api_key_here  # 必須：Aivis Cloud APIキー
AIVIS_API_URL=https://api.aivis-project.com/v1  # APIエンドポイント（通常は変更不要）
```

## Claude Codeへの登録

### コマンドラインから登録

```bash
# MCPサーバーを登録
claude mcp add aivis \
  -s user \
  -- node /full/path/to/aivis-mcp/dist/index.js

# 登録を削除する場合
claude mcp remove aivis
```

## 使い方

```
「aivis mcpで"こんにちは"と言って」
```

## カスタムコマンド

Claude
Codeでカスタムコマンドとしてaivis.mdのように登録することで簡単に音声で報告してくれるようにできます

## 音声パラメータのカスタマイズ

音声合成のパラメータは環境変数で設定します。`.env`ファイルで以下の値をカスタマイズできます：

| 環境変数                         | 説明                     | 範囲/デフォルト値          |
| -------------------------------- | ------------------------ | -------------------------- |
| AIVIS_MODEL_UUID                 | モデルUUID               | -                          |
| AIVIS_SPEAKER_UUID               | 話者UUID                 | -                          |
| AIVIS_STYLE_ID                   | スタイルID               | 0-31                       |
| AIVIS_STYLE_NAME                 | スタイル名               | -                          |
| AIVIS_SPEAKING_RATE              | 話速                     | 0.5-2.0 (デフォルト: 1.0)  |
| AIVIS_EMOTIONAL_INTENSITY        | 感情表現の強さ           | 0.0-2.0 (デフォルト: 1.0)  |
| AIVIS_TEMPO_DYNAMICS             | テンポの緩急             | 0.0-2.0 (デフォルト: 1.0)  |
| AIVIS_PITCH                      | ピッチ                   | -1.0-1.0 (デフォルト: 0.0) |
| AIVIS_VOLUME                     | 音量                     | 0.0-2.0 (デフォルト: 1.0)  |
| AIVIS_LEADING_SILENCE_SECONDS    | 音声先頭の無音時間（秒） | 0.0- (デフォルト: 0)       |
| AIVIS_TRAILING_SILENCE_SECONDS   | 音声末尾の無音時間（秒） | 0.0- (デフォルト: 0)       |
| AIVIS_LINE_BREAK_SILENCE_SECONDS | 改行時の無音時間（秒）   | 0.0- (デフォルト: 0)       |

## アーキテクチャ

```
┌─────────────────┐
│ Claude Desktop  │
└────────┬────────┘
         │ MCP Protocol
┌────────▼────────┐
│  MCP Server     │
│  (index.ts)     │
└────────┬────────┘
         │
┌────────▼────────┐
│  MCP Service    │ ← バックグラウンド処理
│ (mcp-service.ts)│   即座に"OK"を返す
└────────┬────────┘
         │
┌────────▼────────────┐
│ AivisSpeech Service │ ← 音声合成と再生
│(aivis-speech-svc.ts)│
└──────┬──────────────┘
       │
┌──────▼────────┐     ┌──────────┐
│ Aivis Cloud   │     │ ffplay/  │
│     API       │────▶│   mpv    │
└───────────────┘     └──────────┘
    音声生成            ストリーミング再生
```
