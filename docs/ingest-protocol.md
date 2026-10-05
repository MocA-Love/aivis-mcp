# `aivis-mcp --ingest` の取り決め（取り決めの版 1）

`aivis-mcp --ingest` は、Para Code などの親プロセスが起動する常駐の子です。親が合成した声（MP3）を標準入力で受け取り、Redis Stream `aivis-mcp:audio:<id>` に流し込んで、手元の worker の列に積みます。鳴らすのは worker だけで、親は `queued` を受け取った時点で手を離せます。

親が自分で（afplay などで）鳴らしてよいのは、`withdrawn: true` の付いた `status`（`failed`）か、`withdraw` の返事の `removed: true` を受け取った件だけです。それ以外の `failed` は、worker が鳴らしたかもしれない・これから鳴らすかもしれない件です（下の「親が自分で鳴らしてよいとき」）。

```bash
aivis-mcp --ingest --prelude-dir <着信音のフォルダ> [--prelude-dir <別のフォルダ> ...]
```

- `--prelude-dir` は着信音（prelude）として鳴らしてよいフォルダです。複数指定できます。ここに無いファイルは着信音として使いません
- 接続先の Redis は、ほかの起動方法と同じく `--redis-url` / `REDIS_URL` / `config.json` / `redis://127.0.0.1:6379` の順で決まります
- 標準出力は枠（下記）だけに使います。ログは標準エラーにだけ出ます
- 親が標準入力を閉じる・標準出力が書けなくなる（EPIPE）・SIGTERM / SIGINT / SIGHUP を受けると、書きかけの流れを中断し、この子が置いた hold を外して終わります（終了コード 0）
- Redis に接続できないとき（redis-server も無いとき）は `hello` と `{"type":"error","reason":"redis-unavailable"}` を出して終了コード 1 で終わります
- 動き出した後に Redis が止まっても、コマンドを溜めずにすぐ失敗させます。1 つの操作を待つのは最大 5 秒です。流れの途中で音声の書き込みに失敗したら、途中が抜けた音声を鳴らさないよう、その流れを中断して `failed` / `redis-error` で終えます（音量の覚え直しにも使いません）
- `hold`・`gain?`・`ping` は、Redis への音声の書き込みが詰まっていても、その後ろに並ばずに処理します。`end`・`abort` も書き込みの完了を待たずに次の枠へ進みます
- 処理待ちの枠と、Redis へまだ書いていない音声が、合わせて 256 個か 4 MiB を超えると標準入力を読むのを止め、半分まで減ったら再開します（Redis への書き込みが 1 件終わるたびに確かめます）。止めたまま 10 秒進まないときは読むのを再開します。親は標準入力への書き込みで drain を待ってください
- `aivis-mcp --reboot` はこの子を止めません

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
| `priority` | `"high"` / `"normal"` | `"normal"` | `high` は許可・質問など。worker は `high` の列を先に読む。鳴っている発話は切らない。`normal` が再生 lock を待つ間に `high` が来たら、まだ鳴らし始めていない `normal` は列へ戻して `high` を先に鳴らす |
| `gainKey` | 文字列 | なし | 音量の表の鍵 `provider:voice:model`。ElevenLabs は `elevenlabs:<voice_id>:<model_id>`、Aivis は `aivis:<model_uuid>:default`。無ければ表の補正は 0dB |
| `volumeDb` | 数（-60〜20） | 0 | 親の音量の設定を dB に直した値。表の値に足す |
| `tagged` | 真偽 | `false` | 感情タグ入りなど、音量の覚え直しに使わない発話 |
| `prelude.path` | 文字列 | なし | 着信音のファイル（絶対パス）。`--prelude-dir` の中にあり、拡張子が `.wav` `.mp3` `.aiff` `.aif` `.m4a` `.caf` `.ogg` `.flac` の普通のファイル（10 MiB まで）だけ通す。シンボリックリンクは解いた実パスで確かめる |
| `prelude.volume` | 数（0〜1） | 1 | 着信音の音量。着信音には音量の表も頭打ちも当てない |

着信音は声の前に鳴ります（合成の最初の音を待つ間に鳴らします）。列に入ってから 5 秒以上待った着信音は飛ばし、声だけ読みます（hold の間は数えません）。`aivis-mcp --mute` の間は着信音も鳴らしません。

返事: `accepted` → `status`（`queued`）。着信音が通らなかったときは、着信音を付けずに積み、`accepted` に `preludeRejected` を付けます（`sound` は積まずに `failed`・`withdrawn: true`）。

列に積むのと最初の知らせ（`queued`）は Redis へ 1 回（MULTI）で送ります。その応答が失われたとき（Redis が応答しない・接続が切れた）は、積めたかどうかを ID で確かめます。

- 積めていた: `queued` を返します
- 積めていなかった（確かめられた）: `{"type":"status","status":"failed","reason":"redis-error","withdrawn":true}` を返します。親は自分で鳴らしてかまいません
- 確かめられない: `queued` も `failed` も返さずに追い続け、Redis が戻ったら確かめ直して上のどちらかを返します。その間に `withdraw` を送ることもできます。15 分（hold の間は数えない）確かめられなければ `untracked` です
- 確かめられない間にその件が終わったとき（`too-large`・書き込みの失敗・`untracked`）は、aivis-mcp が列から外せた（LREM が 1）ときだけ `withdrawn: true` を付けます。外せなかった・確かめられなかったときは `withdrawn` の無い `failed` を返します。この件は列に残っていて後で worker が鳴らすかもしれないので、親は自分で鳴らす前に `withdraw` を送り、`removed: true` を受け取ってから鳴らしてください

### 音声の枠（型 `0x02`）

`open` した流れの MP3 です。流れ 1 本 8 MiB、この `--ingest` が積んでまだ終わりの知らせを返していない流れの合計 32 MiB を超えると、その流れを中断し `{"type":"status","id":…,"status":"failed","reason":"too-large"}` を返します（これがその件の終わりの知らせで、後から別の終わりは来ません。まだ取り出されていなかったので列から外せたときは `withdrawn: true` を付けます）。合計には `end` を送った流れも、鳴り終わる・取り下げる・終わりの知らせを返すまで数えます（その間 Redis に残っているため）。知らない ID には `{"type":"error","reason":"unknown-stream","id":…}` を返します。

終わりの知らせを返した件に後から届いた音声の枠・`end`・`abort` は、黙って捨てます（5 分間覚えています）。終わった件の Stream は、後から届いた断片で作り直さないよう `aivis-mcp` が消します。

### `end`

```json
{ "type": "end", "id": "…" }
```

流れの終わりです。届いた量が鳴らし始めの閾値（250ms ぶん）に届いていなくても、worker は鳴らします。書き残しを Redis へ送り終えるのを 10 秒待っても終わらないときは、以後の書き込みを捨て、その件を `failed` / `redis-error` で終えます。

### `abort`

```json
{ "type": "abort", "id": "…", "reason": "ssh-closed" }
```

流れの中断です。`end` を送った後でも効きます。鳴り始める前なら worker は捨て、まだ取り出されていなければ列からも外します（`status` は `skipped`、理由は `reason`）。鳴り始めた後なら、届いた分を鳴らし切って終えます。

`end` の前の `abort` は入力の終わり（Stream の項目 `a`）として、`end` の後の `abort` は「鳴らすのをやめる」印（項目 `c`）として書きます。worker は鳴らし始めるまで Stream を読み続け、どちらの印でも鳴らさずに捨てます。

### `hold`

```json
{ "type": "hold", "owner": "voice-input", "active": true }
```

音声入力中などに鳴らすのを止めます。`owner` は英数字と `_` `.` `:` `-` の 1〜64 文字です。`active: true` で `aivis-mcp:hold:<owner>` を 60 秒の期限で置き（延長も同じ送り方）、`active: false` で外します。親は 20 秒ごとに `active: true` を送り直してください。親が落ちても 60 秒で消えます。

hold が 1 つでもあると、worker は列から取り出さず、鳴っている発話は止めます（読み直さない。その発話の `status` は `held`）。待っている発話は残り、hold が外れたら順に鳴ります。hold の間はジョブの期限を数えません。hold の始まりは Redis（`aivis-mcp:hold-since`）に残すので、hold の途中で worker が入れ替わっても、待った時間から hold の分を除けます。`aivis-mcp` を起動し直したら、親は hold を掛け直してください。

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

まだ worker が取り出していないジョブを列から外します。返事は `withdrawn` で、外せなかったときは理由を付けます。

| 返事 | 意味 | 親が自分で鳴らしてよいか |
|---|---|---|
| `{"type":"withdrawn","id":…,"removed":true}` | 列から外した | よい |
| `{"type":"withdrawn","id":…,"removed":false,"notQueued":true}` | 列にも知らせ（`aivis-mcp:status:<id>`）にも取り出した印（`aivis-mcp:taken:<id>`）にも痕跡が無い。積む要求が Redis に届いていない。残っていた Stream は消した | よい |
| `{"type":"withdrawn","id":…,"removed":false,"taken":true}` | 列に無く、知らせか取り出した印がある。worker が取り出した・鳴っている・終わった | よくない（worker が鳴らす・鳴らした） |
| `{"type":"withdrawn","id":…,"removed":false}` | Redis に確かめられなかった | よくない |

- 判定（列から外す・Stream と知らせを消す・痕跡を調べる）は 1 つのスクリプトで行います。worker の取り出し・列へ戻すのと入れ違いません。同じ子が先に送った `open` の積む要求は、判定より先に Redis に届いています
- この子が積んだジョブだけでなく、前の `--ingest`（落ちて起動し直す前の子）が積んだジョブも、`aivis-mcp:q2:high` と `aivis-mcp:q2:normal` を読んで ID が一致する要素を探し、その要素だけを外します。ほかのジョブは巻き込みません
- 外せた件・積まれていなかった件には、以後 `status` を返しません。worker が一度取り出してから列へ戻した件（hold・優先の入れ替えなど）は、列にあるので外せます
- 知らせは期限 300 秒です。worker は取り出したときに、知らせとは別に取り出した印 `aivis-mcp:taken:<id>`（期限 30 分）を残し、知らせが切れた後でも取り出した件には `taken` と答えます。終わってから 30 分以上経った件は `notQueued` になります。親は終わりの知らせを受けた件に withdraw を送らないでください
- 落ちた子（前の `--ingest`）が積んだ件の withdraw は、子が落ちてから 5 分以内に送ってください。落ちた子はもう知らせと Stream の期限を延ばさないので、まだ取り出されていない件の知らせは 5 分で切れ、Stream も 180 秒で切れます（worker は Stream の無い件を `stream-missing` で捨てます）

### `adopt`

```json
{ "type": "adopt", "id": "…" }
```

前の `--ingest`（落ちた・入れ替えた子）が積んだ件の追跡を、この子が引き継ぎます。返事は `{"type":"adopted","id":…,"adopted":true|false}` です。

- 列か知らせに痕跡がある件だけ引き継ぎます（`adopted: true`）。どちらにも無い ID は `adopted: false` です。この子がすでに追っている件は `adopted: true` のままです
- 引き継いだ件は、この子が Stream と知らせの期限を延ばし、知らせを頭から読み直して `playing` と終わり（`done` `skipped` `held` `muted` `failed`）を返します。`queued` は返しません。見失った・追跡の上限の判断もこの子が行います
- 音声の続き（音声の枠・`end`）は送れません。書きかけの流れは、worker が届いた分で終えるか打ち切ります。鳴らさずに済ませたいなら `withdraw` を送ってください
- `abort` と `withdraw` は、引き継いだ件にも使えます。引き継いだ件には書く側がいないので、`abort` を受けた子が Stream に鳴らすのをやめる印 `c` を直接書きます（Stream が残っているときだけ）。worker が取り出した後でも、鳴らし始める前なら捨てます（`skipped`）。まだ列にあれば列から外し、そのとき Stream も消します
- 追跡の上限（15 分、hold の間は数えない）は、最初の知らせの時刻から数えます。引き継ぐ前に掛かっていた hold の時間も、Redis の hold の記録（`aivis-mcp:hold-log` と `aivis-mcp:hold-since`）から読んで除きます

### `ping`

```json
{ "type": "ping", "requestId": 1 }
```

返事は `{"type":"pong","requestId":1}`。

## aivis-mcp → 親

| `type` | 中身 | いつ |
|---|---|---|
| `hello` | `{"protocol":1,"version":"2.5.1"}` | 最初の枠。`protocol` は取り決めの版、`version` は aivis-mcp の版。版が変わったら親は起動し直す |
| `accepted` | `{"id":…, "preludeRejected"?: 理由}` | `open` を受け付けた |
| `status` | `{"id":…, "status":…, "reason"?:…, "withdrawn"?: true}` | ジョブの進み具合（下の表） |
| `hold` | `{"owner":…, "active":…}` | `hold` を反映した |
| `gain` | `{"requestId":…, "target":-20, "maxBoostDb":8, "defaultDb":0, "entries":{鍵: dB}, "volumeOffsetDb":…, "elevenLabsVolumeOffsetDb":…}` | `gain?` の返事。`entries` に無い鍵は、同じ provider・同じモデルの平均、それも無ければ `defaultDb` |
| `withdrawn` | `{"id":…, "removed":…, "notQueued"?: true, "taken"?: true}` | `withdraw` の返事 |
| `adopted` | `{"id":…, "adopted":…}` | `adopt` の返事 |
| `pong` | `{"requestId":…}` | `ping` の返事 |
| `error` | `{"reason":…, …}` | 枠や要求が正しくない。`reason` は `protocol`（1 回だけ出し、以後の入力は捨てて終わる）・`unknown-type`・`unknown-stream`・`invalid-owner`・`redis-unavailable`・`redis-error`（`hold` を Redis に書けなかった） |

`status` の `status` は次の順に進みます。終わり（`done` `skipped` `held` `muted` `failed`）は 1 回だけ来ます。

| `status` | 意味 | 主な `reason` |
|---|---|---|
| `queued` | 列に積んだ（積めたと確かめた）。親はここで手を離してよい | |
| `playing` | worker が取り出して鳴らし始めた（着信音を含む） | |
| `done` | 鳴らし終えた | なし（最後まで）、`slow-arrival`（届くのが遅すぎて届いた分で終えた）、`aborted` などの中断の理由（鳴り始めた後の `abort`）、`empty` |
| `skipped` | 鳴らさなかった | `expired`（列で待ちすぎた。normal 120 秒・high 600 秒、hold の間は数えない）、`stream-missing`、`prelude-stale`（`sound` が 5 秒以上待った）、`abort` の理由 |
| `held` | hold で止めた（読み直さない） | |
| `muted` | `aivis-mcp --mute` の間だった（鳴らす直前にも確かめる） | |
| `failed` | 鳴らせなかった | `first-audio-timeout`（取り出してから 10 秒、最初の音が来ない）、`max-duration`（1 件 120 秒。`sound` も同じ）、`slow-arrival`、`player-exited`（プレイヤーが 0 以外で終わった・先に落ちた）、`player-spawn-failed`（プレイヤーを起動できない）、`no-player`（鳴らすプレイヤーが無い。声でも）、`too-large`、`worker-unavailable`（下記）、`worker-stopped`（鳴らしている途中で worker が止められた）、`play-lock-lost`（再生 lock をほかに取られた・延長できないまま期限が近づいたので止めた）、`lost`（下記）、`untracked`（下記）、`prelude-required`・`prelude-<理由>`（`sound` の着信音が無い・許可フォルダの外など）、`redis-error`、`invalid-id`、`duplicate-id`、`internal-error` |

### 親が自分で鳴らしてよいとき

`withdrawn: true` は「この件は列に無く、worker は鳴らさない」と aivis-mcp が確かめた印です。親が自分で鳴らしてよいのは次の件だけです。

| 知らせ | いつ |
|---|---|
| `withdraw` の返事の `removed: true` | 列から外せた |
| `withdraw` の返事の `notQueued: true` | 積む要求が Redis に届いていなかった |
| `failed`・`worker-unavailable`・`withdrawn: true` | worker の lock が 30 秒続けて無く、列から外せた（LREM が 1） |
| `failed`・`redis-error`・`withdrawn: true` | 積めていないと確かめた（Stream を作れなかった・積む要求が通っていなかった）。または流れの途中で書き込みに失敗し、まだ取り出されていなかったので列から外せた |
| `failed`・`too-large`・`withdrawn: true` | 大きすぎて中断し、まだ取り出されていなかったので列から外せた |
| `failed`・`invalid-id`／`prelude-*`・`withdrawn: true` | 積まなかった |

`withdrawn` の無い `failed`（`redis-error` を含む）は、worker が取り出していて、鳴らしたかもしれない件です。親は自分で鳴らし直さず、`failed` が続いたら次の件から自分で鳴らす判断（設計 N2）に使ってください。`--ingest` が落ちた・応答しないときも、`queued` を受け取っていない件が積めていないとは限りません。起動し直した `--ingest` に `withdraw` を送り、`removed: true` だった件だけを鳴らしてください。

次の件は、worker が落ちたなどで知らせが来ないものとして `failed` を返します。これらは鳴らし直していない（取り下げていない）ので、親は自分で鳴らし直しません。

| `reason` | いつ |
|---|---|
| `lost` | worker が取り出した（内部の知らせ `dequeued`）後か `playing` の後に、worker の lock が 30 秒無い。取り出した worker から lock がほかの worker に移り、取り出した worker が再生 lock も持たないまま 30 秒経つ。`playing` の後 180 秒終わりが来ない。`dequeued` も来ないまま列から消えて 30 秒経つ（再生 lock を worker 以外が持つ間は数えない）。`dequeued` から `playing` までの再生 lock の待ちは数えない。worker が列へ戻した（内部の知らせ `requeued`）件は、また列で待つ件として扱う。この件の Stream は消さず期限切れに任せる |
| `untracked` | `open` から 15 分（hold の間は数えない）経っても終わりが来ない（追うのをやめる）。まだ列にあれば外し、外せたときは `withdrawn: true` を付ける |

`withdraw` の返事で `removed: true` だった件には、`status` は返しません。

## 打ち切り

worker は 1 発話ごとに次で打ち切ります。列で待つ時間は数えません。

- 取り出してから 10 秒、最初の音が来ない
- 1 件 120 秒（声・着信音だけの `sound`・2.4 の形の音声を問わない実時間。止めても終わらないプレイヤーは 2 秒後に強制終了する）
- 鳴り始めた後、届く速さ（最初の音から今までに届いた音声の長さ ÷ 経過時間）が実時間の半分を 3 秒続けて下回る（届いた分は鳴らし切る）
- Redis から読んだ項目が 1 つで 1.0625 MiB、合計で 8 MiB を超えた（`too-large`）

worker は、どこで終えても（Redis の読み取りの失敗・中断を含む）、プレイヤーを止めて終わったのを確かめてから再生 lock を手放します。再生 lock は、最後に延長できた時刻から数えた期限の 3 秒前までに延長できなければ、Redis に届かなくても鳴らすのを止めます（ほかの worker が lock を取れるようになる前に止めるため）。

## Redis のキー（参考）

| キー | 中身 |
|---|---|
| `aivis-mcp:q2:high` / `aivis-mcp:q2:normal` | 2.5 の列（LPUSH で積み、worker が BRPOP で high から取り出す）。2.5.1 の `--play-audio` も `q2:normal` に積む |
| `aivis-mcp:q2:legacy` | 2.4 の worker から lock を引き取ったとき、古い列の中身を移す先（2.4 の worker は読まない） |
| `aivis-mcp:queue` | 2.4 までの列（2.5 の worker も読む） |
| `aivis-mcp:audio:<id>` | 音声の Stream。項目 `o`（開いた印）・`d`（MP3）・`e`（終わり）・`a`（中断、値は理由）・`c`（鳴らすのをやめる、値は理由。`e` の後にも書く）。期限 180 秒（`--ingest` が 30 秒ごとに延長） |
| `aivis-mcp:status:<id>` | 進み具合のリスト（期限 300 秒）。積む側が先頭に `queued`（列に積むのと同じ MULTI で）、worker が `dequeued`（内部用。取り出した worker の ID `w` を持つ）・`requeued`（内部用。列へ戻した）・`playing`・終わりを積む。`--ingest` が 30 秒ごとに延長し、先頭が `queued` でなくなっていたら（期限切れで作り直された）頭から読み直す |
| `aivis-mcp:prelude-dirs:<ingestId>` | `--ingest` が受けた着信音の許可フォルダ（SET、`--ingest` ごと、期限 90 秒・30 秒ごとに置き直す。起動時は `hello` の前に置く）。worker は全部の和集合で鳴らす前に確かめる |
| `aivis-mcp:hold:<owner>` | hold（期限 60 秒）。置いた・外したときは `aivis-mcp:hold-events` に publish |
| `aivis-mcp:hold-since` / `aivis-mcp:hold-log` | 続いている hold の始まりと、終わった hold の区間（ジョブの期限から hold の時間を除く） |
| `aivis-mcp:worker-lock` / `aivis-mcp:worker-version` | worker の lock と版 |
| `aivis-mcp:play-lock` | 再生の lock（期限 10 秒、鳴らしている間 3 秒ごとに延長。worker が止められたらすぐ消す） |
| `aivis-mcp:voice-ticket:req:<requester>` / `aivis-mcp:voice-ticket:res:<jobId>` | pub/sub のチャネル。worker が鳴らし始めるときに、積んだ MCP サーバーへ Para Code の ticket を頼む（下記）。Redis には残らない（控えの ticket はジョブの中に載る） |

## 接続先から Para Code への送り出し（参考）

SSH 先などの aivis-mcp が Para Code の `/paradis-mcp/mobile-voice` へ合成した声を送るときの決まりです。

### ヘッダー

- `X-Para-Gain-Key: <provider>:<voice>:<model>`: 値は音量の表の鍵と同じ形（Aivis は `aivis:<model_uuid>:default`、ElevenLabs は `elevenlabs:<voice_id>:<model_id>`）で、英数・`:`・`_`・`-`・`.` だけの 200 文字までのときだけ付けます（それ以外の文字を含む鍵は付けません）
- `X-Para-Tagged: 1`: 感情タグ（`[whispers]` など）入りの発話のときだけ付けます。音量の覚え直しに使わない印です
- `X-Para-Muted: 1`: この機械がミュート中で、ticket が `localPlayback: true` かつ `muteAware: true` のときだけ付けます（下の「ミュート中」）
- どちらも `stream-v1` の chunked 送信でも、旧方式（Content-Length 付き）でも付けます
- `Authorization: Bearer <ticket>` の ticket は、ヘッダーに書ける文字（英数と `.` `_` `~` `+` `/` `=` `-`、200 文字まで）のときだけ使います。それ以外の ticket は無いものとして扱います

### 鳴らし方の判定（`stream-v1`）

| Para Code の応答 | 接続先の扱い |
|---|---|
| ヘッダー `X-Para-Local-Playback: accepted` | 引き受けた。接続先では鳴らさない |
| 401・403 | ticket が通らなかった（期限切れ・使用済み）。手元で鳴らす前提の発話は接続先で鳴らさず `failed`（`ticket-unavailable`） |
| 404（ticket に `localPlayback: true` があるときだけ） | 401・403 と同じく ticket が通らなかったとみなし、接続先で鳴らさない。今の Para Code は通らない ticket に 404 を返すため（次の版から 401）。`localPlayback` の無い ticket の 404 は、下の「ほかの 4xx」として扱う |
| ほかの 4xx・5xx、またはヘッダー `X-Para-Local-Playback: rejected` | 明示の拒否。接続先で鳴らす |
| 2xx で上のどちらのヘッダーも無い（不明） | 本文の `localPlayback` で決める。`false` なら接続先で鳴らし、`true` か本文が読めなければ鳴らさない |
| 応答のヘッダーが 1 つも来ないまま接続に失敗した | 接続先で鳴らす |
| 引き受けの後、本文が `{"localPlayback":false}` | 接続先で鳴らす（届けた音声を Stream から、収まらなかったときは合成し直して） |
| 引き受けの後、応答が途中で切れた・止まった | Para Code に任せる（鳴らさない） |

Para Code は、本文を受け取り終えたら、手元で鳴らせたかを本文 `{"localPlayback":true|false}` で返してください（引き受けのヘッダーを返した後でも）。接続先は、合成を送り終えた後、`FORWARD_IDLE_TIMEOUT_MS`（30 秒）を超えて本文を待ちません。1 回の送り出しは全体で 150 秒（1 発話の上限 120 秒＋30 秒）までです。

### ticket を取る時（Q208 A）

- MCP サーバー（ペインごとに常駐する）から積んだ発話は、worker が鳴らし始める（転送を始める）時に ticket を頼みます。worker は `aivis-mcp:voice-ticket:req:<requester>` に `{"id":<jobId>}` を publish し、MCP サーバーが `aivis-mcp:voice-ticket:res:<jobId>` に返します。worker が待つのは、手元のペインで 1.5 秒、SSH 先のペイン（ジョブの `_voiceRequester.remote`）で 3.5 秒です（MCP サーバーが戻り経路越しに health と ticket を取る分）。MCP サーバーは戻り経路の先の instanceId を覚え、2 回目からは health を取りません
- MCP サーバーは積む時にも 1 枚取り、控えとしてジョブ（`_paraCodeVoiceTarget`）に載せます。MCP サーバーが先に終わっても鳴らせるようにするためです。頼まれたときは、その控えがまだ 60 秒以上使えればそれを返し、新しくは取りません（使われない ticket でペインごとの上限を埋めないため）。60 秒を切っていれば新しく取ります
- worker は、返事が無い（購読している MCP サーバーがいない・時間切れ）・取れなかったときは、控えの残りが 15 秒以上あればそれを使います
- 時間切れの直後（0.5 秒以内）に届いた返事の ticket は、worker が取り置き、同じ MCP サーバーの次の発話で頼まずに使います
- MCP サーバーは覚えた instanceId で ticket を取れなかったら（Para Code が起動し直したなど）、その依頼は諦めて覚えた値を捨て、次の依頼で health から取り直します（1 回の依頼が health と ticket の両方で最大 4.5 秒かからないように）
- 返事が worker に届かなかった新しい ticket（時間切れの後に取れた）は捨てず、MCP サーバーが次の依頼か次の控えに回します
- MCP サーバーは終わるとき、答えている途中の依頼に最大 2 秒答えてから終わります
- ペインのトークンは Redis に出しません。Redis に載るのは 1 回限り・10 分の ticket（控え）だけです。pub/sub の返事は Redis に残りません
- 依頼の中身はジョブ ID だけで、Redis に触れる誰でも publish できます。MCP サーバーは自分が積んだ ID にだけ 1 回答えるので、偽の依頼で得られるのはその件のための ticket 1 枚（控えと同じもの、または新しい 1 枚）です。同じ Redis を他人と共有していれば、返事のチャネルを購読して ticket を読めます（列の中の控えも同じく読めます。2.5.0 までと同じ前提で、別件として記録します）
- 一回きりの `aivis` コマンドと `aivis-mcp "<文>"` は常駐しないので、積む時に取った ticket だけを使います
- ticket が控えも含めて取れなかったとき、SSH 先のペイン（ポートファイルに `pid` と `instanceId` が無い）で Para Code が手元の PC で鳴らす前提の発話は、接続先では鳴らさずに `failed`（`ticket-unavailable`）で終えます。手元のペインの発話は、送らずに手元で鳴らします
- Para Code 側の ticket の発行・取込口は変わりません

### ミュート中（Q209 B）

`aivis --mute` の間も、Para Code から起動されたエージェントの声は合成して Para Code へ送ります（モバイルへ届けるため）。この機械のスピーカーでは鳴らしません。

- ticket が `localPlayback: true`（Para Code が手元の PC で鳴らす）のときは、ticket に `muteAware: true` があるときだけ送り、ヘッダー `X-Para-Muted: 1` を付けます。Para Code はこのヘッダーを受けたら手元では鳴らさず、モバイルへだけ流してください。`muteAware` が無い（古い Para Code）ときは、手元で鳴ってしまうので送らずに `muted` で終えます
- `localPlayback` の無い ticket（手元のペイン、モバイルへの転送だけ）は、ヘッダーを付けずに送ります
- 控えの ticket で送らないと分かる件（`localPlayback: true` で `muteAware` が無い）は、MCP サーバーに ticket を頼みません
- Para Code へ送れないとき（ticket が取れない）は、合成もしません

### hold と送り出し

`stream-v1` の chunked 送信は、hold・中断・打ち切りで途中で止めます。旧方式（Content-Length 付き、`stream-v1` の無い Para Code）は、合成を受け取り終えてから 1 回で送るので、送り始めた後は hold で取り消せません（受け取る途中なら止めます）。

### `sync: true` と SSH 先

MCP の `aivis-speech` の `sync: true` は、この機械の worker がその件を終えたときに返ります。SSH 先で Para Code が引き受けた発話は、Para Code が本文の返事を返した時点で返り、手元の PC で鳴り終わるのは待ちません。

## 移行中の制約

- 2.4 までの `aivis` CLI・MCP は、古い列 `aivis-mcp:queue` に RPUSH で積みます。worker は BRPOP で右から取り出すので、2.4 から積まれた発話同士は後から積んだものが先に鳴ることがあります（2.5 から積む分は LPUSH なので積んだ順）。古い列は 2.5 の列（high → normal）より後に読みます。すべて 2.5 に更新すると解消します
- 2.5.1 の `--play-audio` は、動いている worker が 2.5 以上なら `q2:normal` に積みます（hold と優先の順が効きます）。`--gain-key <provider:voice:model>` を付けると、その鍵で音量の表を当てます。worker が 2.4 なら古い列に積みます
- `aivis-mcp:q2:legacy` は 2.5.1 から読む列です。2.5.1 から 2.5.0 以前へ戻すと、この列に残った発話は読まれません。戻すときは、先に `aivis-mcp --restore-legacy-queue` で古い列へ戻してください（`--reboot` は Redis のキーを消すので、残った発話も消えます）
- 2.4 の worker から lock を引き取ったとき、新しい worker は古い列の中身を `aivis-mcp:q2:legacy` へ移し、2.4 の worker が気付いて止まるまで（8 秒、2.4 の worker が再生 lock を持つ間は延ばす）古い列からは読まずに移し続けます。引き取る前に 2.4 の worker が取り出していた件は、2.4 の worker が鳴らします（再生 lock で重なりません）
