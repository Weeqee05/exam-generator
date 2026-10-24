import assert from 'node:assert/strict';
import {test} from 'node:test';
import {once} from 'node:events';
import * as http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp, loadProviderSettings} from '../server.mjs';
import {displayModelTasks, validateModelResult} from '../dist/ai.mjs';
import {exportVariant} from '../dist/export.mjs';
import {makeTasks} from '../dist/generator.mjs';

const config={topic:'complex',level:'easy',count:1};
const result={topic:'complex',difficulty:'easy',tasks:[{type:'Сложение',question:'Найди 1 + i + 2 + i.',hint:'Сложи действительные части.',answer:'3 + 2i',explanation:'1 + 2 = 3, i + i = 2i.'}]};
const settings={LLM_API_KEY:'test-only-not-a-real-key',LLM_MODEL:'test-model',LLM_BASE_URL:'https://example.invalid/v1'};
const answer=(data=result)=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(data)}}]}),{headers:{'Content-Type':'application/json'}});
const qwenSettings={LLM_API_KEY:'test-only-not-a-real-key',LLM_BASE_URL:'https://sharellm.net/v1',LLM_MODEL:'qwen3.8-flash'};
const event=(data,ending='\n')=>'data: '+JSON.stringify(data)+ending+ending;
const textEvent=(content,finish_reason=null)=>event({choices:[{delta:{content},finish_reason}]});
function streamed(chunks) {
  let index=0;
  return new Response(new ReadableStream({pull(controller){
    if(index===chunks.length)controller.close();
    else {const chunk=chunks[index++];controller.enqueue(typeof chunk==='string'?Buffer.from(chunk):chunk);}
  }}),{headers:{'Content-Type':'text/event-stream; charset=utf-8'}});
}

test('math renderer and fonts are served locally with no access to private files',async t=>{
  const app=await running(t);
  for(const path of ['/format.mjs','/vendor/katex/katex.mjs','/vendor/katex/katex.min.css','/vendor/katex/fonts/KaTeX_Main-Regular.woff2']) {
    const response=await app.get(path);assert.equal(response.status,200,path);
    assert.ok((await response.arrayBuffer()).byteLength>100);
  }
  for(const path of ['/vendor/katex/fonts/KaTeX_missing.woff2','/vendor/katex/.env.connection.json','/vendor/katex/fonts/../../server.mjs']) assert.equal((await app.get(path)).status,404);
});

async function running(t, options={}) {
  const server=createApp({settings:{},...options});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const base=`http://127.0.0.1:${server.address().port}`;
  let cookie='';
  async function request(path,options={}) {
    const response=await fetch(base+path,{...options,headers:{...(cookie?{Cookie:cookie}:{}),...options.headers}});
    const setCookie=response.headers.get('set-cookie');
    if(setCookie)cookie=setCookie.split(';')[0];
    return response;
  }
  return {
    get:path=>request(path),
    post:(data={config,variantId:1},headers={})=>request('/api/generate',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(data)}),
    task:(id,action,data={})=>request('/api/tasks/'+id+'/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
  };
}

function assertPublicVariant(data,expected) {
  assert.ok(data.variant?.id);
  assert.deepEqual(data.variant.config,{topic:expected.topic,level:expected.difficulty,count:expected.tasks.length});
  assert.equal(data.variant.source,'ai');
  assert.equal(data.variant.tasks.length,expected.tasks.length);
  data.variant.tasks.forEach((task,index)=>{
    assert.equal(task.question,expected.tasks[index].question);
    assert.equal(task.tag,expected.tasks[index].type);
    for(const privateField of ['answer','explanation','proof','hint','result'])assert.ok(!Object.hasOwn(task,privateField),privateField+' must stay on the server');
  });
}

test('ordinary site works without credentials and does not expose configuration',async t=>{
  const app=await running(t);
  assert.deepEqual(await (await app.get('/api/status')).json(),{aiAvailable:false});
  for(const path of ['/','/styles.css','/app.mjs','/generator.mjs','/ai.mjs','/export.mjs']) {
    const response=await app.get(path);assert.equal(response.status,200);assert.ok((await response.text()).length>100);
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  }
  for(const path of ['/.env','/.env.connection.json','/server.mjs','/package.json','/%2e%2e/server.mjs','/dist/../.env'])assert.equal((await app.get(path)).status,404);
  const unavailable=await app.post();assert.equal(unavailable.status,503);assert.match((await unavailable.json()).error,/пока не подключён/);
});

test('embedded preview changes only the framing policy for static and JSON responses',async t=>{
  const ordinary=await running(t);
  const normalResponse=await ordinary.get('/');
  const normalPolicy=normalResponse.headers.get('content-security-policy');
  assert.match(normalPolicy,/frame-ancestors 'none'/);
  const directives=policy=>policy.split(';').map(value=>value.trim()).filter(Boolean);
  const expected=directives(normalPolicy).filter(value=>!value.startsWith('frame-ancestors '));
  const preview=await running(t,{settings:{EMBEDDED_PREVIEW:'1'}});
  for(const path of ['/','/api/status','/missing']) {
    const response=await preview.get(path);
    const policy=response.headers.get('content-security-policy');
    assert.ok(!policy.includes('frame-ancestors'));
    assert.deepEqual(directives(policy),expected);
    for(const name of ['x-content-type-options','referrer-policy'])assert.equal(response.headers.get(name),normalResponse.headers.get(name));
  }
  const crossOrigin=await preview.post({config,variantId:1},{Origin:'https://evil.invalid'});
  assert.equal(crossOrigin.status,403);
  assert.deepEqual(directives(crossOrigin.headers.get('content-security-policy')),expected);
  // Opting in one instance must not mutate the default policy used by another.
  assert.equal((await ordinary.get('/api/status')).headers.get('content-security-policy'),normalPolicy);
});

test('embedded preview requires the explicit string flag',async t=>{
  for(const value of [undefined,'0',false,true,1,'true']) {
    const app=await running(t,{settings:{EMBEDDED_PREVIEW:value}});
    for(const path of ['/','/api/status'])assert.match((await app.get(path)).headers.get('content-security-policy'),/frame-ancestors 'none'/);
  }
});

test('model request uses server credentials and public generation withholds the reference answer',async t=>{
  let received;
  const app=await running(t,{settings,fetchModel:async(url,init)=>{received={url,init};return answer();}});
  assert.deepEqual(await(await app.get('/api/status')).json(),{aiAvailable:true});
  const response=await app.post();assert.equal(response.status,200);
  const data=await response.json();assertPublicVariant(data,result);
  const solution=await app.task(data.variant.tasks[0].id,'solution');
  assert.deepEqual(await solution.json(),{answer:result.tasks[0].answer,explanation:result.tasks[0].explanation});
  assert.equal(received.url,'https://example.invalid/v1/chat/completions');
  assert.equal(received.init.headers.Authorization,'Bearer '+settings.LLM_API_KEY);
  const body=JSON.parse(received.init.body);assert.equal(body.model,'test-model');assert.match(body.messages[1].content,/Комплексные числа/);
  assert.equal(body.stream,false);assert.equal(received.init.redirect,'error');
  assert.ok(!JSON.stringify(await(await app.get('/api/status')).json()).includes(settings.LLM_API_KEY));
});

test('invalid inputs, content types and cross-origin requests do not call the provider',async t=>{
  let calls=0;
  const app=await running(t,{settings,fetchModel:async()=>{calls++;return answer();}});
  assert.equal((await app.post({config:{...config,count:11},variantId:1})).status,400);
  assert.equal((await app.post({config,variantId:0})).status,400);
  assert.equal((await app.post({config,variantId:1,source:'unknown'})).status,400);
  assert.equal((await app.post(null)).status,400);
  assert.equal((await app.post({padding:'x'.repeat(5000)})).status,413);
  assert.equal((await app.post({}, {'Content-Type':'text/plain'})).status,415);
  assert.equal((await app.post({config,variantId:1},{Origin:'https://evil.invalid'})).status,403);
  assert.equal((await app.post({config,variantId:1},{'Sec-Fetch-Site':'cross-site'})).status,403);
  assert.equal(calls,0);
});

test('provider failures are useful and never leak credentials or provider response bodies',async t=>{
  for(const code of [401,402,403,404,429,500,524])await t.test(String(code),async t=>{
    const app=await running(t,{settings,fetchModel:async()=>new Response('provider secret '+settings.LLM_API_KEY,{status:code})});
    const response=await app.post();assert.equal(response.status,code===524?504:code===429?429:502);
    const text=await response.text();assert.ok(!text.includes(settings.LLM_API_KEY));assert.match(text,/error/);
  });
});

test('Gemini defaults only require a server key and custom providers require a model',async t=>{
  let received;
  const app=await running(t,{settings:{LLM_API_KEY:'test-only-not-a-real-key'},fetchModel:async(url,init)=>{received={url,init};return answer();}});
  assert.deepEqual(await(await app.get('/api/status')).json(),{aiAvailable:true});
  assert.equal((await app.post()).status,200);
  assert.equal(received.url,'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(JSON.parse(received.init.body).model,'gemini-3.1-flash-lite');
  assert.equal(JSON.parse(received.init.body).stream,false);
  const custom=await running(t,{settings:{LLM_API_KEY:'test-only',LLM_BASE_URL:'https://example.invalid/v1'}});
  assert.deepEqual(await(await custom.get('/api/status')).json(),{aiAvailable:false});
});

test('streaming is requested only for the selected Qwen endpoint',async t=>{
  for(const other of [{...settings,LLM_MODEL:'qwen3.8-flash'},{...settings,LLM_BASE_URL:'https://sharellm.net/v1'}]) {
    let body;
    const app=await running(t,{settings:other,fetchModel:async(_url,init)=>{body=JSON.parse(init.body);return answer();}});
    assert.equal((await app.post()).status,200);
    assert.equal(body.stream,false);
  }
});

test('Qwen SSE handles split UTF-8, CRLF and multiline data while excluding reasoning',async t=>{
  const unicodeResult={...result,tasks:[{...result.tasks[0],question:'Вычисли сумму 1 + i + 2 + i. 🧮'}]};
  const content=JSON.stringify(unicodeResult);
  const boundary=content.indexOf('🧮')+1;
  const first=JSON.stringify({choices:[{delta:{content:content.slice(0,boundary)}}]},null,2).split('\n').map(line=>'data: '+line).join('\r\n')+'\r\n\r\n';
  const privateReasoning='private reasoning '+qwenSettings.LLM_API_KEY;
  const wire=': keepalive\r\n\r\n'
    +'event: message\r\n'+event({choices:[{delta:{role:'assistant',reasoning_content:privateReasoning}}]},'\r\n')
    +first
    +'id: ignored\r'+event({choices:[{delta:{content:content.slice(boundary)}}]},'\r')
    +event({choices:[],usage:{total_tokens:100}})
    +textEvent('', 'stop')
    +'data: [DONE]\r\n\r\n';
  const bytes=Buffer.from(wire);
  // One-byte network chunks deliberately split both UTF-8 characters and SSE boundaries.
  const chunks=Array.from(bytes,byte=>Uint8Array.of(byte));
  let requested;
  const app=await running(t,{settings:{...qwenSettings,LLM_MODEL:'qwen3.8-27b'},fetchModel:async(_url,init)=>{requested=JSON.parse(init.body);return streamed(chunks);}});
  const response=await app.post();
  assert.equal(response.status,200);
  const data=await response.json();assertPublicVariant(data,unicodeResult);
  assert.equal(requested.stream,true);
  assert.ok(!JSON.stringify(data).includes(privateReasoning));
});

test('incomplete, invalid, error and truncated SSE responses cannot become accepted variants',async t=>{
  const content=JSON.stringify(result);
  const complete=textEvent(content,'stop');
  const secret='private '+qwenSettings.LLM_API_KEY;
  const cases=[
    [complete],
    ['data: not-json\n\ndata: [DONE]\n\n'],
    [event({error:{message:secret}})+'data: [DONE]\n\n'],
    ['event: error\n'+event({message:secret})+'data: [DONE]\n\n'],
    [textEvent(content,'length')+'data: [DONE]\n\n'],
    ['data: [DONE]\n\n'],
    [complete+'data: [DONE]\n'],
    [complete+event({choices:[null]})+'data: [DONE]\n\n'],
    [complete+event({choices:[{delta:'invalid'}]})+'data: [DONE]\n\n'],
    [Uint8Array.of(0xc3,0x28)]
  ];
  for(const chunks of cases) {
    const app=await running(t,{settings:qwenSettings,fetchModel:async()=>streamed(chunks)});
    const response=await app.post();assert.equal(response.status,502);
    assert.ok(!(await response.text()).includes(qwenSettings.LLM_API_KEY));
  }
});

test('stream size limits and errors during body reading preserve useful status codes',async t=>{
  const oversizedRaw=event({choices:[{delta:{reasoning_content:'x'.repeat(2*1024*1024)}}]});
  const oversizedContent=textEvent('я'.repeat(100001));
  for(const wire of [oversizedRaw,oversizedContent]) {
    const app=await running(t,{settings:qwenSettings,fetchModel:async()=>streamed([wire])});
    const response=await app.post();assert.equal(response.status,413);
    assert.ok(!(await response.text()).includes(qwenSettings.LLM_API_KEY));
  }
  for(const name of ['TimeoutError','AbortError','TypeError']) {
    const app=await running(t,{settings:qwenSettings,fetchModel:async()=>new Response(new ReadableStream({pull(controller){controller.error(new DOMException('private '+qwenSettings.LLM_API_KEY,name));}}),{headers:{'Content-Type':'text/event-stream'}})});
    const response=await app.post();assert.equal(response.status,name==='TypeError'?502:504);
    assert.ok(!(await response.text()).includes(qwenSettings.LLM_API_KEY));
  }
});

test('imported New API connection works with a root URL and overrides incorrect environment fields',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'praktikum-connection-'));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  const path=join(folder,'.env.connection.json');
  const imported={_type:'newapi_channel_conn',url:'https://sharellm.net/',key:'local-test-key'};
  await writeFile(path,JSON.stringify(imported));
  const loaded=await loadProviderSettings({...settings,LLM_BASE_URL:'incorrect-value',HOST:'127.0.0.1'},path);
  let received;
  const app=await running(t,{settings:loaded,fetchModel:async(url,init)=>{received={url,init};return answer();}});
  assert.equal((await app.post()).status,200);
  assert.equal(received.url,'https://sharellm.net/v1/chat/completions');
  assert.equal(received.init.headers.Authorization,'Bearer '+imported.key);
  assert.equal(JSON.parse(received.init.body).model,'qwen3.8-27b');
  assert.equal(JSON.parse(received.init.body).stream,true);
  assert.equal(loaded.HOST,'127.0.0.1');
  assert.deepEqual(await loadProviderSettings(settings,join(folder,'missing.json')),settings);
  assert.equal((await app.get('/.env.connection.json')).status,404);
});

test('imported Gemini connection selects its default model and stays server-only',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'gemini-connection-'));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  const path=join(folder,'.env.connection.json');
  await writeFile(path,JSON.stringify({_type:'newapi_channel_conn',url:'https://generativelanguage.googleapis.com/v1beta/openai/',key:'gemini-test-key'}));
  const loaded=await loadProviderSettings({...settings,LLM_MODEL:'old-provider-model'},path);
  let received;
  const app=await running(t,{settings:loaded,fetchModel:async(url,init)=>{received={url,init};return answer();}});
  const response=await app.post();assert.equal(response.status,200);
  const data=await response.json();assertPublicVariant(data,result);
  assert.equal(received.url,'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(JSON.parse(received.init.body).model,'gemini-3.1-flash-lite');
  assert.equal(received.init.headers.Authorization,'Bearer gemini-test-key');
  assert.ok(!JSON.stringify(data).includes('gemini-test-key'));
});

test('invalid imported connections fail without exposing their contents',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'praktikum-connection-'));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  const path=join(folder,'.env.connection.json');
  const connection={_type:'newapi_channel_conn',url:'https://sharellm.net',key:'private-test-value'};
  for(const data of ['malformed '+connection.key,JSON.stringify({...connection,url:'http://sharellm.net'}),JSON.stringify({...connection,url:'https://user:password@sharellm.net'}),JSON.stringify({...connection,model:3}),JSON.stringify({...connection,key:''})]) {
    await writeFile(path,data);
    await assert.rejects(()=>loadProviderSettings(settings,path),error=>error.message.includes('.env.connection.json')&&!error.message.includes(connection.key)&&!error.message.includes('password'));
  }
});

test('ShareLLM router and model configuration errors are explicit and redact provider messages',async t=>{
  for(const [code,status,expected] of [['auto_router_disabled',503,/Auto Model Router/],['model_not_supported',502,/модель недоступна/],['model_not_found',502,/модель недоступна/]]) {
    const app=await running(t,{settings,fetchModel:async()=>new Response(JSON.stringify({error:{code,message:'private '+settings.LLM_API_KEY}}),{status:code==='auto_router_disabled'?503:400})});
    const response=await app.post();assert.equal(response.status,status);
    const text=await response.text();assert.match(text,expected);assert.ok(!text.includes(settings.LLM_API_KEY));
  }
  const unavailable=await running(t,{settings,fetchModel:async()=>new Response(JSON.stringify({error:{code:'503',message:'private '+settings.LLM_API_KEY}}),{status:503})});
  const response=await unavailable.post();assert.equal(response.status,503);assert.match((await response.json()).error,/временно недоступен/);
});

test('compatible gateway JSON fences are accepted, but truncated output is rejected',async t=>{
  const content='```json\n'+JSON.stringify(result)+'\n```';
  const app=await running(t,{settings,fetchModel:async()=>new Response(JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]}))});
  assertPublicVariant(await(await app.post()).json(),result);
  const truncated=await running(t,{settings,fetchModel:async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(result)},finish_reason:'length'}]}))});
  assert.equal((await truncated.post()).status,502);
  const failed=await running(t,{settings,fetchModel:async()=>{throw new TypeError('private upstream connection detail');}});
  const response=await failed.post();assert.equal(response.status,502);
  assert.ok(!(await response.text()).includes('private upstream'));
});

test('runtime proxy settings are honored by fetch without contacting an external host',async t=>{
  if(typeof http.setGlobalProxyFromEnv!=='function'){t.skip('Native runtime proxy support requires Node.js 24.5+');return;}
  let destination;
  const proxy=http.createServer((req,res)=>{destination=req.url;res.writeHead(200,{'Content-Type':'application/json'});res.end('{"proxied":true}');});
  const tunnels=new Set();
  proxy.on('connect',(req,socket,head)=>{
    destination=req.url;tunnels.add(socket);socket.on('close',()=>tunnels.delete(socket));
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const reply=()=>{const body='{"proxied":true}';socket.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: '+Buffer.byteLength(body)+'\r\nConnection: close\r\n\r\n'+body);};
    if(head.length)reply();else socket.once('data',reply);
  });
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
  t.after(()=>new Promise(resolve=>{for(const socket of tunnels)socket.destroy();proxy.close(resolve);proxy.closeAllConnections();}));
  const proxyUrl='http://127.0.0.1:'+proxy.address().port;
  const source=`import {configureRuntimeProxy} from ${JSON.stringify(new URL('../server.mjs',import.meta.url).href)};
    configureRuntimeProxy({HTTP_PROXY:${JSON.stringify(proxyUrl)},HTTPS_PROXY:${JSON.stringify(proxyUrl)},NO_PROXY:''});
    const response=await fetch('http://proxy-check.invalid/test');
    console.log(JSON.stringify(await response.json()));`;
  const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','pipe'],timeout:10000});
  let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const [code]=await once(child,'close');assert.equal(code,0,stderr);
  assert.deepEqual(JSON.parse(stdout),{proxied:true});
  assert.ok(['http://proxy-check.invalid/test','proxy-check.invalid:80'].includes(destination));
});

test('invalid or excessively large model output leaves no accepted variant',async t=>{
  for(const data of [{...result,topic:'sets'},{...result,tasks:[]},{...result,tasks:[{...result.tasks[0],answer:''}]}]) {
    const app=await running(t,{settings,fetchModel:async()=>answer(data)});
    assert.equal((await app.post()).status,502);
    assert.deepEqual(await(await app.get('/api/history')).json(),{variants:[]});
  }
  const app=await running(t,{settings,fetchModel:async()=>new Response('x'.repeat(210000))});
  assert.equal((await app.post()).status,413);
});

test('network timeouts, rate limits and insecure provider URLs are handled',async t=>{
  const timeout=await running(t,{settings,fetchModel:async()=>{throw new DOMException('timed out','TimeoutError');}});
  assert.equal((await timeout.post()).status,504);
  const rate=await running(t,{settings,fetchModel:async()=>answer()});
  for(let i=0;i<10;i++)assert.equal((await rate.post()).status,200);
  assert.equal((await rate.post()).status,429);
  const insecure=await running(t,{settings:{...settings,LLM_BASE_URL:'http://example.invalid/v1'}});
  assert.deepEqual(await(await insecure.get('/api/status')).json(),{aiAvailable:false});
});

test('model text is escaped and duplicate questions are rejected',()=>{
  const malicious={...result,tasks:[{...result.tasks[0],question:'<img src=x onerror="alert(1)"> & текст'}]};
  const task=displayModelTasks(malicious,config)[0];assert.ok(!task.question.includes('<img'));assert.match(task.question,/&lt;img/);
  assert.throws(()=>validateModelResult({...result,tasks:[result.tasks[0],{...result.tasks[0],question:result.tasks[0].question.toUpperCase()}]},{...config,count:2}));
});

test('download includes the current worksheet and answers only on request',()=>{
  const variant={id:1,seed:42,config,source:'local',created:'2026-10-21T10:00:00Z'};
  const tasks=makeTasks(config,42);
  const blank=exportVariant(variant,tasks);assert.match(blank,/ЗАДАНИЕ 1/);assert.ok(!blank.includes('Ответ:'));assert.ok(!/<\/?(?:span|pre|code|sup)>/.test(blank));
  const full=exportVariant(variant,tasks,true);assert.match(full,/Ответ:/);assert.match(full,/Решение:/);
});

test('local model profiles load independently and reject malformed profiles without exposing keys',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'model-profiles-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const path=join(folder,'.env.connection.json');
  const connection={_type:'newapi_channel_conn',url:'https://generativelanguage.googleapis.com/v1beta/openai',key:'gemini-profile-key',providers:{qwen:{url:'https://sharellm.net',key:'qwen-profile-key'}}};
  await writeFile(path,JSON.stringify(connection));const loaded=await loadProviderSettings({},path);
  assert.equal(loaded.LLM_API_KEY,'gemini-profile-key');assert.equal(loaded.QWEN_API_KEY,'qwen-profile-key');
  assert.equal(loaded.QWEN_MODEL,'qwen3.8-27b');assert.equal(loaded.QWEN_BASE_URL,'https://sharellm.net/v1');
  const app=await running(t,{settings:loaded});const response=await app.get('/api/models');
  const data=await response.json();assert.equal(data.providers.find(p=>p.id==='qwen').available,true);
  assert.ok(!JSON.stringify(data).includes('profile-key'));
  connection.providers.qwen.url='http://invalid.example';await writeFile(path,JSON.stringify(connection));
  await assert.rejects(()=>loadProviderSettings({},path),e=>!e.message.includes('profile-key'));
});
