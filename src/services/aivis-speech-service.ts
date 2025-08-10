import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { platform } from 'os';
import dotenv from 'dotenv';

// .envファイルを絶対パスで読み込む
const envPath = path.join(__dirname, '../../.env');
dotenv.config({ path: envPath });

/**
 * Aivis Cloud APIとの通信を行うサービスクラス
 */
export class AivisSpeechService {
  private baseUrl: string;
  private apiKey: string;
  private defaultModelUuid: string;
  private defaultOutputFormat: string;

  /**
   * コンストラクタ
   */
  constructor() {
    this.baseUrl = process.env.AIVIS_API_URL || 'https://api.aivis-project.com/v1';
    this.apiKey = process.env.AIVIS_API_KEY || '';
    this.defaultModelUuid = process.env.AIVIS_MODEL_UUID || 'a59cb814-0083-4369-8542-f51a29e72af7';
    this.defaultOutputFormat = 'mp3'; // mp3固定
    
  }



  /**
   * バックグラウンドで音声合成を実行する
   * @param params 音声合成パラメータ
   */
  async synthesizeInBackground(params: any): Promise<void> {
    // バックグラウンドで実行（即座にresolveして戻る）
    setImmediate(async () => {
      try {
        await this.synthesizeAndPlay(params);
      } catch (error) {
        console.error('Background synthesis error:', error);
      }
    });
  }

  /**
   * 音声合成とストリーミング再生を実行する
   * @param params 音声合成パラメータ
   * @returns void
   */
  private async synthesizeAndPlay(params: any): Promise<void> {
    try {
      if (!this.apiKey) {
        console.error('APIキーが設定されていません');
        return;
      }

      // リクエストパラメータを構築
      const requestParams = {
        model_uuid: params.model_uuid || this.defaultModelUuid,
        text: '<break time="500ms"/>' + params.text,
        output_format: this.defaultOutputFormat, // mp3固定
        speaker_uuid: params.speaker_uuid,
        style_id: params.style_id,
        style_name: params.style_name,
        speaking_rate: params.speaking_rate || params.speed_scale,
        emotional_intensity: params.emotional_intensity,
        tempo_dynamics: params.tempo_dynamics,
        pitch: params.pitch || params.pitch_scale,
        volume: params.volume || params.volume_scale,
        leading_silence_seconds: params.leading_silence_seconds || params.pre_phoneme_length,
        trailing_silence_seconds: params.trailing_silence_seconds || params.post_phoneme_length,
        line_break_silence_seconds: params.line_break_silence_seconds
      };

      // undefined値を削除
      Object.keys(requestParams).forEach(key => {
        if (requestParams[key as keyof typeof requestParams] === undefined) {
          delete requestParams[key as keyof typeof requestParams];
        }
      });

      // Aivis Cloud APIを呼び出し
      const response = await axios.post(
        `${this.baseUrl}/tts/synthesize`,
        requestParams,
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          },
          responseType: 'stream',
          timeout: 60000
        }
      );

      // ストリーミング再生
      await this.streamPlay(response.data);
    } catch (error) {
      console.error('Error in synthesizeAndPlay:', error);
      this.logDetailedError(error);
    }
  }

  /**
   * ストリーミング再生を実行する
   * @param stream 音声データストリーム
   */
  private async streamPlay(stream: any): Promise<void> {
    const system = platform();

    // プレイヤーコマンドを選択
    let players: string[] = [];
    if (system === 'darwin') {
      // macOS
      players = ['ffplay', 'mpv', 'afplay'];
    } else if (system === 'linux') {
      players = ['ffplay', 'mpv', 'mplayer', 'play'];
    } else if (system === 'win32') {
      players = ['ffplay.exe', 'mpv.exe'];
    }

    // 利用可能なプレイヤーを探す
    let playerCmd: string | null = null;
    
    for (const player of players) {
      try {
        // プレイヤーの存在確認
        const checkCmd = system === 'win32' ? 'where' : 'which';
        const result = spawn(checkCmd, [player], { stdio: 'pipe' });
        await new Promise<void>((resolve) => {
          result.on('exit', (code) => {
            if (code === 0) {
              playerCmd = player;
            }
            resolve();
          });
        });
        if (playerCmd) break;
      } catch {
        continue;
      }
    }

    if (!playerCmd) {
      // プレイヤーが見つからない場合は一時ファイルに保存
      const tempDir = path.join(process.cwd(), 'temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      const audioFilePath = path.join(tempDir, `speech_${Date.now()}.mp3`);

      // ストリームから一時ファイルに書き込み
      const writeStream = fs.createWriteStream(audioFilePath);
      stream.pipe(writeStream);

      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });

      // ファイルから再生（OS標準のプレイヤーを使用）
      if (system === 'darwin') {
        spawn('afplay', [audioFilePath], { stdio: 'ignore' });
      } else if (system === 'win32') {
        spawn('cmd', ['/c', 'start', '', audioFilePath], { stdio: 'ignore' });
      } else {
        console.error('No audio player found for playback');
      }

      // 一時ファイルの遅延削除（再生完了を待つ）
      setTimeout(() => {
        try {
          fs.unlinkSync(audioFilePath);
        } catch {}
      }, 30000); // 30秒後に削除

      return;
    }

    // ストリーミング再生コマンドを構築
    let cmd: string[];
    if (playerCmd === 'ffplay' || playerCmd === 'ffplay.exe') {
      // ffplayでバランスモード（低遅延設定）
      cmd = [
        '-f', 'mp3',  // mp3形式を明示的に指定
        '-nodisp', '-autoexit', '-loglevel', 'quiet',
        '-volume', '100',  // 音量を明示的に設定
        '-i', '-'
      ];
    } else if (playerCmd === 'mpv' || playerCmd === 'mpv.exe') {
      // mpvでバランスモード
      cmd = [
        '--no-video', '--really-quiet',
        '--demuxer-lavf-o=fflags=+nobuffer',
        '--audio-buffer=1', '--cache=yes', '--cache-secs=1',
        '--demuxer-readahead-secs=1', '-'
      ];
    } else {
      // その他のプレイヤー
      cmd = ['-'];
    }

    // プレイヤープロセスを起動
    const playerProcess = spawn(playerCmd, cmd, {
      stdio: ['pipe', 'ignore', 'ignore']
    });
    
    // ストリーミングデータを送信
    stream.pipe(playerProcess.stdin);

    // エラーハンドリング
    playerProcess.on('error', (error) => {
      console.error('Player process error:', error);
    });

    stream.on('error', (error: any) => {
      console.error('Stream error:', error);
      playerProcess.kill();
    });
  }

  /**
   * 詳細なエラー情報をログに出力する
   * @param error エラーオブジェクト
   */
  private logDetailedError(error: any): void {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        // サーバーからのレスポンスがある場合
        console.error('Response error data:', error.response.data);
        console.error('Response error status:', error.response.status);
      } else if (error.request) {
        // リクエストは送信されたがレスポンスがない場合
        console.error('No response received. Request:', error.request);
      } else {
        // リクエスト設定中にエラーが発生した場合
        console.error('Error message:', error.message);
      }
    } else {
      // Axiosエラーでない場合
      console.error('Non-Axios error:', error);
    }
  }

}

// シングルトンインスタンスをエクスポート
export default new AivisSpeechService();
