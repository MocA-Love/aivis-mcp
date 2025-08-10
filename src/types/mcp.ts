/**
 * MCP関連の型定義
 */

// MCPリクエストの型定義
export interface MCPRequest {
  model: string;
  parameters: Record<string, any>;
}

// MCP音声合成リクエストの型定義
export interface MCPSynthesisRequest extends MCPRequest {
  parameters: {
    text: string;
    speaker_id: number;
    style_id?: number;
    speed_scale?: number;
    pitch_scale?: number;
    intonation_scale?: number;
    volume_scale?: number;
    pre_phoneme_length?: number;
    post_phoneme_length?: number;
    output_sampling_rate?: number;
  };
}
