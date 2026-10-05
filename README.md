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
| `tts-get-settings` | 現在のサービス、声、モデル、音量の覚え直し方（窓と最短秒数）、前の発話の文脈、辞書、声ごとの調整を表示（APIキーは伏せ字） |
| `tts-configure` | サービス、APIキー、声、モデル、音量補正、文脈を付ける時間、辞書、声ごとの調整を変更して保存。無効なAPIキーや存在しないモデル・辞書は保存しない |
| `tts-list-voices` | 声の候補を検索（ElevenLabs はアカウントのボイスライブラリ、Aivis は公開モデル） |
| `tts-list-dictionaries` | ElevenLabs の発音辞書（アーカイブ済みは除く）と Aivis のユーザー辞書の一覧 |
| `elevenlabs-list-models` | ElevenLabs の日本語対応モデル一覧 |

`aivis-speech` に `provider` / `voice_id` / `model_id` を渡すと、その発話だけ別のサービスや声で話せます。

| 項目 | デフォルト | 補足 |
|---|---|---|
| モデル | `eleven_v4_turbo` | `elevenlabs-list-models` で他のモデルを確認できる |
| 音量 | 自動 | 声とモデルの組ごとの表で -20 LUFS にそろえる（下の「音量」）。`tts-configure` の `elevenlabs_volume_db` は ElevenLabs だけに足す上乗せ（既定 0） |
| SSML | 使わない | ElevenLabs に送る前に `<...>` 形式のタグを取り除く |

### 前の発話の文脈（ElevenLabs）

worker は、直前に合成した声の発話 1 件を覚えます。次の発話がそれと同じ voice_id・model_id で、前の発話を読み終えてから 5 分以内なら、前の発話の request ID（応答ヘッダー `request-id`。取れていなければ前の文）を `previous_request_ids` / `previous_text` として付け、声の調子をつなげます。どのペイン・どのエージェントからの発話かは問いません。SSH 先の worker が合成して Para Code へ送る発話も、その worker のメモリで同じに動きます。

| 場面 | 文脈 |
|---|---|
| 直前の声の発話と同じ voice_id・model_id で、窓の中 | 付ける（request ID は 2 時間以内のものだけ。古ければ前の文） |
| 間に別の声・別のモデル・Aivis の発話が挟まった | 付けない（直前の記録がその発話に置き換わる） |
| 間に着信音（sound ジョブ・prelude）だけが挟まった | 付ける（声でない再生は記録を変えない） |
| 間に取込の声（Para Code の通知・SSH 先から届いた合成済みの声。`--ingest` の stream ジョブ）が挟まった | 付けない（鳴らしたら記録を消す） |
| 直前の発話の合成が失敗した・途中で止めた | 付けない（記録を消す。ElevenLabs は読み終えていない要求の ID を使えない） |
| `eleven_v3` 系のモデル | 付けない（公式に非対応） |
| 文脈を付けた要求が 4xx（401・403・429 を除く）で失敗 | 文脈なしで 1 回だけ合成し直す |

`next_text` / `next_request_ids` は付けません。覚えるのは worker のメモリだけで、worker が入れ替わったら消えます。

窓は環境変数 `AIVIS_ELEVENLABS_CONTEXT_MINUTES` > `config.json` の `elevenlabs.contextWindowMinutes` > 既定 5 分 の順に効きます（`tts-configure` の `elevenlabs_context_window_minutes` でも変えられます）。0 で付けません。範囲は 0〜1440 で、外れた値は既定に戻して警告します。

### 辞書

`config.json` に辞書を書くと、合成のたびに要求へ付けます。worker は発話ごとに設定を読み直すので、`--reboot` は要りません。

| 指定 | 付け方 |
|---|---|
| `elevenlabs.pronunciationDictionaryId`（省略可で `elevenlabs.pronunciationDictionaryVersionId`） | `pronunciation_dictionary_locators` に 1 つ。版を書かなければ、合成のたびに最新の版を取り（60 秒覚える）、取れない・アーカイブ済みなら辞書なしで合成する |
| `aivis.userDictionaryUuid` | Aivis の `user_dictionary_uuid` |

```json
{
  "elevenlabs": { "pronunciationDictionaryId": "<dictionary_id>" },
  "aivis": { "userDictionaryUuid": "<uuid>" }
}
```

LLM からは `tts-list-dictionaries` で一覧を見て、`tts-configure` の `elevenlabs_pronunciation_dictionary_id`（と `elevenlabs_pronunciation_dictionary_version_id`）・`aivis_user_dictionary_uuid` で設定します。空文字を渡すと解除します。アーカイブ済み・見つからない辞書は保存しません。

#### Para Code などから設定する CLI

```bash
aivis-mcp --set-dictionary --provider elevenlabs --id <dictionary_id> [--version-id <version_id>]
aivis-mcp --set-dictionary --provider aivis --id <uuid>
aivis-mcp --clear-dictionary --provider elevenlabs
aivis-mcp --clear-dictionary --provider aivis
```

取り決め（呼ぶ側はこれだけを当てにしてよい）:

- 成功したら標準出力に `ok` の 1 行だけを書き、終了コード 0 で終わる
- 失敗したら標準出力には何も書かず、標準エラーに `error: <理由>` の 1 行を書き、終了コード 1 で終わる。設定は書き換えない
- API は呼ばない。ID の形（ElevenLabs は英数字と `-` `_`、Aivis は UUID）だけを確かめる
- ElevenLabs で別の辞書を設定すると、前の辞書の版は消す（`--version-id` を省けば最新の版を使う）。`--version-id` は ElevenLabs だけ
- `config.json` の書き込みは、`config.json.lock` を持って読み直してから一時ファイル経由で置き換える（`tts-configure` と同時に書いても互いの変更を消さない）。ロックが 5 秒空かなければ失敗にする。読んだ `config.json` が JSON として壊れている・読めないときも、書かずに失敗にする（既存の設定を消さない）
- `aivis` コマンドでも同じ引数で使える

### 声ごとの調整（ElevenLabs）

`config.json` の `elevenlabs.voiceSettings` に voice_id ごとの `stability` / `similarityBoost`（どちらも 0〜1）を書くと、その声の合成で `voice_settings` に `stability` / `similarity_boost` として入れます。書いていないキーは送らないので、ElevenLabs に保存してある値が使われます。話速から決める `speed` はこれまでどおり一緒に送ります。worker は発話ごとに設定を読み直すので、`--reboot` は要りません。

```json
{
  "elevenlabs": {
    "voiceSettings": {
      "<voice_id>": { "stability": 0.4, "similarityBoost": 0.8 }
    }
  }
}
```

`eleven_v3` 系のモデルは stability に 0 / 0.5 / 1 しか受け付けないので、最寄りの値に丸めて送ります（ちょうど中間は大きい方）。similarity_boost は丸めません。範囲外・数でない値と、voice_id の形でない鍵は使わず、標準エラーに 1 回だけ警告を出します。

LLM からは `tts-configure` の `elevenlabs_voice_settings`（`voice_id` を省くと今の声。`stability` / `similarity_boost` は指定したキーだけ変え、`null` で消す）で設定し、`tts-get-settings` の `elevenlabs.voice_settings` で確かめます（`current_voice_sent` は今の声・モデルで実際に送る値）。

#### Para Code などから設定する CLI

```bash
aivis-mcp --set-voice-settings --voice <voice_id> [--stability <0..1>] [--similarity <0..1>]
aivis-mcp --clear-voice-settings --voice <voice_id>
```

- `--set-voice-settings` には `--stability` と `--similarity` の少なくとも一方が要ります。指定したキーだけを置き換え、もう一方は残します
- `--clear-voice-settings` はその声の調整をまるごと消します（ElevenLabs に保存した値に戻る）。調整の無い声を消しても `ok`
- voice_id は辞書の ID と同じ形（英数字と `-` `_`、128 文字まで）だけを受け付けます。API は呼びません
- 出力・終了コード・`config.json.lock`・壊れた `config.json` を書かない取り決めは、上の `--set-dictionary` と同じです

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

### Para Code などから表を読む・直す CLI

```bash
aivis-mcp --list-gains --json
aivis-mcp --reset-gain --key <provider:voice:model>
aivis-mcp --set-gain-learning [--window <1..50>] [--min-seconds <0.5..30>]
aivis-mcp --export-gains <file> [--voice <id>…] [--model <id>] --json
aivis-mcp --import-gains <file> [--overwrite] --json
```

`--list-gains --json` は標準出力に JSON を 1 つだけ書きます（`--json` を付けなければ人が読む一覧）。

```json
{"version":1,"target":-20,"learnWindow":9,"minLearnSeconds":2.5,"entries":[{"key":"elevenlabs:<voice_id>:eleven_v3","provider":"elevenlabs","voice":"<voice_id>","model":"eleven_v3","gainDb":-3.1,"sampleCount":4,"updatedAt":1790000000000}]}
```

| 項目 | 意味 |
|---|---|
| `entries` | 覚えた行と、最初の値の行を合わせたもの（鍵の順）。表に無い組（同じモデルの平均や 0dB で鳴らす組）は出ない |
| `gainDb` | 今使っている値。覚えた行は直近の窓の中央値（最後に覚え直したときの値）、最初の値だけの行はその値 |
| `sampleCount` | 保存している測定の数（最大 50。窓に入る数ではない）。最初の値だけの行は 0。`learnWindow` と比べると覚え直しの進み具合が分かる |
| `updatedAt` | 最後に覚え直した時刻（epoch ミリ秒）。最初の値だけの行・時刻の無い行は `null` |
| `learnWindow` / `minLearnSeconds` | 環境変数 > `config.json` > 既定 で決めた値（このコマンドを動かしたプロセスの環境変数で読む。worker を起こしたプロセスと違うと、worker の値とずれることがある） |

`--reset-gain` はその行の測定を捨てます（行ごと消すので、最初の値がある組はその値に、無い組は同じモデルの平均か 0dB に戻ります）。`gain.json.lock` を持って読み書きし、行が無い・表が無いときは何も書かずに `ok` です。`gain.json` が JSON として壊れているときは書きません。

`--set-gain-learning` は `config.json` の `gain.learnWindow` / `gain.minLearnSeconds` を書きます（少なくとも一方。範囲は上の表と同じ）。表の値はその声を次に覚え直すまで変わりません。

`--reset-gain` / `--set-gain-learning` の出力と終了コードは `--set-dictionary` と同じです（成功は標準出力に `ok`、失敗は標準エラーに `error: <理由>` と終了コード 1）。`--export-gains` / `--import-gains` に `--json` を付けると、成功時は標準出力に次の 1 行だけを書き、失敗時は標準出力に何も書かず標準エラーに `error: <理由>` を書いて終了コード 1 で終わります（`--import-gains` の `--voice` の警告は標準エラーに出ます）。

```json
{"ok":true,"written":3}
{"ok":true,"added":2,"updated":0,"skipped":1,"evicted":0,"dropped":0}
```

`updated` は受け取った値で上書きした行、`skipped` は自分の値を残した行、`evicted` は取り込んだ行に押し出されて消えた自分の行、`dropped` は表の上限で入らなかった取り込みの行です。

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
npx aivis-mcp --set-dictionary --provider aivis --id <uuid>   # 辞書を使う（上の「辞書」）
npx aivis-mcp --clear-dictionary --provider aivis             # 辞書を使わない
npx aivis-mcp --set-voice-settings --voice <voice_id> --stability 0.5   # 声ごとの調整（上の「声ごとの調整」）
npx aivis-mcp --list-gains                                   # 音量の表を見る
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
