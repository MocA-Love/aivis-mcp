import os from 'os';
import path from 'path';

// 手元の ~/.config/aivis-mcp/gain.json を読み書きしない
process.env.AIVIS_GAIN_FILE = path.join(os.tmpdir(), `aivis-mcp-test-gain-${process.pid}-does-not-exist.json`);
// 手元の ~/.config/aivis-mcp/config.json も読み書きしない
process.env.AIVIS_CONFIG_FILE = path.join(os.tmpdir(), `aivis-mcp-test-config-${process.pid}-does-not-exist.json`);
// 声の行き先のログも手元の ~/.config/aivis-mcp/logs へ書かない
process.env.AIVIS_ROUTE_LOG_FILE = path.join(os.tmpdir(), `aivis-mcp-test-route-${process.pid}.log`);
