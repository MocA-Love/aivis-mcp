/**
 * 合成に使う辞書（ElevenLabs の発音辞書・Aivis のユーザー辞書）。
 */

import axios from 'axios';
import type { AppConfig } from '../config.js';
import { getElevenLabsPronunciationDictionary } from './elevenlabs-client.js';

/** 版を指定していない発音辞書の「最新の版」を覚えておく時間 */
export const DICTIONARY_VERSION_CACHE_MS = 60_000;
/** 合成の前に最新の版を取りにいくときの上限（これを超えたら辞書なしで合成する） */
export const DICTIONARY_LOOKUP_TIMEOUT_MS = 5_000;

export interface PronunciationDictionaryLocator {
  readonly pronunciation_dictionary_id: string;
  readonly version_id: string;
}

type Lookup = (config: AppConfig, dictionaryId: string, signal?: AbortSignal) => Promise<{ latest_version_id: string; archived_time_unix?: number }>;

const defaultLookup: Lookup = (config, dictionaryId, signal) =>
  getElevenLabsPronunciationDictionary(config, dictionaryId, { signal, timeoutMs: DICTIONARY_LOOKUP_TIMEOUT_MS });

/**
 * 設定の発音辞書を、合成の要求に付ける形にする。版を指定していなければ最新の版を取り、60 秒覚える。
 * 取れない・アーカイブ済みなら付けない（辞書なしで合成する。取れなかった結果も 60 秒覚える）。
 */
export class PronunciationDictionaryResolver {
  private readonly cache = new Map<string, { at: number; locator: PronunciationDictionaryLocator | undefined }>();
  private readonly warned = new Set<string>();

  constructor(
    private readonly lookup: Lookup = defaultLookup,
    private readonly now: () => number = Date.now,
  ) {}

  async resolve(config: AppConfig, signal?: AbortSignal): Promise<PronunciationDictionaryLocator | undefined> {
    const dictionaryId = config.elevenLabsPronunciationDictionaryId;
    if (dictionaryId === undefined) {
      return undefined;
    }
    if (config.elevenLabsPronunciationDictionaryVersionId !== undefined) {
      return { pronunciation_dictionary_id: dictionaryId, version_id: config.elevenLabsPronunciationDictionaryVersionId };
    }
    const cached = this.cache.get(dictionaryId);
    if (cached !== undefined && this.now() - cached.at < DICTIONARY_VERSION_CACHE_MS) {
      return cached.locator;
    }
    let locator: PronunciationDictionaryLocator | undefined;
    try {
      const dictionary = await this.lookup(config, dictionaryId, signal);
      if (dictionary.archived_time_unix !== undefined) {
        this.warnOnce(`archived:${dictionaryId}`, `発音辞書 ${dictionaryId} はアーカイブ済みなので使いません`);
      } else {
        locator = { pronunciation_dictionary_id: dictionaryId, version_id: dictionary.latest_version_id };
      }
    } catch (error) {
      if (signal?.aborted) {
        // 発話を止めただけ。辞書が取れなかったとは覚えない
        throw error;
      }
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      this.warnOnce(`failed:${dictionaryId}:${status ?? 'network'}`, `発音辞書 ${dictionaryId} の最新の版を取れなかったので、辞書なしで合成します${status === undefined ? '' : ` (${status})`}`);
    }
    this.cache.set(dictionaryId, { at: this.now(), locator });
    return locator;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) {
      return;
    }
    this.warned.add(key);
    console.error(`[aivis-mcp] ${message}`);
  }
}

export interface AivisUserDictionary {
  readonly uuid: string;
  readonly name: string;
  readonly description?: string;
  readonly word_count?: number;
  readonly updated_at?: string;
}

/** Aivis のユーザー辞書の一覧（作った順）。 */
export async function listAivisUserDictionaries(config: AppConfig): Promise<AivisUserDictionary[]> {
  const response = await axios.get(`${config.apiUrl}/user-dictionaries`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
    timeout: 15000,
  });
  const items: any[] = Array.isArray(response.data?.user_dictionaries) ? response.data.user_dictionaries : [];
  return items
    .filter(item => item !== null && typeof item === 'object' && typeof item.uuid === 'string')
    .map(item => ({
      uuid: item.uuid,
      name: typeof item.name === 'string' ? item.name : '',
      description: typeof item.description === 'string' && item.description !== '' ? item.description : undefined,
      word_count: typeof item.word_count === 'number' ? item.word_count : undefined,
      updated_at: typeof item.updated_at === 'string' ? item.updated_at : undefined,
    }));
}

/** Aivis のユーザー辞書を 1 つ取る（あるかどうかの確認）。 */
export async function getAivisUserDictionary(config: AppConfig, uuid: string): Promise<void> {
  await axios.get(`${config.apiUrl}/user-dictionaries/${encodeURIComponent(uuid)}`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
    timeout: 15000,
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Aivis のユーザー辞書の UUID の形か */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** ElevenLabs の辞書・版の ID として受け付ける形（英数字と - _ だけ） */
export function isElevenLabsId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
