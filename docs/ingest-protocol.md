# `aivis-mcp --ingest` の取り決め（取り決めの版 1）

`aivis-mcp --ingest` は、Para Code などの親プロセスが起動する常駐の子です。親が合成した声（MP3）を標準入力で受け取り、Redis Stream `aivis-mcp:audio:<id>` に流し込んで、手元の worker の列に積みます。鳴らすのは worker だけで、親は `queued` を受け取った時点で手を離せます。

```bash
aivis-mcp --ingest --prelude-dir <着信音のフォルダ> [--prelude-dir <別のフォルダ> ...]
```

- `--prelude-dir` は着信音（prelude）として鳴らしてよいフォルダです。複数指定できます。ここに無いファイルは着信音として使いません
- 接続先の Redis は、ほかの起動方法と同じく `--redis-url` / `REDIS_URL` / `config.json` / `redis://127.0.0.1:6379` の順で決まります
- 標準出力は枠（下記）だけに使います。ログは標準エラーにだけ出ます
- 親が標準入力を閉じると、書きかけの流れを中断し、この子が置いた hold を外して終わります（終了コード 0）
- Redis に接続できないときは `hello` と `{"type":"error","reason":"redis-unavailable"}` を出して終了コード 1 で終わります

## 枠

標準入力も標準出力も、すべて次の枠の並びです。JSON の行と 2 進を混ぜません。

| 位置 | 長さ | 中身 |
|---|---|---|
| 0 | 1 バイト | 型 |
| 1 | 4 バイト | 中身の長さ（符号なし整数・ビッグエンディアン） |
| 5 | 長さぶん | 中身 |

中身の上限は 1 MiB（1048576 バイト）です。これを超える長さを名乗る枠や、知らない型の枠を受けると、`aivis-mcp` は `{"type":"error","reason":"protocol"}` を出して終わります（以後の枠の境目が分からないため）。

| 型 | 名前 | 中身 |
|---|---|---|
| `0x01` | 制御 | UTF-8 の JSON オブジェクト。必ず文字列の `type` を持つ |
| `0x02` | 音声 | 流れ ID の長さ（1 バイト、1〜255）＋ 流れ ID（UTF-8）＋ MP3 のバイト列 |

音声の枠は親から `aivis-mcp` への向きだけで使います。MP3 はどこで区切ってもかまいません（worker は 1 発話を 1 つのデコーダで鳴らすので、継ぎ目は出ません）。

## 流れ ID

`open` の `id` が流れ ID で、ジョブの ID と Redis のキーにもなります。英数字・`-`・`_` の 1〜64 文字です（UUID がそのまま使えます）。同じ `--ingest` の中で、終わっていない ID を使い回すことはできません。

## 親 → aivis-mcp

### `open`

ジョブを即座に積みます（音声を待ちません）。worker が取り出したときに Stream が無いと捨てられるので、積む前に Stream を作ります。open のたびに worker が生きているか確かめ、いなければ（または古い版なら）起こします。

```json
{
  "type": "open",
  "id": "0f8fad5b-d9cb-469f-a165-70867728950e",
  "kind": "stream",
  "priority": "high",
  "gainKey": "elevenlabs:<voice_id>:eleven_v4_turbo",
  "volumeDb": -3.5,
  "tagged": false,
  "prelude": { "path": "/path/to/chime.wav", "volume": 0.6 }
}
```

| 項目 | 型 | 既定 | 意味 |
|---|---|---|---|
| `id` | 文字列 | 必須 | 流れ ID |
| `kind` | `"stream"` / `"sound"` | `"stream"` | `sound` は着信音だけの通知（声を読まない設定のとき）。音声の枠も `end` も送らない。`prelude` が必須 |
| `priority` | `"high"` / `"normal"` | `"normal"` | `high` は許可・質問など。worker は `high` の列を先に読む。鳴っている発話は切らない |
| `gainKey` | 文字列 | なし | 音量の表の鍵 `provider:voice:model`。ElevenLabs は `elevenlabs:<voice_id>:<model_id>`、Aivis は `aivis:<model_uuid>:default`。無ければ表の補正は 0dB |
| `volumeDb` | 数（-60〜20） | 0 | 親の音量の設定を dB に直した値。表の値に足す |
| `tagged` | 真偽 | `false` | 感情タグ入りなど、音量の覚え直しに使わない発話 |
| `prelude.path` | 文字列 | なし | 着信音のファイル（絶対パス）。`--prelude-dir` の中にあり、拡張子が `.wav` `.mp3` `.aiff` `.aif` `.m4a` `.caf` `.ogg` `.flac` の普通のファイル（10 MiB まで）だけ通す。シンボリックリンクは解いた実パスで確かめる |
| `prelude.volume` | 数（0〜1） | 1 | 着信音の音量。着信音には音量の表も頭打ちも当てない |

着信音は声の前に鳴ります（合成の最初の音を待つ間に鳴らします）。列に入ってから 5 秒以上待った着信音は飛ばし、声だけ読みます（hold の間は数えません）。`aivis-mcp --mute` の間は着信音も鳴らしません。

返事: `accepted` → `status`（`queued`）。着信音が通らなかったときは、着信音を付けずに積み、`accepted` に `preludeRejected` を付けます（`sound` は積まずに `failed`）。

### 音声の枠（型 `0x02`）

`open` した流れの MP3 です。流れ 1 本 8 MiB、この `--ingest` が書いていて終わっていない流れの合計 32 MiB を超えると、その流れを中断し `{"type":"status","id":…,"status":"failed","reason":"too-large"}` を返します。知らない ID には `{"type":"error","reason":"unknown-stream","id":…}` を返します。

### `end`

```json
{ "type": "end", "id": "…" }
```

流れの終わりです。届いた量が鳴らし始めの閾値（250ms ぶん）に届いていなくても、worker は鳴らします。

### `abort`

```json
{ "type": "abort", "id": "…", "reason": "ssh-closed" }
```

流れの中断です。鳴り始める前なら worker は捨て、まだ取り出されていなければ列からも外します（`status` は `skipped`、理由は `reason`）。鳴り始めた後なら、届いた分を鳴らし切って終えます。

### `hold`

```json
{ "type": "hold", "owner": "voice-input", "active": true }
```

音声入力中などに鳴らすのを止めます。`owner` は英数字と `_` `.` `:` `-` の 1〜64 文字です。`active: true` で `aivis-mcp:hold:<owner>` を 60 秒の期限で置き（延長も同じ送り方）、`active: false` で外します。親は 20 秒ごとに `active: true` を送り直してください。親が落ちても 60 秒で消えます。

hold が 1 つでもあると、worker は列から取り出さず、鳴っている発話は止めます（読み直しません。その発話の `status` は `held`）。待っている発話は残り、hold が外れたら順に鳴ります。hold の間はジョブの期限を数えません。`aivis-mcp` を起動し直したら、親は hold を掛け直してください。

返事: `{"type":"hold","owner":…,"active":…}`。

### `gain?`

```json
{ "type": "gain?", "requestId": "r1" }
```

音量の表を返します（返事は `gain`）。親は起動時と 10 分ごとに取り直して覚え、afplay で自分で鳴らすときやモバイルへ添える値に使います。

### `withdraw`

```json
{ "type": "withdraw", "id": "…" }
```

まだ worker が取り出していないジョブを列から外します（LREM）。返事は `{"type":"withdrawn","id":…,"removed":true|false}`。`removed` が `true` のときだけ、親はその件を自分で鳴らしてかまいません。

### `ping`

```json
{ "type": "ping", "requestId": 1 }
```

返事は `{"type":"pong","requestId":1}`。

## aivis-mcp → 親

| `type` | 中身 | いつ |
|---|---|---|
| `hello` | `{"protocol":1,"version":"2.5.0"}` | 最初の枠。`protocol` は取り決めの版、`version` は aivis-mcp の版。版が変わったら親は起動し直す |
| `accepted` | `{"id":…, "preludeRejected"?: 理由}` | `open` を受け付けた |
| `status` | `{"id":…, "status":…, "reason"?:…, "withdrawn"?: true}` | ジョブの進み具合（下の表） |
| `hold` | `{"owner":…, "active":…}` | `hold` を反映した |
| `gain` | `{"requestId":…, "target":-20, "maxBoostDb":8, "defaultDb":0, "entries":{鍵: dB}, "volumeOffsetDb":…, "elevenLabsVolumeOffsetDb":…}` | `gain?` の返事。`entries` に無い鍵は、同じ provider・同じモデルの平均、それも無ければ `defaultDb` |
| `withdrawn` | `{"id":…, "removed":…}` | `withdraw` の返事 |
| `pong` | `{"requestId":…}` | `ping` の返事 |
| `error` | `{"reason":…, …}` | 枠や要求が正しくない。`reason` は `protocol`（この後終わる）・`unknown-type`・`unknown-stream`・`invalid-owner`・`redis-unavailable` |

`status` の `status` は次の順に進みます。終わり（`done` `skipped` `held` `muted` `failed`）は 1 回だけ来ます。

| `status` | 意味 | 主な `reason` |
|---|---|---|
| `queued` | 列に積んだ。親はここで手を離してよい | |
| `playing` | worker が取り出して鳴らし始めた（着信音を含む） | |
| `done` | 鳴らし終えた | なし（最後まで）、`slow-arrival`（届くのが遅すぎて届いた分で終えた）、`aborted` などの中断の理由（鳴り始めた後の `abort`）、`empty` |
| `skipped` | 鳴らさなかった | `expired`（列で待ちすぎた。normal 120 秒・high 600 秒、hold の間は数えない）、`stream-missing`、`prelude-stale`（`sound` が 5 秒以上待った）、`withdrawn`、`abort` の理由 |
| `held` | hold で止めた（読み直さない） | |
| `muted` | `aivis-mcp --mute` の間だった | |
| `failed` | 鳴らせなかった | `first-audio-timeout`（取り出してから 10 秒、最初の音が来ない）、`max-duration`（1 発話 120 秒）、`slow-arrival`、`player-exited`、`too-large`、`worker-unavailable`（下記）、`redis-error`、`invalid-id`、`duplicate-id`、`prelude-required`・`prelude-<理由>`（`sound` の着信音が無い・通らない）、`internal-error` |

worker の lock が 30 秒続けて無いときは、まだ取り出されていないジョブを列から外し（LREM が 1 のときだけ）、`{"type":"status","status":"failed","reason":"worker-unavailable","withdrawn":true}` を返します。この知らせを受けた件だけ、親は自分で鳴らしてかまいません。

## 打ち切り

worker は 1 発話ごとに次で打ち切ります。列で待つ時間は数えません。

- 取り出してから 10 秒、最初の音が来ない
- 1 発話 120 秒
- 鳴り始めた後、届く速さ（最初の音から今までに届いた音声の長さ ÷ 経過時間）が実時間の半分を 3 秒続けて下回る（届いた分は鳴らし切る）

## Redis のキー（参考）

| キー | 中身 |
|---|---|
| `aivis-mcp:q2:high` / `aivis-mcp:q2:normal` | 2.5 の列（LPUSH で積み、worker が BRPOP で high から取り出す） |
| `aivis-mcp:queue` | 2.4 までの列（2.5 の worker も読む） |
| `aivis-mcp:audio:<id>` | 音声の Stream。項目 `o`（開いた印）・`d`（MP3）・`e`（終わり）・`a`（中断、値は理由）。期限 180 秒（`--ingest` が 30 秒ごとに延長） |
| `aivis-mcp:status:<id>` | 進み具合のリスト（期限 300 秒） |
| `aivis-mcp:hold:<owner>` | hold（期限 60 秒）。置いた・外したときは `aivis-mcp:hold-events` に publish |
| `aivis-mcp:worker-lock` / `aivis-mcp:worker-version` | worker の lock と版 |
| `aivis-mcp:play-lock` | 再生の lock（鳴らしている間 30 秒ごとに延長） |
