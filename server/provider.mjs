import * as http from 'node:http';
import {readFile} from 'node:fs/promises';
import {RequestError, readLimited} from './errors.mjs';

const SHARELLM_BASE_URL = 'https://sharellm.net/v1';
const SHARELLM_MODEL = 'qwen3.8-27b';
const LEGACY_STREAM_MODEL = 'qwen3.8-flash';
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const DEFAULT_MODEL = 'gemini-3.1-flash-lite';

export const MODEL_PRESETS = {
  gemini: {label: 'Gemini', base: DEFAULT_BASE_URL, model: DEFAULT_MODEL},
  qwen: {label: 'Qwen', base: SHARELLM_BASE_URL, model: SHARELLM_MODEL}
};

// The browser selects only a public id; credentials and destinations stay here.
export function createModelRegistry(settings, fetchModel) {
  const base = normalizeBase(settings.LLM_BASE_URL?.trim() || DEFAULT_BASE_URL);
  const defaultProvider = Object.keys(MODEL_PRESETS).find(id => MODEL_PRESETS[id].base === base) || 'default';
  const clients = new Map();
  for (const [id, preset] of Object.entries(MODEL_PRESETS)) {
    const prefix = id.toUpperCase();
    const explicitKey = settings[prefix + '_API_KEY']?.trim();
    const current = id === defaultProvider;
    clients.set(id, createModelClient({
      LLM_API_KEY: explicitKey || (current ? settings.LLM_API_KEY : undefined),
      LLM_BASE_URL: settings[prefix + '_BASE_URL'] || preset.base,
      LLM_MODEL: settings[prefix + '_MODEL'] || (current && !explicitKey ? settings.LLM_MODEL : undefined) || preset.model
    }, fetchModel));
  }
  if (defaultProvider === 'default') clients.set('default', createModelClient(settings, fetchModel));
  const preferredProvider = clients.get(defaultProvider)?.ready ? defaultProvider : ([...clients].find(([, client]) => client.ready)?.[0] || defaultProvider);
  return {
    defaultProvider: preferredProvider,
    get(id = preferredProvider) {return clients.get(id);},
    describe() {return [...clients].map(([id, client]) => ({id, label: MODEL_PRESETS[id]?.label || 'Текущее подключение', available: client.ready}));},
    get ready() {return [...clients.values()].some(client => client.ready);}
  };
}

function defaultModel(base) {
  if (base === DEFAULT_BASE_URL) return DEFAULT_MODEL;
  if (base === SHARELLM_BASE_URL) return SHARELLM_MODEL;
}

function normalizeBase(value) {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return;
    url.pathname = url.pathname.replace(/\/+$/, '') || '/v1';
    return url.href.replace(/\/$/, '');
  } catch {}
}

// A locally imported New API connection takes precedence over environment
// fields. This file is ignored by Git and is never served to the browser.
export async function loadProviderSettings(settings = process.env, path = new URL('../.env.connection.json', import.meta.url)) {
  let raw;
  try { raw = await readFile(path, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return {...settings};
    throw new Error('Не удалось прочитать локальное подключение ИИ.');
  }
  let connection;
  try { connection = JSON.parse(raw); } catch {
    throw new Error('В .env.connection.json должен быть корректный JSON подключения.');
  }
  const base = normalizeBase(connection?.url);
  if (connection?._type !== 'newapi_channel_conn' || !base || typeof connection.key !== 'string' || !connection.key.trim() || (connection.model !== undefined && (typeof connection.model !== 'string' || !connection.model.trim()))) {
    throw new Error('Проверь формат подключения в .env.connection.json: нужны тип newapi_channel_conn, HTTPS-адрес url и ключ key.');
  }
  const profiles = {};
  if (connection.providers !== undefined) {
    if (!connection.providers || typeof connection.providers !== 'object' || Array.isArray(connection.providers)) throw new Error('Проверь серверные профили подключения ИИ.');
    for (const [id, value] of Object.entries(connection.providers)) {
      const profileBase = normalizeBase(value?.url);
      if (!Object.hasOwn(MODEL_PRESETS, id) || !profileBase || typeof value?.key !== 'string' || !value.key.trim() || (value.model !== undefined && (typeof value.model !== 'string' || !value.model.trim()))) throw new Error('Проверь серверные профили подключения ИИ.');
      const prefix = id.toUpperCase();
      profiles[prefix + '_API_KEY'] = value.key.trim();
      profiles[prefix + '_BASE_URL'] = profileBase;
      profiles[prefix + '_MODEL'] = value.model?.trim() || MODEL_PRESETS[id].model;
    }
  }
  return {
    ...settings,
    ...profiles,
    LLM_API_KEY: connection.key.trim(),
    LLM_BASE_URL: base,
    LLM_MODEL: connection.model?.trim() || defaultModel(base) || settings.LLM_MODEL
  };
}

// Honor the platform's HTTPS proxy so scoped secret placeholders are replaced
// at their configured destination. TLS verification remains enabled.
export function configureRuntimeProxy(settings = process.env) {
  if (!settings.HTTPS_PROXY && !settings.https_proxy && !settings.HTTP_PROXY && !settings.http_proxy) return;
  if (typeof http.setGlobalProxyFromEnv !== 'function') {
    throw new Error('Для подключения ИИ через сетевой прокси используй Node.js 24.5 или новее.');
  }
  http.setGlobalProxyFromEnv(settings);
}

// Qwen sends reasoning and final-answer deltas in separate SSE fields. Only
// final text reaches the existing JSON validator and the browser.
async function readStreamedChoice(stream) {
  const invalid = () => new RequestError(502, 'Модель вернула неполный или неверный вариант. Попробуй ещё раз.');
  if (!stream) throw invalid();
  const decoder = new TextDecoder('utf-8', {fatal: true});
  const parts = [];
  let rawBytes = 0, contentBytes = 0, line = '', dataLines = [], eventType = '', skipLF = false, done = false, finishReason;
  function dispatch() {
    if (eventType === 'error') throw invalid();
    eventType = '';
    if (!dataLines.length) return;
    const payload = dataLines.join('\n');
    dataLines = [];
    if (payload.trim() === '[DONE]') { done = true; return; }
    let data;
    try { data = JSON.parse(payload); } catch { throw invalid(); }
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.hasOwn(data, 'error') || !Array.isArray(data.choices)) throw invalid();
    if (!data.choices.length) return; // Usage-only events can have an empty choices array.
    const choice = data.choices[0];
    if (!choice || typeof choice !== 'object' || Array.isArray(choice) || (choice.delta != null && (typeof choice.delta !== 'object' || Array.isArray(choice.delta)))) throw invalid();
    if (choice.finish_reason === 'length') throw invalid();
    if (choice.finish_reason != null) {
      if (typeof choice.finish_reason !== 'string') throw invalid();
      finishReason = choice.finish_reason;
    }
    const fragment = choice.delta?.content;
    if (fragment == null || fragment === '') return;
    if (typeof fragment !== 'string') throw invalid();
    contentBytes += Buffer.byteLength(fragment, 'utf8');
    const previous = parts.at(-1);
    // Count a surrogate pair split between JSON deltas as one UTF-8 character.
    if (previous && /[\uD800-\uDBFF]$/.test(previous) && /^[\uDC00-\uDFFF]/.test(fragment)) contentBytes -= 2;
    if (contentBytes > 200000) throw new RequestError(413, 'Слишком большой запрос или ответ модели.');
    parts.push(fragment);
  }
  function acceptLine() {
    if (!line) dispatch();
    else if (!line.startsWith(':')) {
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') dataLines.push(value);
      else if (field === 'event') eventType = value;
    }
    line = '';
  }
  function feed(text) {
    for (const character of text) {
      if (done) return;
      if (skipLF) { skipLF = false; if (character === '\n') continue; }
      if (character === '\r' || character === '\n') { acceptLine(); skipLF = character === '\r'; }
      else line += character;
    }
  }
  try {
    for await (const chunk of stream) {
      rawBytes += chunk.byteLength;
      if (rawBytes > 2 * 1024 * 1024) throw new RequestError(413, 'Слишком большой запрос или ответ модели.');
      feed(decoder.decode(chunk, {stream: true}));
      if (done) break;
    }
    if (!done) feed(decoder.decode());
  } catch (error) {
    if (error instanceof RequestError || ['TimeoutError', 'AbortError'].includes(error.name)) throw error;
    throw invalid();
  }
  const content = parts.join('');
  if (!done || !content.trim()) throw invalid();
  return {message: {content}, finish_reason: finishReason};
}

// One provider adapter is shared by generation, checking and the tutor chat.
export function createModelClient(settings, fetchModel = globalThis.fetch) {
  const key = settings.LLM_API_KEY?.trim();
  const base = normalizeBase(settings.LLM_BASE_URL?.trim() || DEFAULT_BASE_URL);
  const model = settings.LLM_MODEL?.trim() || defaultModel(base);
  const endpoint = base && base + '/chat/completions';
  const stream = base === SHARELLM_BASE_URL && [SHARELLM_MODEL,LEGACY_STREAM_MODEL].includes(model);
  const ready = Boolean(key && model && endpoint);
  async function ask(messages, {maxTokens = 8000, timeoutMs = 240000} = {}) {
    if (!ready) throw new RequestError(503, 'ИИ пока не подключён. Выбери обычную практику.');
    let response;
    try {
      response = await fetchModel(endpoint, {
        method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${key}`},
        signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
        body: JSON.stringify({model, stream, messages, response_format: {type: 'json_object'}, max_tokens: maxTokens})
      });
    } catch (error) {
      if (['TimeoutError', 'AbortError'].includes(error.name)) throw error;
      throw new RequestError(502, 'Нет соединения с сервисом ИИ. Проверь доступ к сервису и попробуй позже.');
    }
    if (!response.ok) {
      let code;
      try {
        const data = JSON.parse(await readLimited(response.body, 16384));
        code = data?.error?.code || data?.code;
      } catch {}
      if (code === 'auto_router_disabled') throw new RequestError(503, 'В ShareLLM отключён Auto Model Router. Для работы ИИ его нужно включить на стороне ShareLLM.');
      if (code === 'model_not_supported' || code === 'model_not_found') throw new RequestError(502, 'Выбранная модель недоступна для этого подключения. Администратору нужно выбрать модель из списка сервиса ИИ.');
      if (response.status === 401 || response.status === 403) throw new RequestError(502, 'Сервис ИИ недоступен: администратору нужно проверить доступ к модели.');
      if (response.status === 429) throw new RequestError(429, 'Сервис ИИ временно ограничил запросы. Попробуй позже.');
      if (response.status === 402) throw new RequestError(502, 'Сервис ИИ отклонил запрос: администратору нужно проверить баланс.');
      if (response.status === 404) throw new RequestError(502, 'Модель или адрес API не найдены. Администратору нужно проверить настройки ИИ.');
      if (response.status === 503) throw new RequestError(503, 'Сервис ИИ временно недоступен. Попробуй позже или выбери обычную практику.');
      if (response.status === 524) throw new RequestError(504, 'Сервис ИИ слишком долго ждёт ответа модели. Попробуй позже или выбери другую модель.');
      throw new RequestError(502, 'Сервис ИИ не ответил. Попробуй позже.');
    }
    const streaming = response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream');
    let choice;
    if (streaming) choice = await readStreamedChoice(response.body);
    else {
      const raw = response.body ? await readLimited(response.body, 200000) : '';
      try { choice = JSON.parse(raw).choices?.[0]; } catch {
        throw new RequestError(502, 'Модель вернула неполный или неверный ответ. Попробуй ещё раз.');
      }
    }
    try {
      if (choice?.finish_reason === 'length') throw new Error('Incomplete model output');
      const content = choice?.message?.content;
      if (typeof content !== 'string') throw new Error('Missing model text');
      // Accept a complete fenced JSON block from compatible gateways, never code.
      const json = content.trim().replace(/^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/i, '$1');
      return JSON.parse(json);
    } catch { throw new RequestError(502, 'Модель вернула неполный или неверный ответ. Попробуй ещё раз.'); }
  }
  return {ready, ask};
}
