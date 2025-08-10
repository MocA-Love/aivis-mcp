import axios from 'axios';
import fs from 'fs';
import path from 'path';
import wavPlayer from 'node-wav-player';
import { AivisSpeechService } from '../../services/aivis-speech-service';
import { Speaker, SynthesisRequest } from '../../types/aivis-speech';

// モジュールのモック
jest.mock('axios');
jest.mock('fs');
jest.mock('path');
jest.mock('node-wav-player');
jest.mock('dotenv', () => ({
  config: jest.fn()
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedFs = fs as jest.Mocked<typeof fs>;
const mockedPath = path as jest.Mocked<typeof path>;
const mockedWavPlayer = wavPlayer as jest.Mocked<typeof wavPlayer>;

describe('AivisSpeechService', () => {
  let service: AivisSpeechService;

  // テスト用のモックデータ
  const mockSpeakers: Speaker[] = [
    {
      name: 'テストスピーカー1',
      speaker_id: 1,
      styles: [
        { name: 'スタイル1', id: 1 },
        { name: 'スタイル2', id: 2 },
      ],
      version: '1.0.0',
    },
    {
      name: 'テストスピーカー2',
      speaker_id: 2,
      styles: [
        { name: 'スタイル3', id: 3 },
      ],
      version: '1.0.0',
    },
  ];

  const mockAudioQuery = {
    text: 'こんにちは',
    style_id: 1,
    speed_scale: 1.0,
    pitch_scale: 1.0,
    intonation_scale: 1.0,
    volume_scale: 1.0,
    pre_phoneme_length: 0.1,
    post_phoneme_length: 0.1,
    output_sampling_rate: 24000
  };

  const mockAudioBuffer = Buffer.from('dummy audio data');

  beforeEach(() => {
    // テスト前にモックをリセット
    jest.clearAllMocks();

    // モックの設定
    mockedPath.join.mockImplementation((...args) => args.join('/'));
    mockedFs.existsSync.mockReturnValue(true);
    mockedWavPlayer.play.mockResolvedValue(undefined);

    // サービスのインスタンスを作成
    service = new AivisSpeechService();
  });

  describe('getSpeakers', () => {
    it('スピーカー一覧を取得できること', async () => {
      // モックの設定
      mockedAxios.get.mockResolvedValueOnce({ data: mockSpeakers });

      // テスト対象の関数を実行
      const result = await service.getSpeakers();

      // 結果の検証
      expect(result).toEqual(mockSpeakers);
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
      expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringContaining('/speakers'));
    });

    it('APIエラー時に例外をスローすること', async () => {
      // モックの設定
      mockedAxios.get.mockRejectedValueOnce(new Error('API error'));

      // テスト対象の関数を実行して例外をキャッチ
      await expect(service.getSpeakers()).rejects.toThrow('スピーカー一覧の取得に失敗しました');

      // 呼び出しの検証
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('synthesize', () => {
    it('音声合成を実行できること', async () => {
      // モックの設定
      mockedAxios.post.mockResolvedValueOnce({ data: mockAudioQuery }); // audio_queryのレスポンス
      mockedAxios.post.mockResolvedValueOnce({ data: mockAudioBuffer }); // synthesisのレスポンス

      // テスト用のリクエスト
      const request: SynthesisRequest = {
        text: 'こんにちは',
        speaker: 1,
        style_id: 1,
      };

      // テスト対象の関数を実行
      const result = await service.synthesize(request);

      // 結果の検証
      expect(result).toHaveProperty('audioData');
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);

      // audio_queryの呼び出しを検証
      expect(mockedAxios.post.mock.calls[0][0]).toContain('/audio_query');

      // synthesisの呼び出しを検証
      expect(mockedAxios.post.mock.calls[1][0]).toContain('/synthesis');

      // 一時ファイルの作成と再生を検証
      expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(1);
      expect(mockedWavPlayer.play).toHaveBeenCalledTimes(1);
    });

    it('APIエラー時に例外をスローすること', async () => {
      // モックの設定
      mockedAxios.post.mockRejectedValueOnce(new Error('API error'));

      // テスト用のリクエスト
      const request: SynthesisRequest = {
        text: 'こんにちは',
        speaker: 1,
      };

      // テスト対象の関数を実行して例外をキャッチ
      await expect(service.synthesize(request)).rejects.toThrow('音声合成に失敗しました');
    });
  });
});
