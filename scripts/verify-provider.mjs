import {request} from 'node:http';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {createApp, configureRuntimeProxy, loadProviderSettings} from '../server.mjs';
import {createModelRegistry} from '../server/provider.mjs';

// Explicit paid integration check. Never run from npm test or on page load.
// At most five model calls, including one possible generation-format retry.
const settings = await loadProviderSettings();
const registry = createModelRegistry(settings);
const provider = process.argv[2] || registry.defaultProvider;
const config=process.argv.includes('--limits')
  ? {topic:'custom',customTopic:'Пределы функций',level:'medium',count:3}
  : {topic:'complex',level:'easy',count:1};
if (!registry.get(provider)?.ready) {
  console.error('Выбранная модель не настроена. Добавь её серверный ключ перед настоящей проверкой.');
  process.exitCode = 1;
} else {
  configureRuntimeProxy(settings);
  const server = createApp({settings, fetchModel: async (...args) => {
    const started = Date.now();
    const response = await fetch(...args);
    if (!response.ok) console.error(`Сервис модели: HTTP ${response.status}, ожидание ${Math.round((Date.now() - started) / 1000)} с.`);
    return response;
  }});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let cookie = '';
  const operations = [];
  async function api(path, data) {
    const started = Date.now();
    const input = JSON.stringify({...data,provider});
    const result = await new Promise((resolve, reject) => {
      const req = request({host: '127.0.0.1', port: server.address().port, path, method: 'POST', agent: false,
        headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(input), ...(cookie ? {Cookie: cookie} : {})}, timeout: 260000}, res => {
        const nextCookie = res.headers['set-cookie']?.[0];
        if (nextCookie) cookie = nextCookie.split(';')[0];
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {text += chunk; if (text.length > 200000) res.destroy(new Error('Слишком большой ответ приложения.'));});
        res.on('error', reject);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(text);
            if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}: ${parsed.error || 'Ошибка приложения.'}`));
            else resolve(parsed);
          } catch (error) {reject(error);}
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('Истекло время проверки.')));
      req.end(input);
    });
    operations.push({path: path.replace(/tasks\/[^/]+/, 'tasks/:id'), seconds: Math.round((Date.now() - started) / 100) / 10});
    return result;
  }
  try {
    const {variant} = await api('/api/generate', {config, variantId: 1, source: 'ai'});
    assert.deepEqual(variant.config,config);
    assert.equal(variant.source, 'ai');
    assert.equal(variant.tasks.length, config.count);
    const task = variant.tasks[0];
    assert.ok(task.id && task.question?.trim());
    for (const name of ['answer', 'explanation', 'proof', 'hint']) assert.ok(!Object.hasOwn(task, name));
    console.log('PASS: настоящая генерация; эталон не отправлен с условием.');
    console.log('Условие:', task.question);
    const solution = await api(`/api/tasks/${task.id}/solution`, {});
    assert.ok(solution.answer?.trim() && solution.explanation?.trim());
    console.log('Ответ после явного запроса:', solution.answer);
    console.log('Решение:', solution.explanation);
    // A written derivation deliberately exercises AI grading, not numeric matching.
    const feedback = await api(`/api/tasks/${task.id}/respond`, {message: `Моё решение по шагам:\n${solution.explanation}\nМой итоговый ответ: ${solution.answer}`});
    assert.equal(feedback.kind, 'feedback', 'Развёрнутая попытка должна распознаваться как ответ.');
    assert.equal(feedback.method, 'ai', 'Ожидалась настоящая проверка развёрнутого решения моделью.');
    assert.equal(feedback.verdict, 'correct', 'Модель не подтвердила собственное эталонное решение.');
    console.log('PASS: реальная ИИ-проверка развёрнутого ответа:', feedback.explanation);
    const chat = await api(`/api/tasks/${task.id}/respond`, {message: 'Как выбрать метод для этого задания? Объясни первый шаг, без итогового ответа.'});
    assert.equal(chat.kind, 'message', 'Вопрос должен получить объяснение, а не оценку.');
    assert.ok(typeof chat.message === 'string' && chat.message.trim());
    console.log('PASS: реальный ответ ассистента по текущему заданию:', chat.message);
    console.log('Время операций:', JSON.stringify(operations));
    console.log('Это проверка одного примера, а не измерение общей точности модели. Вычисления в условии нужно оценить независимо.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});
  }
}
