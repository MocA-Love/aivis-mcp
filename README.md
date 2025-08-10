# Aivis Speech MCP サーバー

Aivis Cloud APIを使用したMCPサーバーです。
MCP対応アプリケーションから高品質な音声合成機能を利用できるようにします。
音声合成と再生はバックグラウンドで行うよう工夫してるので開発効率の邪魔をしません。

## 特徴

- **即座にレスポンス**: バックグラウンドで音声生成・再生を行い、即座に"OK"を返します
- **ストリーミング再生**: 音声データを受信しながらリアルタイムで再生
- **クロスプラットフォーム対応**: Windows、macOSで動作するはず(macでしか動作確認してない)

## 必要条件

- Node.js 18.x以上
- npm 9.x以上
- Aivis Cloud APIキー（[Aivis Hub](https://hub.aivis-project.com/cloud-api/api-keys)から取得）
- 音声プレイヤー（ffplay推奨、mpv、afplayも対応）

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
cp .env.sample .env
# .envファイルを編集してAPIキーを設定
```

## 環境設定

`.env`ファイルで以下の設定を行います：

```env
# Aivis Cloud API Configuration
AIVIS_API_KEY=your_api_key_here  # 必須：Aivis Cloud APIキー
AIVIS_API_URL=https://api.aivis-project.com/v1  # APIエンドポイント（通常は変更不要）

# Model Configuration
AIVIS_MODEL_UUID=a59cb814-0083-4369-8542-f51a29e72af7  # デフォルトモデル（好みで変更 AivisHubにサンプル音声とモデルUUIDがある）
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

### Claude Desktopでの使用例

1. Claude Desktopを起動（MCPサーバー登録後は再起動が必要）
2. 以下のように音声合成を依頼：

```
「aivis mcpで"こんにちは"と言って」
「音声で"作業が完了しました"と教えて」
「"了解しました"と音声で返事して」
```


## 音声プレイヤーのインストール

### macOS
```bash
# ffplay（推奨）
brew install ffmpeg

# mpv
brew install mpv
```

### Windows
- [FFmpeg公式サイト](https://ffmpeg.org/download.html)からダウンロード
- または[mpv公式サイト](https://mpv.io/installation/)からダウンロード

### Linux
```bash
# Ubuntu/Debian
sudo apt install ffmpeg
# または
sudo apt install mpv

# Fedora
sudo dnf install ffmpeg
# または
sudo dnf install mpv
```

## 利用可能なパラメータ

MCPツール呼び出し時に以下のパラメータを指定できます：

| パラメータ | 型 | 説明 | 範囲/値 |
|-----------|-----|------|---------|
| text | string | 音声合成するテキスト（必須） | - |
| model_uuid | string | モデルUUID | - |
| speaker_uuid | string | 話者UUID | - |
| style_id | number | スタイルID | 0-31 |
| style_name | string | スタイル名 | - |
| speaking_rate | number | 話速 | 0.5-2.0 |
| emotional_intensity | number | 感情表現の強さ | 0.0-2.0 |
| tempo_dynamics | number | テンポの緩急 | 0.0-2.0 |
| pitch | number | ピッチ | -1.0-1.0 |
| volume | number | 音量 | 0.0-2.0 |
| leading_silence_seconds | number | 音声先頭の無音時間（秒） | 0.0- |
| trailing_silence_seconds | number | 音声末尾の無音時間（秒） | 0.0- |
| line_break_silence_seconds | number | 改行時の無音時間（秒） | 0.0- |

## トラブルシューティング

### 音声が再生されない

1. **APIキーの確認**: `.env`ファイルにAPIキーが正しく設定されているか確認
2. **音声プレイヤーの確認**: `which ffplay`（macOS/Linux）または`where ffplay`（Windows）でプレイヤーがインストールされているか確認

### APIキーが読み込まれない

MCPサーバーは異なる作業ディレクトリで起動される場合があるため、`.env`ファイルは絶対パスで読み込まれます。`.env`ファイルがプロジェクトルートに存在することを確認してください。

### 音声の遅延

ffplayがインストールされていない場合、一時ファイル経由での再生となり遅延が発生する可能性があります。ffplayのインストールを推奨します。

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

## 貢献

バグ報告や機能リクエストは、GitHubのIssueトラッカーを通じてお願いします。プルリクエストも歓迎します。

## ライセンス

[MIT](LICENSE)
