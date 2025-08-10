import { MCPService } from '../../services/mcp-service';

// MCPサーバーのモック
jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  const mockTool = jest.fn();
  const mockConnect = jest.fn().mockResolvedValue(undefined);

  return {
    McpServer: jest.fn().mockImplementation(() => {
      return {
        tool: mockTool,
        connect: mockConnect
      };
    })
  };
});

// StdioServerTransportのモック
jest.mock('@modelcontextprotocol/sdk/server/stdio.js', () => {
  return {
    StdioServerTransport: jest.fn().mockImplementation(() => {
      return {};
    })
  };
});

// AivisSpeechサービスのモック
jest.mock('../../services/aivis-speech-service', () => {
  return {
    __esModule: true,
    default: {
      synthesize: jest.fn().mockResolvedValue({
        audioData: Buffer.from('dummy audio data')
      })
    }
  };
});

// dotenvのモック
jest.mock('dotenv', () => ({
  config: jest.fn()
}));

describe('MCPService', () => {
  beforeEach(() => {
    // テスト前にモックをリセット
    jest.clearAllMocks();
  });

  it('MCPサーバーを初期化すること', () => {
    // サービスのインスタンスを作成
    const service = new MCPService();

    // McpServerが呼び出されたことを確認
    expect(require('@modelcontextprotocol/sdk/server/mcp.js').McpServer).toHaveBeenCalled();
  });

  it('MCPサーバーを起動できること', async () => {
    // サービスのインスタンスを作成
    const service = new MCPService();

    // サービスを起動
    await service.start();

    // StdioServerTransportが作成されたことを確認
    expect(require('@modelcontextprotocol/sdk/server/stdio.js').StdioServerTransport).toHaveBeenCalled();
  });
});
