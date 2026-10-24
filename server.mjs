import * as http from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import packageInfo from './package.json' with {type:'json'};
import {validConfig, hasTemplates, makeTasks} from './dist/generator.mjs';
import {validateModelResult} from './dist/ai.mjs';
import {plainText} from './dist/export.mjs';
import {RequestError, readLimited} from './server/errors.mjs';
import {createModelRegistry, loadProviderSettings, configureRuntimeProxy} from './server/provider.mjs';
import {createStore, publicVariant} from './server/store.mjs';
import {checkDeterministic} from './server/checker.mjs';
import {safeHint, safeTutorMessage, safeFeedback} from './server/disclosure.mjs';
import {generationMessages} from './prompts/generation.mjs';
import {checkingMessages} from './prompts/checking.mjs';
import {explanationMessages} from './prompts/explanation.mjs';
import {dialogueMessages} from './prompts/dialogue.mjs';
import {directAction, feedbackParagraphs, feedbackMethod} from './dist/dialogue.mjs';

export {loadProviderSettings, configureRuntimeProxy};

const assets = new Map([['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']], ['/styles.css', ['styles.css', 'text/css']], ...['app', 'generator', 'ai', 'export', 'dialogue', 'format', 'vendor/katex/katex'].map(name => [`/${name}.mjs`, [`${name}.mjs`, 'text/javascript']]), ['/vendor/katex/katex.min.css',['vendor/katex/katex.min.css','text/css']]]);
const headers = {'X-App-Version':packageInfo.version,'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"};
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
  const models = createModelRegistry(settings, fetchModel);
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
  async function ask(req, model, messages, maxTokens = 2048) {
    const timeoutMs = req.assistantDeadline - Date.now();
    if (timeoutMs <= 0) throw new DOMException('Request deadline exceeded', 'TimeoutError');
    limit(req, true);
    active++;
    try { return await model.ask(messages, {maxTokens, timeoutMs}); } finally { active--; }
  }
  async function generate(req, owner, config, number, source, provider, similarQuestion = '', similarTag = '') {
    const model = selectModel(provider);
    let tasks;
    if (source === 'ai') {
      let result;
      const maxTokens = Math.min(8000, 1536 + config.count * 512);
      const recoverable = new Set(['MODEL_TRUNCATED','MODEL_STREAM_INVALID','MODEL_EMPTY','MODEL_JSON_INVALID','MODEL_PROTOCOL_INVALID','MODEL_VARIANT_INVALID']);
      // One bounded retry stays inside the original request deadline. It never
      // changes provider or stores an unfinished variant in the student's history.
      for(let attempt=0;attempt<2;attempt++) {
        try {
          const raw=await ask(req,model,generationMessages(config,number,similarQuestion,attempt>0),attempt ? Math.min(8000,maxTokens*2) : maxTokens);
          try {result=validateModelResult(raw,config);}
          catch {throw new RequestError(502,'ИИ не заполнил все задания в нужном формате. Попробуй меньше заданий или другую модель.','MODEL_VARIANT_INVALID');}
          break;
        } catch(error) {
          if(attempt===0 && recoverable.has(error.code) && req.assistantDeadline-Date.now()>=60000) continue;
          throw error;
        }
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
    return publicVariant(store.add(owner, {number, config, source, tasks, provider}));
  }

  function selectModel(provider) {
    const client = typeof provider === 'string' && models.get(provider);
    if (!client) throw new RequestError(400, 'Выбери Gemini или Qwen из списка моделей.');
    return client;
  }
  async function grade(req, model, task, answer) {
    if (typeof answer !== 'string' || !answer.trim()) throw new RequestError(400, 'Сначала введи свой ответ или решение.');
    if (answer.length > 4000) throw new RequestError(400, 'Сократи ответ до 4000 символов.');
    const studentAnswer = answer.trim();
    let feedback = checkDeterministic(task, studentAnswer);
    if (!feedback) feedback = model.ready
      ? validateFeedback(await ask(req, model, checkingMessages(task, studentAnswer)))
      : {verdict:'clarify', explanation:'Какой итоговый ответ у тебя получился? Без ИИ я надёжно проверяю только поддерживаемые краткие ответы.', error:'', hint:'', method:'limited', needsClarification:true};
    feedback = safeFeedback(task, feedback, studentAnswer);
    task.solved ||= feedback.verdict === 'correct';
    task.attempts.push({answer:studentAnswer, verdict:feedback.verdict});
    if (task.attempts.length > 10) task.attempts.shift();
    const title = {correct:'Верно',incorrect:'Неверно',partial:'Частично верно',clarify:'Уточни ответ'}[feedback.verdict];
    store.remember(task, studentAnswer, [title, ...feedbackParagraphs(feedback), feedbackMethod(feedback)].join('\n'));
    return feedback;
  }

  const server = http.createServer(async (req, res) => {
    req.assistantDeadline = Date.now() + 240000;
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      // Status deliberately never creates a cookie: startup requests can run in parallel.
      if (req.method === 'GET' && path === '/api/status') return send(res, 200, {aiAvailable: models.ready});
      if (req.method === 'GET' && path === '/api/models') return send(res, 200, {defaultProvider: models.defaultProvider, providers: models.describe()});
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
          throw new RequestError(400, 'Проверь тему, сложность и количество заданий. Своя тема должна содержать от 2 до 160 символов в одной строке.');
        }
        if (source === 'local' && !hasTemplates(input.config.topic)) throw new RequestError(400, 'Для этой темы выбери ИИ-ассистента. Шаблоны доступны для комплексных чисел, множеств и Python.');
        // Store only supported settings; custom text is a subject, never an instruction.
        const {topic, level, count} = input.config;
        const config = {topic, level, count, ...(topic === 'custom' ? {customTopic:input.config.customTopic.trim()} : {})};
        const provider = input.provider ?? models.defaultProvider;
        const model = selectModel(provider);
        if (source === 'ai' && !model.ready) throw new RequestError(503, 'ИИ пока не подключён. Выбери обычную практику.');
        limit(req);
        const owner = ownerFor(req, res, true);
        const variant = await generate(req, owner, config, input.variantId, source, provider);
        return send(res, 200, {variant});
      }
      const taskRoute = path.match(/^\/api\/tasks\/([a-zA-Z0-9-]{1,100})\/(check|hint|solution|chat|similar|respond)$/);
      if (req.method === 'POST' && taskRoute) {
        const input = await readInput(req, 24000);
        limit(req);
        const owner = ownerFor(req, res);
        const found = store.findTask(owner, taskRoute[1]);
        if (!found) throw new RequestError(404, 'Задание больше недоступно. Возможно, сервер был перезапущен. Создай новый вариант.');
        const {task, variant} = found;
        const provider = input.provider ?? variant.provider ?? models.defaultProvider;
        const model = selectModel(provider);
        const automatic = taskRoute[2] === 'respond';
        const reply = (data, kind = 'message') => send(res, 200, automatic ? {kind, ...data} : data);
        let action = taskRoute[2];
        if (automatic) {
          if (typeof input.message !== 'string' || !input.message.trim()) throw new RequestError(400, 'Напиши ответ или вопрос.');
          if (input.message.length > 4000) throw new RequestError(400, 'Сократи сообщение до 4000 символов.');
          action = directAction(input.message) || 'respond';
          if (action === 'simpler') { action = 'chat'; input.action = 'simpler'; }
        }
        if (action === 'solution') return reply({answer: task.answer, explanation: task.explanation}, 'solution');
        if (action === 'hint') {
          const message = safeHint(task);
          store.remember(task, 'Дай подсказку', message);
          return reply({message});
        }
        if (task.busy) throw new RequestError(429, 'Дождись ответа ассистента по этому заданию.');
        task.busy = true;
        try {
          if (action === 'check') return reply(await grade(req, model, task, input.answer), 'feedback');
          if (action === 'respond') {
            const text = input.message.trim();
            const numeric = checkDeterministic(task, text);
            if (numeric && numeric.verdict !== 'clarify') return reply(await grade(req, model, task, text), 'feedback');
            if (!model.ready) {
              if (numeric) return reply(await grade(req, model, task, text), 'feedback');
              const message = `Для свободного диалога нужна подключённая модель. Сейчас могу дать подсказку или показать решение. ${safeHint(task)}`;
              store.remember(task, text, message); return reply({message});
            }
            const routed = await ask(req, model, dialogueMessages(task, task.chat, text));
            if (routed?.intent === 'answer') return reply(await grade(req, model, task, text), 'feedback');
            if (routed?.intent !== 'chat') throw new RequestError(502, 'Не удалось понять ответ ассистента. Попробуй ещё раз.');
            const message = safeTutorMessage(task, validateMessage(routed));
            store.remember(task, text, message); return reply({message});
          }
          if (action === 'chat') {
            if (input.action !== undefined && !['hint', 'simpler'].includes(input.action)) throw new RequestError(400, 'Выбери подсказку или упрощённое объяснение.');
            const message = input.action === 'hint' ? 'Дай подсказку' : input.action === 'simpler' ? 'Объясни проще' : input.message;
            if (typeof message !== 'string' || !message.trim()) throw new RequestError(400, 'Напиши вопрос ассистенту.');
            if (message.length > 2000) throw new RequestError(400, 'Сократи сообщение до 2000 символов.');
            let response;
            if (input.action === 'hint') response = task.hint;
            else if (model.ready) response = validateMessage(await ask(req, model, explanationMessages(task, task.chat, message.trim(), input.action)));
            else response = input.action === 'simpler'
              ? `Раздели задание на маленькие шаги. Сначала выпиши, что дано и что нужно найти. Затем используй ориентир: ${task.hint} После этого запиши свой результат и отправь его в чат. Свободный диалог появится после подключения ИИ.`
              : `Сейчас доступен помощник без ИИ. По этому заданию начни так: ${task.hint} Я могу дать подсказку или показать сохранённое решение; для свободного диалога нужно подключить модель.`;
            response = safeTutorMessage(task, response);
            store.remember(task, message.trim(), response);
            return reply({message: response});
          }
          if (action === 'similar') {
            const config = {...variant.config, count: 1};
            const largest = Math.max(...owner.variants.map(item => item.number));
            const number = largest < Number.MAX_SAFE_INTEGER ? largest + 1 : 1;
            const next = await generate(req, owner, config, number, variant.source, provider, task.question, task.tag);
            return reply({variant: next}, 'variant');
          }
        } finally { task.busy = false; }
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw new RequestError(405, 'Метод не поддерживается.');
      const font = /^\/vendor\/katex\/fonts\/KaTeX_[A-Za-z0-9_-]+\.woff2$/.test(path);
      const asset = assets.get(path) || (font ? [path.slice(1),'font/woff2'] : null);
      if (!asset) throw new RequestError(404, 'Страница не найдена.');
      let body;
      try {body = await readFile(new URL('./dist/' + asset[0], import.meta.url));}
      catch(error) {if(error.code==='ENOENT') throw new RequestError(404,'Файл не найден.');throw error;}
      res.writeHead(200, {...responseHeaders, 'Content-Type': asset[1] + '; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Length': body.length});
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const timedOut = ['TimeoutError', 'AbortError'].includes(error.name);
      send(res, error.status || (timedOut ? 504 : 500), {error: error.status ? error.message : timedOut ? 'Модель отвечает слишком долго. Попробуй ещё раз.' : 'Не удалось выполнить запрос. Попробуй позже.',...(error instanceof RequestError && error.code ? {code:error.code} : {})});
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
  server.listen(port, host, () => console.log(`Экзамен+: сервер запущен, порт ${port}. ИИ ${createModelRegistry(settings).ready ? 'настроен; доступ проверяется при запросе' : 'не подключён; обычная практика доступна'}.`));
}
