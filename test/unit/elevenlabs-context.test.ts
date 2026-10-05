import { jest } from '@jest/globals';
import http from 'http';
import type { AddressInfo } from 'net';
import { createSynthesizer } from '../../src/audio/synthesize.js';
import { ElevenLabsContextMemory, REQUEST_ID_MAX_AGE_MS } from '../../src/services/elevenlabs-context.js';
import { DICTIONARY_VERSION_CACHE_MS, PronunciationDictionaryResolver } from '../../src/services/dictionaries.js';
import { resolveContextWindowMinutes, type AppConfig } from '../../src/config.js';
import { testConfig } from '../helpers/fixtures.js';

describe('前の発話の文脈（メモリ）', () => {
  const v4 = (voiceId = 'voiceA', windowMinutes = 5) => ({ voiceId, modelId: 'eleven_v4_turbo', windowMinutes });

  test('直前の声の発話と同じ声・同じモデルなら、ID で、ID が無ければ文でつなぐ', () => {
    let now = 1_000_000;
    const memory = new ElevenLabsContextMemory(() => now);
    expect(memory.begin(v4())).toBeUndefined();
    memory.remember('voiceA', 'eleven_v4_turbo', 'req-1', '一つ目');
    now += 4 * 60_000;
    expect(memory.begin(v4())).toEqual({ previous_request_ids: ['req-1'] });
    memory.remember('voiceA', 'eleven_v4_turbo', undefined, '二つ目');
    expect(memory.begin(v4())).toEqual({ previous_text: '二つ目' });
  });

  test('始めたら直前の記録は消える（失敗・中断して覚え直さなければ、次はつながない）', () => {
    const memory = new ElevenLabsContextMemory(() => 0);
    memory.remember('voiceA', 'eleven_v4_turbo', 'req-1', '一つ目');
    expect(memory.begin(v4())).toEqual({ previous_request_ids: ['req-1'] });
    expect(memory.hasLast).toBe(false);
    expect(memory.begin(v4())).toBeUndefined();
  });

  test('別の声・別のモデル・Aivis が挟まったらつながない', () => {
    const memory = new ElevenLabsContextMemory(() => 0);
    memory.remember('voiceA', 'eleven_v4_turbo', 'req-1', '一つ目');
    expect(memory.begin(v4('voiceB'))).toBeUndefined();
    memory.remember('voiceB', 'eleven_v4_turbo', 'req-2', 'B');
    expect(memory.begin(v4('voiceA'))).toBeUndefined();

    memory.remember('voiceA', 'eleven_v4_turbo', 'req-3', 'A');
    expect(memory.begin({ voiceId: 'voiceA', modelId: 'eleven_multilingual_v2', windowMinutes: 5 })).toBeUndefined();
    memory.remember('voiceA', 'eleven_v4_turbo', 'req-4', 'A');
    expect(memory.begin(undefined)).toBeUndefined();
    expect(memory.begin(v4())).toBeUndefined();
  });

  test('窓を過ぎた・0 分ならつながない', () => {
    let now = 0;
    const memory = new ElevenLabsContextMemory(() => now);
    memory.remember('voiceA', 'eleven_v4_turbo', 'req-1', '一つ目');
    now = 5 * 60_000 + 1;
    expect(memory.begin(v4())).toBeUndefined();
    memory.remember('voiceA', 'eleven_v4_turbo', 'req-1', '一つ目');
    expect(memory.begin(v4('voiceA', 0))).toBeUndefined();
  });

  test('request ID は 2 時間を過ぎたら使わず、文で付ける', () => {
    let now = 0;
    const memory = new ElevenLabsContextMemory(() => now);
    memory.remember('voiceA', 'eleven_v4_turbo', 'req-1', '一つ目');
    now = REQUEST_ID_MAX_AGE_MS + 1;
    expect(memory.begin(v4('voiceA', 180))).toEqual({ previous_text: '一つ目' });
  });

  test('forget で記録を消したら、次はつながない', () => {
    const memory = new ElevenLabsContextMemory(() => 0);
    memory.remember('voiceA', 'eleven_v4_turbo', 'req-1', '一つ目');
    memory.forget();
    expect(memory.hasLast).toBe(false);
    expect(memory.begin(v4())).toBeUndefined();
  });

  test('eleven_v3 系には付けない', () => {
    const memory = new ElevenLabsContextMemory(() => 0);
    memory.remember('voiceA', 'eleven_v3', 'req-1', '一つ目');
    expect(memory.begin({ voiceId: 'voiceA', modelId: 'eleven_v3', windowMinutes: 5 })).toBeUndefined();
  });

  test('文脈を付ける時間は 環境変数 > config.json > 既定 5 分。範囲外は既定', () => {
    expect(resolveContextWindowMinutes(undefined, undefined)).toBe(5);
    expect(resolveContextWindowMinutes(undefined, 10)).toBe(10);
    expect(resolveContextWindowMinutes('0', 10)).toBe(0);
    expect(resolveContextWindowMinutes('', 2)).toBe(2);
    expect(resolveContextWindowMinutes('-1', 2)).toBe(5);
    expect(resolveContextWindowMinutes(undefined, 'abc')).toBe(5);
    expect(resolveContextWindowMinutes(undefined, ' ')).toBe(5);
    expect(resolveContextWindowMinutes(undefined, 1441)).toBe(5);
  });
});

interface Received {
  readonly method: string;
  readonly url: string;
  readonly body: Record<string, any> | undefined;
}

/** ElevenLabs の偽のサーバー。合成は request-id を付けて本文を返す。 */
async function fakeElevenLabs(handler?: (received: Received, response: http.ServerResponse) => boolean) {
  const received: Received[] = [];
  let counter = 0;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const item = { method: request.method ?? '', url: request.url ?? '', body: text === '' ? undefined : JSON.parse(text) };
      received.push(item);
      if (handler?.(item, response)) {
        return;
      }
      if (item.url.startsWith('/v1/text-to-speech/')) {
        counter += 1;
        response.writeHead(200, { 'Content-Type': 'audio/mpeg', 'request-id': `req-${counter}` });
        response.end(Buffer.alloc(64, 1));
        return;
      }
      response.writeHead(404);
      response.end('{}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    received,
    synthRequests: () => received.filter(item => item.url.startsWith('/v1/text-to-speech/')),
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

function elevenConfig(url: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...testConfig('redis://127.0.0.1:9'),
    provider: 'elevenlabs',
    elevenLabsApiKey: 'test-eleven',
    elevenLabsApiUrl: url,
    elevenLabsVoiceId: 'voiceA',
    apiUrl: url,
    ...overrides,
  };
}

async function readToEnd(stream: NodeJS.ReadableStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.on('data', () => undefined);
    stream.once('end', () => resolve());
    stream.once('error', reject);
  });
}

const eleven = (text: string, extra: Record<string, unknown> = {}) => ({ text, provider: 'elevenlabs', ...extra });

describe('ElevenLabs の合成に文脈と辞書を付ける', () => {
  test('読み終えた直前の発話の request ID を次の要求に付ける（ペインに関係なく、同じ声・同じモデルなら）', async () => {
    const server = await fakeElevenLabs();
    try {
      const synthesize = createSynthesizer({ dictionaryResolver: new PronunciationDictionaryResolver(async () => { throw new Error('unused'); }) });
      const config = elevenConfig(server.url);
      await readToEnd(await synthesize(config, eleven('<speak>一つ目</speak>', { _voiceRequester: 'pane-1' })));
      await readToEnd(await synthesize(config, eleven('二つ目', { _voiceRequester: 'pane-2' })));
      // 別の声には付けず、その後の元の声もつながない（間に挟まった）
      await readToEnd(await synthesize(config, eleven('三つ目', { voice_id: 'voiceB' })));
      await readToEnd(await synthesize(config, eleven('四つ目')));
      const bodies = server.synthRequests().map(item => item.body);
      expect(bodies).toEqual([
        { text: '一つ目', model_id: 'eleven_v4_turbo' },
        { text: '二つ目', model_id: 'eleven_v4_turbo', previous_request_ids: ['req-1'] },
        { text: '三つ目', model_id: 'eleven_v4_turbo' },
        { text: '四つ目', model_id: 'eleven_v4_turbo' },
      ]);
      expect(bodies.some(body => body !== undefined && ('next_text' in body || 'next_request_ids' in body))).toBe(false);
    } finally {
      await server.close();
    }
  });

  test('request ID が無い応答なら、前の文（タグを除いた送った文）を付ける', async () => {
    const server = await fakeElevenLabs((item, response) => {
      if (!item.url.startsWith('/v1/text-to-speech/')) {
        return false;
      }
      response.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      response.end(Buffer.alloc(16));
      return true;
    });
    try {
      const synthesize = createSynthesizer();
      const config = elevenConfig(server.url);
      await readToEnd(await synthesize(config, eleven('<break time="1s"/>一つ目')));
      await readToEnd(await synthesize(config, eleven('二つ目')));
      expect(server.synthRequests()[1].body).toEqual({ text: '二つ目', model_id: 'eleven_v4_turbo', previous_text: '一つ目' });
    } finally {
      await server.close();
    }
  });

  test('途中で止めた要求は覚えない', async () => {
    const server = await fakeElevenLabs((item, response) => {
      if (item.url.startsWith('/v1/text-to-speech/') && item.body?.text === '止める') {
        response.writeHead(200, { 'Content-Type': 'audio/mpeg', 'request-id': 'req-stopped' });
        response.write(Buffer.alloc(16));
        // 終わらせない
        return true;
      }
      return false;
    });
    try {
      const memory = new ElevenLabsContextMemory();
      const synthesize = createSynthesizer({ contextMemory: memory });
      const config = elevenConfig(server.url);
      await readToEnd(await synthesize(config, eleven('一つ目')));
      const controller = new AbortController();
      const stream = await synthesize(config, eleven('止める'), controller.signal) as NodeJS.ReadableStream & { destroy(): void };
      await new Promise(resolve => stream.once('data', resolve));
      stream.on('error', () => undefined);
      controller.abort();
      stream.destroy();
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(memory.hasLast).toBe(false);
      await readToEnd(await synthesize(config, eleven('次')));
      expect(server.synthRequests().map(item => item.body)).toEqual([
        { text: '一つ目', model_id: 'eleven_v4_turbo' },
        { text: '止める', model_id: 'eleven_v4_turbo', previous_request_ids: ['req-1'] },
        // 止めた発話で記録が消えたので、一つ目ともつながない
        { text: '次', model_id: 'eleven_v4_turbo' },
      ]);
    } finally {
      await server.close();
    }
  });

  test('失敗した発話で記録が消え、次はつながない', async () => {
    const server = await fakeElevenLabs((item, response) => {
      if (item.url.startsWith('/v1/text-to-speech/') && item.body?.text === '失敗') {
        response.writeHead(500, { 'request-id': 'req-failed' });
        response.end('{}');
        return true;
      }
      return false;
    });
    try {
      const memory = new ElevenLabsContextMemory();
      const synthesize = createSynthesizer({ contextMemory: memory });
      const config = elevenConfig(server.url);
      await readToEnd(await synthesize(config, eleven('一つ目')));
      await expect(synthesize(config, eleven('失敗'))).rejects.toBeDefined();
      expect(memory.hasLast).toBe(false);
      await readToEnd(await synthesize(config, eleven('次')));
      // 失敗した要求には付けていたが、その次はつながない（500 は文脈のせいではないので合成し直さない）
      expect(server.synthRequests().map(item => item.body!.previous_request_ids ?? null)).toEqual([null, ['req-1'], null]);
    } finally {
      await server.close();
    }
  });

  test('時間切れ・0 分・eleven_v3 では付けない', async () => {
    const server = await fakeElevenLabs();
    try {
      let now = 0;
      const synthesize = createSynthesizer({ contextMemory: new ElevenLabsContextMemory(() => now) });
      const config = elevenConfig(server.url);
      await readToEnd(await synthesize(config, eleven('一つ目')));
      now = 5 * 60_000 + 1;
      await readToEnd(await synthesize(config, eleven('時間切れ')));
      await readToEnd(await synthesize({ ...config, elevenLabsContextWindowMinutes: 0 }, eleven('無効')));
      await readToEnd(await synthesize(config, eleven('v3 一つ目', { model_id: 'eleven_v3' })));
      await readToEnd(await synthesize(config, eleven('v3 二つ目', { model_id: 'eleven_v3' })));
      const bodies = server.synthRequests().map(item => item.body!);
      expect(bodies.map(body => body.previous_request_ids ?? body.previous_text ?? null)).toEqual([null, null, null, null, null]);
    } finally {
      await server.close();
    }
  });

  test('間に Aivis の声が挟まったらつながない', async () => {
    const server = await fakeElevenLabs((item, response) => {
      if (item.url === '/tts/synthesize') {
        response.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        response.end(Buffer.alloc(8));
        return true;
      }
      return false;
    });
    try {
      const synthesize = createSynthesizer();
      const config = elevenConfig(server.url);
      await readToEnd(await synthesize(config, eleven('一つ目')));
      await readToEnd(await synthesize(config, { text: 'Aivis', provider: 'aivis' }));
      await readToEnd(await synthesize(config, eleven('二つ目')));
      await readToEnd(await synthesize(config, eleven('三つ目')));
      expect(server.synthRequests().map(item => item.body!.previous_request_ids ?? null)).toEqual([null, null, ['req-2']]);
    } finally {
      await server.close();
    }
  });

  test('文脈を付けた要求が 400 で失敗したら、文脈なしで 1 回だけ合成し直す', async () => {
    const server = await fakeElevenLabs((item, response) => {
      if (item.url.startsWith('/v1/text-to-speech/') && item.body?.previous_request_ids !== undefined) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end('{"detail":{"status":"invalid_request"}}');
        return true;
      }
      return false;
    });
    try {
      const synthesize = createSynthesizer();
      const config = elevenConfig(server.url);
      const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await readToEnd(await synthesize(config, eleven('一つ目')));
        await readToEnd(await synthesize(config, eleven('二つ目')));
      } finally {
        errors.mockRestore();
      }
      expect(server.synthRequests().map(item => item.body)).toEqual([
        { text: '一つ目', model_id: 'eleven_v4_turbo' },
        { text: '二つ目', model_id: 'eleven_v4_turbo', previous_request_ids: ['req-1'] },
        { text: '二つ目', model_id: 'eleven_v4_turbo' },
      ]);
    } finally {
      await server.close();
    }
  });

  test('文脈を付けていない要求の失敗、401・429 は合成し直さない', async () => {
    const statuses = [401, 429];
    const server = await fakeElevenLabs((item, response) => {
      if (item.url.startsWith('/v1/text-to-speech/') && item.body?.text !== '一つ目') {
        response.writeHead(statuses.shift() ?? 400);
        response.end('{}');
        return true;
      }
      return false;
    });
    try {
      const synthesize = createSynthesizer();
      const config = elevenConfig(server.url);
      await readToEnd(await synthesize(config, eleven('一つ目')));
      await expect(synthesize(config, eleven('二つ目'))).rejects.toBeDefined();
      await expect(synthesize(config, eleven('三つ目'))).rejects.toBeDefined();
      await expect(synthesize(config, eleven('四つ目', { voice_id: 'voiceB' }))).rejects.toBeDefined();
      expect(server.synthRequests()).toHaveLength(4);
    } finally {
      await server.close();
    }
  });

  test('発音辞書: 版が無ければ最新の版を取って 60 秒覚え、付ける', async () => {
    const server = await fakeElevenLabs((item, response) => {
      if (item.url === '/v1/pronunciation-dictionaries/dictA') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ id: 'dictA', name: 'A', latest_version_id: 'ver-2' }));
        return true;
      }
      return false;
    });
    try {
      let now = 0;
      const synthesize = createSynthesizer({ dictionaryResolver: new PronunciationDictionaryResolver(undefined, () => now) });
      const config = elevenConfig(server.url, { elevenLabsPronunciationDictionaryId: 'dictA', elevenLabsContextWindowMinutes: 0 });
      await readToEnd(await synthesize(config, eleven('一つ目')));
      now = DICTIONARY_VERSION_CACHE_MS - 1;
      await readToEnd(await synthesize(config, eleven('二つ目')));
      now = DICTIONARY_VERSION_CACHE_MS + 1;
      await readToEnd(await synthesize(config, eleven('三つ目')));
      expect(server.received.filter(item => item.url.startsWith('/v1/pronunciation-dictionaries/'))).toHaveLength(2);
      expect(server.synthRequests()[0].body!.pronunciation_dictionary_locators).toEqual([{ pronunciation_dictionary_id: 'dictA', version_id: 'ver-2' }]);
    } finally {
      await server.close();
    }
  });

  test('発音辞書: 版を指定していればそのまま。アーカイブ済み・取れないときは付けずに合成する', async () => {
    const server = await fakeElevenLabs((item, response) => {
      if (item.url === '/v1/pronunciation-dictionaries/archived') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ id: 'archived', name: 'old', latest_version_id: 'v', archived_time_unix: 1700000000 }));
        return true;
      }
      return false;
    });
    try {
      const synthesize = createSynthesizer();
      const base = elevenConfig(server.url, { elevenLabsContextWindowMinutes: 0 });
      const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await readToEnd(await synthesize({ ...base, elevenLabsPronunciationDictionaryId: 'dictA', elevenLabsPronunciationDictionaryVersionId: 'ver-1' }, eleven('版あり')));
        await readToEnd(await synthesize({ ...base, elevenLabsPronunciationDictionaryId: 'archived' }, eleven('アーカイブ')));
        await readToEnd(await synthesize({ ...base, elevenLabsPronunciationDictionaryId: 'missing' }, eleven('無い')));
      } finally {
        errors.mockRestore();
      }
      expect(server.synthRequests().map(item => item.body!.pronunciation_dictionary_locators ?? null)).toEqual([
        [{ pronunciation_dictionary_id: 'dictA', version_id: 'ver-1' }],
        null,
        null,
      ]);
      expect(server.received.some(item => item.url === '/v1/pronunciation-dictionaries/dictA')).toBe(false);
    } finally {
      await server.close();
    }
  });

  test('Aivis にはユーザー辞書の UUID を付ける', async () => {
    const server = await fakeElevenLabs((item, response) => {
      if (item.url === '/tts/synthesize') {
        response.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        response.end(Buffer.alloc(8));
        return true;
      }
      return false;
    });
    try {
      const synthesize = createSynthesizer();
      const uuid = '11111111-2222-3333-4444-555555555555';
      await readToEnd(await synthesize({ ...elevenConfig(server.url), aivisUserDictionaryUuid: uuid }, { text: 'こんにちは', provider: 'aivis' }));
      await readToEnd(await synthesize(elevenConfig(server.url), { text: '辞書なし', provider: 'aivis' }));
      const bodies = server.received.filter(item => item.url === '/tts/synthesize').map(item => item.body!);
      expect(bodies[0].user_dictionary_uuid).toBe(uuid);
      expect('user_dictionary_uuid' in bodies[1]).toBe(false);
    } finally {
      await server.close();
    }
  });
});
