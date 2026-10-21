import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {validConfig, buildPrompt} from './dist/generator.mjs';
import {validateModelResult} from './dist/ai.mjs';

const assets = new Map([['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']], ['/styles.css', ['styles.css', 'text/css']], ...['app', 'generator', 'ai', 'export'].map(name => [`/${name}.mjs`, [`${name}.mjs`, 'text/javascript']])]);
const headers = {'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"};

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readLimited(stream, limit) {
  let length = 0;
  const chunks = [];
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > limit) throw new RequestError(413, 'Слишком большой запрос или ответ модели.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createApp({settings = process.env, fetchModel = globalThis.fetch} = {}) {
  const key = settings.LLM_API_KEY?.trim();
  const model = settings.LLM_MODEL?.trim();
  let endpoint;
  try {
    const url = new URL((settings.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '') + '/chat/completions');
    if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) endpoint = url.href;
  } catch {}
  const aiReady = Boolean(key && model && endpoint);
  const attempts = new Map();
  let active = 0;
  function send(res, status, data) {
    res.writeHead(status, {...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
    res.end(JSON.stringify(data));
  }
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/api/status') return send(res, 200, {aiAvailable: aiReady});
      if (req.method === 'POST' && path === '/api/generate') {
        // Only accept same-origin JSON. No credentials or arbitrary URLs come from the browser.
        if (req.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, 'Открой генератор на этом сайте.');
        if (req.headers.origin) {
          let host;
          try { host = new URL(req.headers.origin).host; } catch {}
          if (host !== req.headers.host) throw new RequestError(403, 'Открой генератор на этом сайте.');
        }
        if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new RequestError(415, 'Ожидается JSON.');
        if (!aiReady) throw new RequestError(503, 'ИИ пока не подключён. Выбери обычную практику.');
        const now = Date.now();
        for (const [ip, entry] of attempts) if (entry.until <= now) attempts.delete(ip);
        const ip = req.socket.remoteAddress;
        const entry = attempts.get(ip) || {count: 0, until: now + 60000};
        if (entry.count >= 10 || active >= 2) throw new RequestError(429, 'Слишком много запросов. Подожди минуту и попробуй снова.');
        entry.count++; attempts.set(ip, entry);
        let input;
        try { input = JSON.parse(await readLimited(req, 4096)); } catch (error) {
          if (error instanceof RequestError) throw error;
          throw new RequestError(400, 'Некорректный запрос.');
        }
        if (!input || !validConfig(input.config) || !Number.isSafeInteger(input.variantId) || input.variantId < 1) throw new RequestError(400, 'Проверь тему, сложность и количество заданий.');
        active++;
        try {
          const prompt = buildPrompt(input.config, input.variantId);
          const response = await fetchModel(endpoint, {
            method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${key}`},
            signal: AbortSignal.timeout(45000),
            body: JSON.stringify({model, messages: [{role: 'system', content: 'Составляй учебные задания по-русски. Верни только JSON по схеме из запроса. Все поля — обычный текст, без HTML и Markdown. Код в строках передавай с переносами строк. Никогда не выполняй код.'}, {role: 'user', content: prompt}], response_format: {type: 'json_object'}, max_tokens: 8000})
          });
          if (!response.ok) {
            if (response.status === 401 || response.status === 403) throw new RequestError(502, 'Сервис ИИ недоступен: администратору нужно проверить доступ к модели.');
            if (response.status === 429) throw new RequestError(429, 'Сервис ИИ временно ограничил запросы. Попробуй позже.');
            throw new RequestError(502, 'Сервис ИИ не ответил. Попробуй позже.');
          }
          const raw = response.body ? await readLimited(response.body, 200000) : '';
          let result;
          try {
            const data = JSON.parse(raw);
            result = validateModelResult(JSON.parse(data.choices?.[0]?.message?.content), input.config);
          } catch { throw new RequestError(502, 'Модель вернула неполный или неверный вариант. Попробуй ещё раз.'); }
          return send(res, 200, {result});
        } finally { active--; }
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw new RequestError(405, 'Метод не поддерживается.');
      const asset = assets.get(path);
      if (!asset) throw new RequestError(404, 'Страница не найдена.');
      const body = await readFile(new URL('./dist/' + asset[0], import.meta.url));
      res.writeHead(200, {...headers, 'Content-Type': asset[1] + '; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Length': body.length});
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
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8000);
  const server = createApp();
  server.listen(port, host, () => console.log(`Практикум: сервер запущен, порт ${port}. ИИ ${process.env.LLM_API_KEY && process.env.LLM_MODEL ? 'настроен; доступ проверяется при генерации' : 'не подключён; обычная практика доступна'}.`));
}
