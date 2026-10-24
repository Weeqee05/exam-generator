import * as http from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {validConfig, makeTasks} from './dist/generator.mjs';
import {validateModelResult} from './dist/ai.mjs';
import {plainText} from './dist/export.mjs';
import {RequestError, readLimited} from './server/errors.mjs';
import {createModelClient, loadProviderSettings, configureRuntimeProxy} from './server/provider.mjs';
import {createStore, publicVariant} from './server/store.mjs';
import {checkDeterministic} from './server/checker.mjs';
import {safeHint, safeTutorMessage, safeFeedback} from './server/disclosure.mjs';
import {generationMessages} from './prompts/generation.mjs';
import {checkingMessages} from './prompts/checking.mjs';
import {explanationMessages} from './prompts/explanation.mjs';

export {loadProviderSettings, configureRuntimeProxy};

const assets = new Map([['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']], ['/styles.css', ['styles.css', 'text/css']], ...['app', 'generator', 'ai', 'export'].map(name => [`/${name}.mjs`, [`${name}.mjs`, 'text/javascript']])]);
const headers = {'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"};
const SESSION_COOKIE = 'praktikum_session';

function checkOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, 'Открой ассистента на этом сайте.');
  if (req.headers.origin) {
    let host;
    try { host = new URL(req.headers.origin).host; } catch {}
    if (host !== req.headers.host) throw new RequestError(403, 'Открой ассистента на этом сайте.');
  }
}

async function readInput(req, limit = 4096) {
  checkOrigin(req);
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new RequestError(415, 'Ожидается JSON.');
  let data;
  try { data = JSON.parse(await readLimited(req, limit)); } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, 'Некорректный запрос.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new RequestError(400, 'Некорректный запрос.');
  return data;
}

function validateFeedback(data) {
  if (!data || !['correct', 'incorrect', 'partial', 'clarify'].includes(data.verdict) ||
      typeof data.explanation !== 'string' || !data.explanation.trim() || data.explanation.length > 1500 ||
      typeof data.error !== 'string' || data.error.length > 1000 ||
      typeof data.hint !== 'string' || data.hint.length > 1000) {
    throw new RequestError(502, 'Модель вернула неполную проверку. Попробуй ещё раз.');
  }
  return {verdict: data.verdict, explanation: data.explanation.trim(), error: data.error.trim(), hint: data.hint.trim(), method: 'ai', needsClarification: data.verdict === 'clarify'};
}

function validateMessage(data) {
  if (!data || typeof data.message !== 'string' || !data.message.trim() || data.message.length > 2500) {
    throw new RequestError(502, 'Модель вернула неполное объяснение. Попробуй ещё раз.');
  }
  return data.message.trim();
}

export function createApp({settings = process.env, fetchModel = globalThis.fetch} = {}) {
  const responseHeaders = settings.EMBEDDED_PREVIEW === '1'
    ? {...headers, 'Content-Security-Policy': headers['Content-Security-Policy'].replace("frame-ancestors 'none'; ", '')}
    : headers;
  const model = createModelClient(settings, fetchModel);
  const store = createStore();
  const attempts = new Map();
  let active = 0;

  function send(res, status, data) {
    res.writeHead(status, {...responseHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
    res.end(JSON.stringify(data));
  }
  function ownerFor(req, res, create = false) {
    const cookie = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(SESSION_COOKIE + '='));
    const id = cookie?.slice(SESSION_COOKIE.length + 1);
    const owner = store.session(id, create);
    if (owner && owner.id !== id) {
      const secure = Boolean(req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https');
      // An HTTPS preview can be a third-party iframe. Partitioned cookies keep
      // that preview session separate for each embedding top-level website.
      const sameSite = settings.EMBEDDED_PREVIEW === '1' && secure ? 'None' : 'Lax';
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${owner.id}; Path=/api; HttpOnly; SameSite=${sameSite}; Max-Age=86400${secure ? '; Secure' : ''}${sameSite === 'None' ? '; Partitioned' : ''}`);
    }
    return owner;
  }
  function limit(req, expensive = false) {
    const now = Date.now();
    for (const [id, entry] of attempts) if (entry.until <= now) attempts.delete(id);
    const id = `${expensive ? 'model' : 'local'}:${req.socket.remoteAddress}`;
    const entry = attempts.get(id) || {count: 0, until: now + 60000};
    if (entry.count >= (expensive ? 10 : 60) || (expensive && active >= 2)) {
      throw new RequestError(429, 'Слишком много запросов. Подожди минуту и попробуй снова.');
    }
    entry.count++;
    attempts.set(id, entry);
  }
  async function ask(req, messages, maxTokens = 2048) {
    limit(req, true);
    active++;
    try { return await model.ask(messages, {maxTokens}); } finally { active--; }
  }
  async function generate(req, owner, config, number, source, similarQuestion = '', similarTag = '') {
    let tasks;
    if (source === 'ai') {
      let result;
      // Leave room for longer variants without reserving a large answer for a
      // single task. Reasoning stays enabled; incomplete output is still rejected.
      const maxTokens = Math.min(8000, 1536 + config.count * 512);
      try { result = validateModelResult(await ask(req, generationMessages(config, number, similarQuestion), maxTokens), config); }
      catch (error) {
        if (error instanceof RequestError || ['TimeoutError', 'AbortError'].includes(error.name)) throw error;
        throw new RequestError(502, 'Модель вернула неполный или неверный вариант. Попробуй ещё раз.');
      }
      tasks = result.tasks.map(task => ({tag: task.type, ...Object.fromEntries(['question', 'hint', 'answer', 'explanation'].map(key => [key, task[key]]))}));
      if (similarQuestion && tasks[0].question.replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru-RU') === similarQuestion.replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru-RU')) {
        throw new RequestError(502, 'Модель повторила исходное задание. Попробуй создать похожее ещё раз.');
      }
    } else {
      // The same existing templates now execute only on the server.
      let generated;
      for (let i = 0; i < 100; i++) {
        generated = makeTasks(config, randomBytes(4).readUInt32LE());
        if (!similarQuestion || (plainText(generated[0].question) !== similarQuestion && (!similarTag || generated[0].tag === similarTag))) break;
      }
      tasks = generated.map(task => ({tag: task.tag, ...Object.fromEntries(['question', 'hint', 'answer', 'explanation'].map(key => [key, plainText(task[key])])), proof: task.proof}));
    }
    tasks = tasks.map(task => ({...task, hint: safeHint(task)}));
    return publicVariant(store.add(owner, {number, config, source, tasks}));
  }

  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      // Status deliberately never creates a cookie: startup requests can run in parallel.
      if (req.method === 'GET' && path === '/api/status') return send(res, 200, {aiAvailable: model.ready});
      if (req.method === 'GET' && path === '/api/history') {
        const owner = ownerFor(req, res, true);
        return send(res, 200, {variants: owner.variants.map(publicVariant)});
      }
      const variantRoute = path.match(/^\/api\/variants\/([a-zA-Z0-9-]{1,100})$/);
      if (req.method === 'GET' && variantRoute) {
        const owner = ownerFor(req, res);
        const variant = owner?.variants.find(item => item.id === variantRoute[1]);
        if (!variant) throw new RequestError(404, 'Вариант больше недоступен. Возможно, сервер был перезапущен. Создай новый вариант.');
        return send(res, 200, {variant: publicVariant(variant)});
      }
      if (req.method === 'POST' && path === '/api/generate') {
        const input = await readInput(req);
        const source = input.source ?? 'ai';
        if (!validConfig(input.config) || !Number.isSafeInteger(input.variantId) || input.variantId < 1 || !['local', 'ai'].includes(source)) {
          throw new RequestError(400, 'Проверь тему, сложность и количество заданий.');
        }
        if (source === 'ai' && !model.ready) throw new RequestError(503, 'ИИ пока не подключён. Выбери обычную практику.');
        limit(req);
        const owner = ownerFor(req, res, true);
        const variant = await generate(req, owner, input.config, input.variantId, source);
        return send(res, 200, {variant});
      }
      const taskRoute = path.match(/^\/api\/tasks\/([a-zA-Z0-9-]{1,100})\/(check|hint|solution|chat|similar)$/);
      if (req.method === 'POST' && taskRoute) {
        const input = await readInput(req, 24000);
        limit(req);
        const owner = ownerFor(req, res);
        const found = store.findTask(owner, taskRoute[1]);
        if (!found) throw new RequestError(404, 'Задание больше недоступно. Возможно, сервер был перезапущен. Создай новый вариант.');
        const {task, variant} = found;
        const action = taskRoute[2];
        if (action === 'solution') return send(res, 200, {answer: task.answer, explanation: task.explanation});
        if (action === 'hint') {
          const message = safeHint(task);
          store.remember(task, 'Дай подсказку', message);
          return send(res, 200, {message});
        }
        if (task.busy) throw new RequestError(429, 'Дождись ответа ассистента по этому заданию.');
        task.busy = true;
        try {
          if (action === 'check') {
            if (typeof input.answer !== 'string' || !input.answer.trim()) throw new RequestError(400, 'Сначала введи свой ответ или решение.');
            if (input.answer.length > 4000) throw new RequestError(400, 'Сократи ответ до 4000 символов.');
            const studentAnswer = input.answer.trim();
            let feedback = checkDeterministic(task, studentAnswer);
            if (!feedback) {
              feedback = model.ready
                ? validateFeedback(await ask(req, checkingMessages(task, studentAnswer)))
                : {verdict: 'clarify', explanation: 'Без ИИ программа надёжно проверяет только поддерживаемые числовые ответы и краткие записи. Для этого рассуждения нужна проверка ассистентом.', error: '', hint: 'Попробуй записать краткий итоговый ответ. Полное объяснение можно открыть кнопкой «Покажи решение».', method: 'limited', needsClarification: true};
            }
            feedback = safeFeedback(task, feedback, studentAnswer);
            task.solved ||= feedback.verdict === 'correct';
            task.attempts.push({answer: studentAnswer, verdict: feedback.verdict});
            if (task.attempts.length > 10) task.attempts.shift();
            return send(res, 200, feedback);
          }
          if (action === 'chat') {
            if (input.action !== undefined && !['hint', 'simpler'].includes(input.action)) throw new RequestError(400, 'Выбери подсказку или упрощённое объяснение.');
            const message = input.action === 'hint' ? 'Дай подсказку' : input.action === 'simpler' ? 'Объясни проще' : input.message;
            if (typeof message !== 'string' || !message.trim()) throw new RequestError(400, 'Напиши вопрос ассистенту.');
            if (message.length > 2000) throw new RequestError(400, 'Сократи сообщение до 2000 символов.');
            let response;
            if (input.action === 'hint') response = task.hint;
            else if (model.ready) response = validateMessage(await ask(req, explanationMessages(task, task.chat, message.trim(), input.action)));
            else response = input.action === 'simpler'
              ? `Раздели задание на маленькие шаги. Сначала выпиши, что дано и что нужно найти. Затем используй ориентир: ${task.hint} После этого запиши свой результат и нажми «Проверить». Свободный диалог появится после подключения ИИ.`
              : `Сейчас доступен помощник без ИИ. По этому заданию начни так: ${task.hint} Я могу дать подсказку или показать сохранённое решение; для свободного диалога нужно подключить модель.`;
            response = safeTutorMessage(task, response);
            store.remember(task, message.trim(), response);
            return send(res, 200, {message: response});
          }
          if (action === 'similar') {
            const config = {...variant.config, count: 1};
            const largest = Math.max(...owner.variants.map(item => item.number));
            const number = largest < Number.MAX_SAFE_INTEGER ? largest + 1 : 1;
            const next = await generate(req, owner, config, number, variant.source, task.question, task.tag);
            return send(res, 200, {variant: next});
          }
        } finally { task.busy = false; }
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw new RequestError(405, 'Метод не поддерживается.');
      const asset = assets.get(path);
      if (!asset) throw new RequestError(404, 'Страница не найдена.');
      const body = await readFile(new URL('./dist/' + asset[0], import.meta.url));
      res.writeHead(200, {...responseHeaders, 'Content-Type': asset[1] + '; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Length': body.length});
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const timedOut = ['TimeoutError', 'AbortError'].includes(error.name);
      send(res, error.status || (timedOut ? 504 : 500), {error: error.status ? error.message : timedOut ? 'Модель отвечает слишком долго. Попробуй ещё раз.' : 'Не удалось выполнить запрос. Попробуй позже.'});
    }
  });
  server.requestTimeout = 60000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const settings = await loadProviderSettings();
  configureRuntimeProxy(settings);
  const host = settings.HOST || '127.0.0.1';
  const port = Number(settings.PORT || 8000);
  const server = createApp({settings});
  server.listen(port, host, () => console.log(`Практикум: сервер запущен, порт ${port}. ИИ ${settings.LLM_API_KEY ? 'настроен; доступ проверяется при запросе' : 'не подключён; обычная практика доступна'}.`));
}
