import {request} from 'node:http';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {createApp, configureRuntimeProxy, loadProviderSettings} from '../server.mjs';

// Explicit live smoke test: one real generation, with credentials from the
// server connection settings only. This command is intentionally outside `npm test`.
const settings = await loadProviderSettings();
if (!settings.LLM_API_KEY?.trim()) {
  console.error('Не задан секрет LLM_API_KEY. Добавь его в защищённые настройки среды или сервера.');
  process.exitCode = 1;
} else {
  configureRuntimeProxy(settings);
  const server = createApp({settings});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const input = JSON.stringify({config: {topic: 'complex', level: 'easy', count: 1}, variantId: 1});
    const result = await new Promise((resolve, reject) => {
      // Local application request; the provider request inside createApp uses
      // the configured HTTPS proxy and retains certificate verification.
      const req = request({host: '127.0.0.1', port: server.address().port, path: '/api/generate', method: 'POST', agent: false, headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(input)}, timeout: 60000}, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {text += chunk; if (text.length > 200000) res.destroy(new Error('Слишком большой ответ приложения.'));});
        res.on('error', reject);
        res.on('end', () => {
          try {
            const data = JSON.parse(text);
            if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}: ${data.error || 'Не удалось создать вариант.'}`));
            else resolve(data.result);
          } catch {reject(new Error('Приложение вернуло неверный JSON.'));}
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('Истекло время проверки.')));
      req.end(input);
    });
    assert.equal(result.topic, 'complex');
    assert.equal(result.difficulty, 'easy');
    assert.equal(result.tasks.length, 1);
    for (const name of ['type', 'question', 'hint', 'answer', 'explanation']) assert.ok(result.tasks[0][name]?.trim());
    console.log('PASS: реальная генерация через сервер; одно задание, параметры и структура ответа проверены.');
    console.log('Условие:', result.tasks[0].question.slice(0, 500));
    console.log('Ответ:', result.tasks[0].answer.slice(0, 300));
    console.log('Правильность решения оценивается отдельно; проверка формата её не гарантирует.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});
  }
}
