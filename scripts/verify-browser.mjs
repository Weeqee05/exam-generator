import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createApp} from '../server.mjs';

// A separate keyless server keeps browser tests away from real AI and history.
const server=createApp({settings:{}});
server.listen(0,'127.0.0.1');
await once(server,'listening');
const child=spawn('python',['tests/browser.py'],{
  stdio:'inherit',
  env:{...process.env,TEST_BASE_URL:`http://127.0.0.1:${server.address().port}`}
});
for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>child.kill(signal));
try {
  const [code,signal]=await once(child,'exit');
  process.exitCode=code ?? (signal ? 1 : 0);
} catch {
  console.error('Для проверки нужен Python 3, Playwright и Chromium. Инструкция — в README.');
  process.exitCode=1;
} finally {
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
}
