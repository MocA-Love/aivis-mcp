# Changelog

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
