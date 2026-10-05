# Changelog

## [2.5.4] - 2026-10-05

更新したら `aivis-mcp --reboot` で worker を起動し直してください。

### ElevenLabs の声ごとの調整

- `config.json` の `elevenlabs.voiceSettings` に voice_id ごとの `stability` / `similarityBoost`（0〜1）を書くと、その声の合成で `voice_settings` に `stability` / `similarity_boost` を入れます。書いていないキーは送らず、ElevenLabs に保存した値を使います。`speed` はこれまでどおり
- `eleven_v3` 系では stability を 0 / 0.5 / 1 の最寄りに丸めます
- worker は発話ごとに設定を読み直します。範囲外の値・voice_id の形でない鍵は使わず、1 回だけ警告します
- `tts-configure` の `elevenlabs_voice_settings` で設定・解除（`null`）でき、`tts-get-settings` の `elevenlabs.voice_settings` に表示します
- Para Code から呼ぶ `aivis-mcp --set-voice-settings --voice <voice_id> [--stability <0..1>] [--similarity <0..1>]` と `--clear-voice-settings --voice <voice_id>` を足しました（出力の取り決めは `--set-dictionary` と同じ）

### 音量の表を機械が読める形で

- `aivis-mcp --list-gains --json`: 表（覚えた行と最初の値の行）を `{version, target, learnWindow, minLearnSeconds, entries:[{key, provider, voice, model, gainDb, sampleCount, updatedAt}]}` の JSON 1 つで出します。`--json` 無しは人が読む一覧
- `aivis-mcp --reset-gain --key <provider:voice:model>`: その行の測定を捨てます（`gain.json.lock` を持って行ごと消す。壊れた `gain.json` は書かない）
- `aivis-mcp --set-gain-learning [--window N] [--min-seconds S]`: `config.json` の `gain.learnWindow` / `gain.minLearnSeconds` を書きます
- `--export-gains` / `--import-gains` に `--json` を付けると、標準出力に `{"ok":true,"written":N}` / `{"ok":true,"added":N,"updated":N,"skipped":N,"evicted":N,"dropped":N}` だけを出し、失敗は標準エラーに `error: <理由>` と終了コード 1

## [2.5.3] - 2026-10-05

更新したら `aivis-mcp --reboot` で worker を起動し直してください。

### ElevenLabs で前の発話の調子をつなげる

- worker が直前に合成した声の発話 1 件を覚え、次の発話がそれと同じ voice_id・model_id で 5 分以内なら、前の発話の request ID（応答ヘッダー `request-id`。取れていなければ SSML 風のタグを除いた前の文）を `previous_request_ids` / `previous_text` として付けます。どのペインからの発話かは問いません
- 間に別の声・別のモデル・Aivis の発話、取込の声（Para Code の通知や SSH 先から届いた合成済みの声）が挟まったら付けません。着信音（sound ジョブ・prelude）は挟まっても切れません
- 本文を最後まで読み終えた要求だけを覚えます。合成に失敗した・途中で止めた発話は記録を消し、次はつなげません
- request ID は 2 時間以内のものだけを使い、それより古ければ前の文を付けます。`eleven_v3` 系には付けません。`next_text` / `next_request_ids` は付けません
- 文脈を付けた要求が 4xx（401・403・429 を除く）で失敗したら、文脈なしで 1 回だけ合成し直します
- 窓は環境変数 `AIVIS_ELEVENLABS_CONTEXT_MINUTES` > `config.json` の `elevenlabs.contextWindowMinutes` > 既定 5 分。0 で付けません（0〜1440、外れた値は既定に戻して警告）。`tts-configure` の `elevenlabs_context_window_minutes` でも変えられます
- 覚えるのは worker のメモリだけです。SSH 先の worker が合成して Para Code へ送る発話も、その worker のメモリで同じに動きます
- `tts-get-settings` の `elevenlabs.context` に、動いている worker が使っている窓（`source: "worker"`）と、今のモデルで付くかどうかを出します

### 辞書を使う

- `config.json` の `elevenlabs.pronunciationDictionaryId`（省略可で `pronunciationDictionaryVersionId`）を `pronunciation_dictionary_locators` として、`aivis.userDictionaryUuid` を `user_dictionary_uuid` として、合成のたびに付けます。worker は発話ごとに設定を読み直すので再起動は要りません
- ElevenLabs で版を書いていなければ、合成のたびに最新の版を取って 60 秒覚えます。取れない・アーカイブ済みなら辞書なしで合成します
- `tts-list-dictionaries` で ElevenLabs の発音辞書（アーカイブ済みは除く）と Aivis のユーザー辞書の一覧を出します
- `tts-configure` の `elevenlabs_pronunciation_dictionary_id`・`elevenlabs_pronunciation_dictionary_version_id`・`aivis_user_dictionary_uuid` で設定し、空文字で解除します。見つからない・アーカイブ済みの辞書は保存しません
- Para Code などから呼ぶ `--set-dictionary --provider <elevenlabs|aivis> --id <id> [--version-id <id>]` と `--clear-dictionary --provider <elevenlabs|aivis>` を足しました。成功は標準出力に `ok` の 1 行、失敗は標準エラーに `error: <理由>` の 1 行と終了コード 1 です。取り決めは README の「辞書」にあります

### 設定ファイルを順番に書く

- `config.json` の書き込み（`tts-configure`・`--set-dictionary`・`--init`）は、`config.json.lock` を持って読み直してから書きます。同時に書いても互いの変更を消しません。2.4 からの音量の読み替えは、ロックが空いていないときは書かずに次に読むときに回します
- 書く前に読んだ `config.json` が JSON として壊れている・読めないときは、書かずにエラーにします（APIキーなど既存の設定を変更分だけで上書きして消さないため）

## [2.5.2] - 2026-10-05

更新したら `aivis-mcp --reboot` で worker を起動し直してください。

### 音量の覚え直しを安定させる

- 中央値を取る直近の回数（窓）を 5 から 9 に、覚え直しに使う最短の長さを 1.5 秒から 2.5 秒にしました
- 根拠は 10 声 × 20 文の実測です。1 回ごとのぶれは標準偏差の平均で 0.79dB ありました。窓 5 だと採用値のずれが p99 で 1.24dB でしたが、窓 9 では p99 0.99dB と、耳で気付く 1dB 以内に収まります。窓 15 は p99 0.79dB ですが、落ち着くまでが遅くなります。2.5 秒以下の短い文は声によって約 -0.8dB 偏るので、覚え直しから外しました
- 窓と最短秒数は `config.json` の `gain.learnWindow`・`gain.minLearnSeconds`、環境変数 `AIVIS_GAIN_LEARN_WINDOW`・`AIVIS_GAIN_MIN_LEARN_SECONDS` で変えられます（環境変数 > `config.json` > 既定）。窓は 1〜50、秒は 0.5〜30 で、外れた値は既定に戻して警告します。`config.json` の変更は `--reboot` 無しで次の発話から効きます
- 表には窓に関わらず直近 50 回分の測定を残し、中央値だけを窓の回数で取ります。窓を増やしたときは残っている分で中央値を取ります。表の値は、その声を次に覚え直すまで変わりません
- `tts-get-settings` に、動いている worker が実際に使っている窓と最短秒数（`gain.learn_window`・`gain.min_learn_seconds`）を出します。worker が見つからなければ MCP サーバーで読んだ値と注記を出します

### 音量の表を書き出し・読み込む

- `aivis --export-gains <file> [--voice <voice_id>…] [--model <model_id>]` で、覚えた表を（声・モデルで絞り込んで）`gain.json` と同じ形で書き出します
- `aivis --import-gains <file> [--overwrite]` で、書き出した表を自分の表に足します。既定では自分の表にある行は自分の値を残し、`--overwrite` で受け取った値に置き換えます。直近の測定ごと取り込みます
- `target` が違うファイルや壊れたファイルは、何も書き換えずに拒みます。書き出し先が自分の表そのものなら拒みます
- 取り込んだ行は取り込んだ時刻で更新したことにし、表の上限（200 行）で入らなかった行・消えた行の数を表示します
- worker の覚え直しと読み込みが同時に書いても互いの行を消さないよう、`gain.json.lock` で順番に書きます
- 値の無い `--export-gains` / `--import-gains` は、使い方を出して終了コード 1 で終わります
- `aivis-mcp` でも同じ引数で使えます

## [2.5.1] - 2026-10-05

更新したら `aivis-mcp --reboot` で worker を起動し直してください。

### 声が重ならず、止めたら止まる

- Redis が一瞬切れた・応答しなくなったときに、鳴っている声が止まらず次の発話と重なることがありました。どこで止まっても、プレイヤーを止めて終わったのを確かめてから次へ進みます
- Redis に届かない間も、再生の順番を守る印（lock）の期限をこの機械の時計で数え、期限が切れる前に鳴らすのを止めます。別の worker と二重に鳴らなくなります
- 着信音だけの通知と、古い形の音声にも 1 件 120 秒の上限を掛けます。止めても終わらないプレイヤーは強制終了します
- 2.4 の worker から引き継いだ直後に、古い worker が待っている発話を鳴らしてしまうことがあったのを防ぎます
- 止めた発話の合成を、応答を待っている途中でも取り消します（使わない合成を続けません）

### 鳴らせない・音量がずれる、を直す

- プレイヤーが無い・起動できない・途中で落ちたのに「鳴らし終えた」と扱っていたのを、失敗として知らせるようにしました。鳴らせなかった発話で音量を覚え直すこともなくなりました
- Linux で mplayer か play（sox）しか無い環境で、2.5.0 から鳴らなくなっていたのを直しました（全部受け取ってから鳴らします）
- 頭打ち（alimiter）が出力を持ち上げていたため、揃えた音量より大きく鳴っていたのを直しました
- Aivis の声の先頭に足していた 0.5 秒の無音をやめ、鳴り始めがその分速くなりました

### 順番・ミュート・音声入力

- 再生の順番を待つ間に許可・質問の通知が来たら、まだ鳴らしていないふつうの発話より先に鳴らします
- 再生の順番を待つ間に `aivis --mute` したら鳴らしません
- 音声入力中（hold）に worker が入れ替わっても、待っていた発話が「待ちすぎ」で捨てられないようにしました
- SSH 先で `aivis --mute` しているとき、ミュートの印を解する新しい Para Code にだけ送り、手元の PC では鳴らしません（古い Para Code には送りません）

### SSH 先の声と Para Code

- SSH 先の声の受け渡しに使う使い切りの鍵（ticket）を、鳴らし始める時にも取り直すようにしました。長く待った発話でも鍵が切れません。積む時に取った控えも持つので、エージェントが先に終わっても鳴ります。鍵が取れないときは、接続先で鳴らさずに失敗として知らせます
- SSH 先の声を Para Code へ送っている間も、音声入力（hold）や打ち切りで止まるようになりました。Para Code が引き受けた後に止めたときは、接続先では鳴らしません
- Para Code が引き受けた後に「手元で鳴らせなかった」と返したときは、接続先で鳴らします
- `aivis --mute` の間も、Para Code から起動されたエージェントの声はモバイルへ届きます（この機械では鳴らしません）
- 感情タグ入りの発話であることを Para Code へ知らせます（音量の覚え直しに使わないため）

### コマンドと Para Code の取込口

- `aivis-mcp "<文>"` で発話したときも、Para Code のモバイルへ届くようにしました
- 2.5.0 以前へ戻すときは、先に `aivis-mcp --restore-legacy-queue` を実行してください。2.4 の worker から引き継いだときに移した発話を、古い列へ戻します（戻さないと 2.5.0 以前はその発話を読みません）
- `--play-audio` に `--gain-key` を足しました。2.5 の worker なら、ほかの発話と同じ列に積み、音声入力中は待ちます
- Para Code の取込口（`--ingest`）を直しました。Redis の応答が失われた件を「積めなかった」と知らせて二重に鳴ることが無くなり、音声入力の合図が音声の書き込み待ちで遅れなくなりました。取り決めの変更点は [docs/ingest-protocol.md](./docs/ingest-protocol.md) にあります

## [2.5.0] - 2026-10-05

### 鳴り始めを速くし、どの声も同じ大きさで、1 つの列で鳴らす

更新したら `aivis-mcp --reboot` で worker を起動し直してください。新しい worker は古い版の worker から lock を引き取りますが、起動し直すのが確実です。

- 鳴り始めが約 0.5 秒速くなりました。デコーダを `-probesize 32 -analyzeduration 0 -fflags nobuffer` で起こし、0.25 秒ぶん溜まった時点で鳴らし始めます。1 つの発話は最初から最後まで 1 つのデコーダで鳴らすので途切れず、届くのが追いつかないときは一瞬待ってから続きを鳴らします
- 発話が積んだ順に鳴るようになりました。これまでは後から積んだ発話が先に鳴ることがありました（後入れ先出し）
- どの声も -20 LUFS にそろえて鳴らします。声とモデルの組ごとの音量の表（`~/.config/aivis-mcp/gain.json`）を持ち、鳴らした発話を ffmpeg で測って覚え直します。上げる方向は最大 +8dB で、頭打ち（-1dBTP）を掛けます
- 全体の音量の好みは `AIVIS_VOLUME_OFFSET_DB`（または `tts-configure` の `volume_offset_db`）で上乗せできます。2.4 までの ElevenLabs の `volume_db`（既定 -13）は、1 回だけ「今の値 − (-13)」の上乗せへ自動で読み替えます
- Para Code 用の取込口 `aivis-mcp --ingest` を追加しました。Para Code の通知（着信音つき）と SSH 先の声が、エージェントの声と同じ列に入り、重ならずに順に鳴ります。許可・質問の通知は先に読みます。取り決めは [docs/ingest-protocol.md](./docs/ingest-protocol.md)
- 音声入力中は hold で止まります。鳴っている発話は止め、待っている発話は残して後で鳴らします
- `aivis --mute` の間は、Para Code の通知の着信音も鳴らしません
- 長く待った発話（ふつう 120 秒・優先 600 秒）は鳴らさずに捨てます。5 秒以上待った着信音は飛ばし、声だけ読みます
- SSH 先の声は、新しい Para Code なら合成しながら送ります。Para Code が引き受けたら接続先では鳴らさず、届かなかったときだけ接続先で鳴らします
- ffmpeg が無い環境向けに、`--doctor` が ffmpeg を勧めるようになりました（afplay だけでは全部受け取ってから鳴らし、音量は下げる方向にしか揃えられません）
- worker を止めた（`--reboot` など）ときに lock をすぐ手放すようにしました。これまでは 20 秒の間、次の worker が起きないことがありました
- worker を止めたときは、鳴らしている発話を止めて失敗を知らせ、再生の lock もすぐ手放します。再生の lock は 10 秒の期限で、鳴らしている間 3 秒ごとに延長します
- `aivis-mcp --reboot` は `--ingest`（Para Code の取込口）を止めません
- Redis の自動起動が、起動した場所に `temp/` を作らないようにしました（OS の一時フォルダを使います）。redis-server が無いときに落ちないようにしました
- 設定ファイル（`config.json`・`gain.json`）は一時ファイルに書いてから置き換えます

## [2.4.0] - 2026-10-04

### Para Code で SSH 先の発話を手元のPCで鳴らす

Para Code の SSH 接続先のターミナルで発話すると、接続先ではなく手元のPCで鳴るようになりました。モバイルアプリへの転送も SSH 先から届くようになります。

- SSH 先のポートファイル（`pid` と `instanceId` が無い）でも、戻り経路の `/paradis-mcp/health` で確かめて Para Code へ音声を渡します
- Para Code が手元で鳴らすと答えたときは、接続先では鳴らしません。手元で鳴らせなかったときだけ接続先で鳴らします
- 手元のPCでは `aivis-mcp --play-audio`（標準入力のMP3をキューに積む）で、ほかの発話と重ならずに順番に鳴ります。ミュートも効きます
- 更新したら `aivis-mcp --reboot` で worker を起動し直してください。古い worker が動いている間は、`--play-audio` は積まずに失敗し、接続先で鳴ります

## [2.3.0] - 2026-08-15

### ミュート機能を追加

一時的に音声を鳴らさないようにできるようになりました。MCP経由・CLI経由どちらの発話も、単一のWorkerが再生前にミュート状態を確認するため、両方の経路を一括で止められます。

```bash
aivis --mute                      # ミュート（自分で解除するまで）
aivis --mute --mute-for 30m       # 30分間だけミュート
aivis --unmute                    # ミュート解除
aivis --mute-status               # ミュート状態を確認
```

- `--mute-for` は `30m` / `1h` / `90s` / `5000ms` のような相対時間指定に対応
- 時限ミュートはRedisのTTLで自動失効するため、専用の解除処理は不要
- ミュート中はAPI呼び出し・再生を行わずスキップするので、Aivis Cloud APIの利用料もかかりません

## [2.1.0] - 2026-02-09

### `--init` コマンド追加

CLIから初期設定（APIキー、モデルUUID）を `~/.config/aivis-mcp/config.json` に保存できるようになりました。

```bash
npx aivis-mcp --init
```

- 設定の優先順位: CLI引数 > 環境変数 > config file > デフォルト値
- MCP経由でもCLI経由でも同じ設定ファイルを参照

## [2.0.0] - 2026-02-09

### npx対応・npm公開

`npx -y aivis-mcp` でインストール不要で即実行できるようになりました。

```json
{
  "mcpServers": {
    "aivis": {
      "command": "npx",
      "args": ["-y", "aivis-mcp"],
      "env": { "AIVIS_API_KEY": "your_key" }
    }
  }
}
```

### 環境変数の大幅削減

必須の環境変数は `AIVIS_API_KEY` のみになりました。
音声パラメータはすべてCLI引数で設定可能です。

- `--model`, `--rate`, `--pitch`, `--volume` 等のCLI引数を追加
- CLI引数 > 環境変数 > デフォルト値 の優先順位で適用
- `.env` ファイルとホットリロード機能を廃止

### `--doctor` コマンド追加

依存ツール（Redis、FFmpeg）の診断と対話的なインストール補助を追加しました。

```
$ npx aivis-mcp --doctor

=== aivis-mcp doctor ===

[1/4] Node.js
  OK  v22.12.0 (>= 18.x)

[2/4] AIVIS_API_KEY
  OK  設定済み

[3/4] Redis
  NG  redis-server が見つかりません
      インストールしますか？ (brew install redis) [Y/n]

[4/4] FFmpeg (ffplay)
  OK  ffplay が見つかりました
```

MCPサーバー起動時にも依存不足をstderrで警告します。

### 不要依存パッケージの除去

以下のパッケージを削除しました：

- `dotenv` - CLI引数 + 環境変数で完結
- `chokidar` - .envホットリロード廃止
- `express`, `cors` - 未使用

### コードの構造改善

- `src/config.ts` - 設定の一元管理（AppConfig型、resolveConfig）
- `src/doctor.ts` - 依存診断コマンド
- `src/commands.ts` - health/rebootコマンドの切り出し
- `src/services/redis-service.ts` - Redis関連ロジックの共通化
- シングルトンパターンを廃止し、依存注入（AppConfig）に変更

## [1.2.0] - 2025-02-09

### ESM移行

CommonJS から ESM (ECMAScript Modules) に移行しました。
Node.js 22.12 未満で chokidar v5 の `require()` が `ERR_REQUIRE_ESM` で失敗する問題を解消しています。

- `package.json` に `"type": "module"` を追加
- TypeScript のモジュール設定を `NodeNext` に変更
- `__dirname` を `import.meta.url` ベースに置換
- 不要になった `@types/chokidar` を削除

### `aivis --version` コマンド追加

バージョン情報を確認できるようになりました。

```
$ aivis --version
aivis-mcp v1.2.0
```

### Node.js バージョン要件の明示

`package.json` に `engines` フィールドを追加し、Node.js 18 以上を明示しました。

## [1.1.0] - 2025-02-08

### CLIの即時返却対応

CLIコマンド (`aivis "テキスト"`) がMCPと同じRedisキュー経由で動作するようになりました。
音声合成・再生の完了を待たずに即座にコマンドが返ります。

- 変更前: `synthesizeAndPlay()` を直接呼び出し、再生完了まで待機
- 変更後: Redisキューにエンキューして即座に終了。ワーカーがバックグラウンドで再生

ワーカーが起動していない場合は自動的に起動します。

### 排他制御の修正

CLI側の安全でない play-lock 実装を廃止しました。

- 変更前: CLI が固定値 `'1'` でロック取得し、`DEL` で無条件解放 → 他プロセスのロックを誤って解放する可能性があった
- 変更後: ワーカーのみが play-lock を管理。Lua スクリプトで自分のロックだけを安全に解放

### `aivis --health` コマンド追加

環境の状態を一覧で確認できるヘルスチェックコマンドを追加しました。

### `aivis --reboot` コマンド追加

全プロセスの停止・Redis初期化・ワーカー再起動を一括で行うコマンドを追加しました。

### `npm install` 時の自動セットアップ

`npm install` 実行時に自動でビルドと `npm link` が行われ、`aivis` コマンドがグローバルに登録されるようになりました。
手動で `npm run build` や `npm link` を実行する必要はありません。

### ワーカープロセスの識別

ワーカー起動時に `--worker` 引数を付与するようにしました。
`ps` コマンドやヘルスチェックでワーカーと MCP サーバーを区別できます。
