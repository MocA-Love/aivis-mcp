import fs from 'fs';
import os from 'os';
import path from 'path';

/** テストが tmpdir に書いた声の行き先のログ（test/helpers/env.ts）を消す。 */
export default async function teardown() {
  const dir = os.tmpdir();
  for (const name of fs.readdirSync(dir)) {
    if (/^aivis-mcp-test-route-\d+\.log(\.1)?$/.test(name)) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  }
}
