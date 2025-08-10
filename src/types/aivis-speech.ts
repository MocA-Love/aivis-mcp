/**
 * AivisSpeech APIの型定義
 */

// スピーカー情報の型定義
export interface Speaker {
  name: string;
  speaker_id: number;
  styles: Style[];
  version: string;
}

// スタイル情報の型定義
export interface Style {
  name: string;
  id: number;
}

/**
 * 音声合成リクエスト
 */
export interface SynthesisRequest {
  /**
   * 合成するテキスト
   */
  text: string;

  /**
   * 話者ID
   */
  speaker: number;

  /**
   * スタイルID
   */
  style_id?: number;

  /**
   * 話速のスケール（1.0が標準）
   */
  speed_scale?: number;

  /**
   * 音高のスケール（1.0が標準）
   */
  pitch_scale?: number;

  /**
   * イントネーションのスケール（1.0が標準）
   */
  intonation_scale?: number;

  /**
   * 音量のスケール（1.0が標準）
   */
  volume_scale?: number;

  /**
   * 音声の先頭の無音時間（秒）
   */
  pre_phoneme_length?: number;

  /**
   * 音声の末尾の無音時間（秒）
   */
  post_phoneme_length?: number;

  /**
   * 出力音声のサンプリングレート（Hz）
   */
  output_sampling_rate?: number;
}

/**
 * 音声合成レスポンス
 */
export interface SynthesisResponse {
  /**
   * 音声データ
   */
  audioData?: ArrayBuffer;

  /**
   * Base64エンコードされた音声データ（テスト用）
   */
  audio?: string;

  /**
   * サンプリングレート
   */
  sampling_rate?: number;
}

// AudioQuery
export interface AudioQuery {
  /**
   * 合成するテキスト
   */
  text: string;

  /**
   * スタイルID
   */
  style_id: number;

  /**
   * 話速のスケール（1.0が標準）
   */
  speed_scale: number;

  /**
   * 音高のスケール（1.0が標準）
   */
  pitch_scale: number;

  /**
   * イントネーションのスケール（1.0が標準）
   */
  intonation_scale: number;

  /**
   * 音量のスケール（1.0が標準）
   */
  volume_scale: number;

  /**
   * 音声の先頭の無音時間（秒）
   */
  pre_phoneme_length: number;

  /**
   * 音声の末尾の無音時間（秒）
   */
  post_phoneme_length: number;

  /**
   * 出力音声のサンプリングレート（Hz）
   */
  output_sampling_rate: number;

  /**
   * その他のパラメータ
   */
  [key: string]: any;
}

// AivisSpeech APIのエンドポイント
export enum AivisSpeechEndpoint {
  SPEAKERS = '/speakers',
  SYNTHESIS = '/synthesis',
  AUDIO_QUERY = '/audio_query',
}
