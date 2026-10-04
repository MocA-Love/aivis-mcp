import os from 'os';
import path from 'path';

// 手元の ~/.config/aivis-mcp/gain.json を読み書きしない
process.env.AIVIS_GAIN_FILE = path.join(os.tmpdir(), `aivis-mcp-test-gain-${process.pid}-does-not-exist.json`);
