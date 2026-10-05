# Aivis Cloud MCP サーバー

[Aivis Cloud API](https://hub.aivis-project.com/)を使用したMCPサーバー 音声合成機能を利用できるようにします。
音声合成と再生はバックグラウンドで行うよう工夫してるので開発効率の邪魔をしません。

# デモ

https://github.com/user-attachments/assets/c42722bd-8f2f-4543-bdc6-71668db3751d

## 特徴

- **即座にレスポンス**:
  バックグラウンドで音声生成・再生を行い、即座に`OK`を返します
- **ストリーミング再生**: 音声データを受信しながら再生。0.25 秒ぶん溜まったらすぐ鳴らし始め、1 つの発話は最初から最後まで 1 つのデコーダで鳴らすので途切れません
- **キューで順次再生**:
  Redisキューで積んだ順に再生し、複数プロセス/複数同時呼び出しでも音声の重なりを防止
- **音量をそろえる**: 声とモデルの組ごとの音量の表で、どの声も -20 LUFS にそろえて鳴らします（鳴らした発話を測って表を覚え直します）
- **npxで即実行**: インストール不要、`npx aivis-mcp` ですぐ使える
- **環境変数は最小限**: 必須はAPIキーのみ、その他はCLI引数で設定可能
- **ElevenLabs にも対応**: LLM に頼むだけで Aivis と ElevenLabs を切り替えられる

## 必要条件

- Node.js 18.x以上
- Aivis Cloud
  APIキー（[Aivis Hub](https://hub.aivis-project.com/cloud-api/api-keys)から取得）、または
  ElevenLabs APIキー（[ElevenLabs](https://elevenlabs.io/app/settings/api-keys)から取得）
- 音声プレイヤー（ffplay推奨、mpv、afplay（macOS）・mplayer・play（sox、Linux）も対応）。ffmpeg（ffplay）が無いと、全部受け取ってから鳴らすので鳴り始めが遅れ、音量の覚え直しもできません
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

## ElevenLabs を使う

MCPを登録したら、LLM に次のように伝えるだけで切り替わります。設定は `~/.config/aivis-mcp/config.json` に保存され、再起動は不要です。

```text
ElevenLabs を使いたい。APIキーは sk_xxx、声は（voice_id）で
```

LLM は次のMCPツールを使って設定します。

| ツール | 役割 |
|---|---|
| `tts-get-settings` | 現在のサービス、声、モデル、音量の覚え直し方（窓と最短秒数）を表示（APIキーは伏せ字） |
| `tts-configure` | サービス、APIキー、声、モデル、音量補正を変更して保存。無効なAPIキーや存在しないモデルは保存しない |
| `tts-list-voices` | 声の候補を検索（ElevenLabs はアカウントのボイスライブラリ、Aivis は公開モデル） |
| `elevenlabs-list-models` | ElevenLabs の日本語対応モデル一覧 |

`aivis-speech` に `provider` / `voice_id` / `model_id` を渡すと、その発話だけ別のサービスや声で話せます。

| 項目 | デフォルト | 補足 |
|---|---|---|
| モデル | `eleven_v4_turbo` | `elevenlabs-list-models` で他のモデルを確認できる |
| 音量 | 自動 | 声とモデルの組ごとの表で -20 LUFS にそろえる（下の「音量」）。`tts-configure` の `elevenlabs_volume_db` は ElevenLabs だけに足す上乗せ（既定 0） |
| SSML | 使わない | ElevenLabs に送る前に `<...>` 形式のタグを取り除く |

> [!WARNING]
> チャットに書いたAPIキーは会話ログに残ります。気になる場合は `npx aivis-mcp --init` か環境変数 `ELEVENLABS_API_KEY` で設定してください。
> APIキーに Voices の読み取り権限がない場合、`tts-list-voices` は使えません。ElevenLabs の画面で voice_id を調べて直接伝えてください。

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
| `--provider` | | 音声合成サービス（`aivis` / `elevenlabs`）。環境変数は `TTS_PROVIDER` | `aivis` |
| `--elevenlabs-api-key` | | ElevenLabs のAPIキー。環境変数は `ELEVENLABS_API_KEY` | - |
| `--voice-id` | | ElevenLabs の voice_id。環境変数は `ELEVENLABS_VOICE_ID` | - |
| `--eleven-model` | | ElevenLabs の model_id。環境変数は `ELEVENLABS_MODEL_ID` | `eleven_v4_turbo` |
| `--redis-url` | | Redis接続先 | `redis://127.0.0.1:6379` |
| `--debug` | `-d` | デバッグモード | off |

> [!NOTE]
> すべてのCLI引数は環境変数でも設定可能です（例: `--rate` → `AIVIS_SPEAKING_RATE`）。
> CLI引数 > 環境変数 > `config.json` > デフォルト値 の優先順位で適用されます。

## 音量

どの声も -20 LUFS にそろえて鳴らします。補正の値は `~/.config/aivis-mcp/gain.json` の表（鍵は `provider:voice:model`、Aivis は `aivis:<model_uuid>:default`）から引きます。

- 最初の値は、作者が測った Aivis と ElevenLabs のいくつかの声から入れてあります。表に無い組は、同じモデルの声の平均、それも無ければ 0dB です
- 鳴らし切った発話の補正前の音声を ffmpeg で測り、直近 9 回の中央値で表を覚え直します。感情タグ（`[whispers]` など）入り・2.5 秒未満・途中で止まった発話は使いません
- 当て方は `volume=XdB,alimiter=limit=0.89:level=false`（-1dBTP で頭打ち。alimiter が出力を持ち上げないよう level を切る）です。上げる方向は最大 +8dB で、最後の合計にもこの上限を掛けます
- ffplay・mpv が無く afplay だけの環境では、afplay の `-v` が 1.0 までなので下げる方向にしか揃えられず、覚え直しもしません

好みで全体を変えたいときは、次の上乗せ（dB）を使います。

| 指定 | 対象 | 既定 |
|---|---|---|
| 環境変数 `AIVIS_VOLUME_OFFSET_DB` / `config.json` の `volumeOffsetDb` / `tts-configure` の `volume_offset_db` | すべての声 | 0 |
| `config.json` の `elevenlabs.volumeOffsetDb` / `tts-configure` の `elevenlabs_volume_db` | ElevenLabs の声だけ | 0 |
| 環境変数 `ELEVENLABS_VOLUME_DB`（2.4 までの指定） | ElevenLabs の声だけ | 値から -13 を引いた分を上乗せとして読む |

### 覚え直しの窓と最短秒数

| 指定 | 意味 | 範囲 | 既定 |
|---|---|---|---|
| 環境変数 `AIVIS_GAIN_LEARN_WINDOW` / `config.json` の `gain.learnWindow` | 中央値を取る直近の回数 | 1〜50 の整数 | 9 |
| 環境変数 `AIVIS_GAIN_MIN_LEARN_SECONDS` / `config.json` の `gain.minLearnSeconds` | これより短い発話は覚え直しに使わない（秒） | 0.5〜30 | 2.5 |

```json
{ "gain": { "learnWindow": 9, "minLearnSeconds": 2.5 } }
```

環境変数 > `config.json` > 既定 の順に効きます。範囲外の値は既定に戻し、標準エラーに警告を出します。覚え直しは worker が発話ごとに設定を読み直すので、`config.json` を書き換えれば `--reboot` 無しで次の発話から効きます（環境変数は worker を起こしたプロセスのものを引き継ぐので、変えたら `--reboot` が要ります）。表には窓に関わらず直近 50 回分の測定を残し、中央値だけを直近の窓の回数から取ります。窓を増やしたときは残っている分だけで中央値を取ります。窓を変えても、表の値（`db`）はその声を次に覚え直すまで変わりません。

`tts-get-settings` の `gain` には、動いている worker が実際に使っている値（`source: "worker"`）を出します。worker が見つからないときは MCP サーバー自身で読んだ値（`source: "this-server"`）と、その旨の注記を出します。

既定の根拠は 10 声 × 20 文の実測です。1 回ごとのぶれは標準偏差の平均で 0.79dB ありました。中央値の窓が 5 だと採用値のずれが p99 で 1.24dB、9 だと p99 0.99dB（耳で気付く 1dB 以内）に収まります。15 では p99 0.79dB まで下がりますが、声を変えたあと落ち着くまでが遅くなります。2.5 秒以下の短い文は声によって約 -0.8dB 偏るので、覚え直しから外しています。

### 表の書き出し・読み込み

別の PC で覚えた表を持ち込めます。形式は `gain.json` と同じ `{version, target, entries}` です。

```bash
# 書き出す（--voice は何度でも指定でき、どれかに一致する行。--model は鍵の最後と一致する行）
aivis --export-gains gains.json
aivis --export-gains gains.json --voice <voice_id> --voice <voice_id> --model eleven_v3

# 読み込んで足す。自分の表にすでにある行は自分の値を残す
aivis --import-gains gains.json
# 受け取った値で上書きする
aivis --import-gains gains.json --overwrite
```

`aivis-mcp` でも同じ引数で使えます。Aivis の行は鍵が `aivis:<model_uuid>:default` なので、`--voice` にモデル UUID、`--model` に `default` を渡します。読み込んだ行は直近の測定（`samples`）ごと入るので、そのまま覚え直しを続けられます。取り込んだ行の更新時刻は取り込んだ時刻にします。表の上限（200 行）を超えたときは更新の古い行から消え、入らなかった行と消えた行の数を表示します。`target` が違うファイル（揃える大きさが違うもの）と、JSON として壊れている・1 行でも形が違うファイルは、何も書き換えずに拒みます。書き出し先が自分の `gain.json` そのものなら拒みます。

書き込みは一時ファイルに書いて fsync してから置き換えます（`gain.json` がシンボリックリンクなら実体を書き換えます）。worker の覚え直しと読み込みが重ならないよう、どちらも `gain.json.lock` を排他で作ってから読み書きします。10 秒より古いロックは持ち主が落ちたとみなして消します。

### 2.4 からの読み替え

2.4 までの `config.json` の `elevenlabs.volumeDb`（-13 が既定の絶対値）は、2.5 で初めて読んだときに 1 回だけ「今の値 − (-13)」の上乗せへ読み替え、移行済みの印（`volumeMigrated`）を残します。-13 のままなら上乗せは 0 です。

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
npx aivis-mcp --export-gains gains.json   # 音量の表を書き出す（上の「音量」）
npx aivis-mcp --import-gains gains.json   # 音量の表を読み込んで足す
```

> [!IMPORTANT]
> 更新したら `npx aivis-mcp --reboot` で worker を起動し直してください。新しい版の worker は古い版の worker から自動で引き継ぎますが、起動し直すのが確実です。

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

## Para Code との連携

Para Code から起動されると、次のように動きます。

- Para Code の通知の読み上げ（着信音つき）と SSH 先の声は、Para Code が常駐させる `aivis-mcp --ingest` を通して同じ worker の列に入ります。エージェントの声とも重ならず、許可・質問の通知（high）が先に読まれます。音声入力中は hold で止まります
- `--ingest` の標準入出力の取り決めは [docs/ingest-protocol.md](./docs/ingest-protocol.md) にあります
- エージェントの声は、合成しながら Para Code（モバイルアプリ）へも送ります。Para Code が新しい取込（`stream-v1`）を名乗ったときだけ、受け取りながら chunked で送ります
- SSH 先で発話したときは、Para Code が応答のヘッダー `X-Para-Local-Playback: accepted` で引き受けたら接続先では鳴らさず、ヘッダーが 1 つも来ないまま接続に失敗したときだけ接続先で鳴らします

## 使用例

カスタムコマンドとして[aivis.md](./aivis.md)のように登録することで簡単に音声で報告してくれるようにできます

## アーキテクチャ

```
 Claude / Codex (MCP)   aivis "hello" (CLI)    Para Code（aivis-mcp --ingest）
        │                     │                      │ 枠の標準入出力
        └──────── LPUSH ──────┴──────────────────────┤ XADD aivis-mcp:audio:<id>
                      ▼                              ▼
              ┌───────────────────────────────────────────┐
              │ Redis                                     │
              │  aivis-mcp:q2:high / :normal（2.5 の列）  │
              │  aivis-mcp:queue（2.4 までの列）          │
              │  aivis-mcp:audio:<id>（音声の Stream）    │
              └───────────────┬───────────────────────────┘
                              │ BRPOP（high → normal → 旧）／ XREAD BLOCK（別の接続）
                     ┌────────▼─────────┐
                     │ worker（lock 1つ）│  合成しながら Stream に流す（エージェントの声）
                     │ 着信音 → 声       │  音量の表で -20 LUFS にそろえる
                     └────────┬─────────┘
                              │ 0.25 秒溜めてから 1 発話 1 デコーダ
                       ┌──────▼──────┐
                       │ ffplay / mpv│（無ければ afplay で全部溜めてから）
                       └─────────────┘
```

## 変更履歴

[CHANGELOG.md](./CHANGELOG.md) を参照してください。
