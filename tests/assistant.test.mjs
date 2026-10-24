import assert from 'node:assert/strict';
import {test} from 'node:test';
import {once} from 'node:events';
import {createApp} from '../server.mjs';

const config={topic:'complex',level:'easy',count:1};
const settings={LLM_API_KEY:'test-key-not-real',LLM_BASE_URL:'https://example.invalid/v1',LLM_MODEL:'test-model'};
const reference={type:'Доля',question:'Вычисли 1 / 2.',hint:'Дробь можно записать десятичным числом.',answer:'1/2',explanation:'Деление единицы на два даёт половину.'};
const generated=(tasks=[reference],parameters=config)=>({topic:parameters.topic,difficulty:parameters.level,tasks});
const modelResponse=data=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(data)},finish_reason:'stop'}]}),{headers:{'Content-Type':'application/json'}});

async function harness(t,options={}) {
  const server=createApp({settings:{},...options});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const base=`http://127.0.0.1:${server.address().port}`;
  function client() {
    let cookie='';
    async function request(path,options={}) {
      const response=await fetch(base+path,{...options,headers:{...(cookie?{Cookie:cookie}:{}),...options.headers}});
      const setCookie=response.headers.get('set-cookie');
      if(setCookie)cookie=setCookie.split(';')[0];
      return response;
    }
    return {
      get:path=>request(path),
      post:(path,data={})=>request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}),
      generate:(source='local',parameters=config,number=1)=>request('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source,config:parameters,variantId:number})}),
      action:(id,action,data={})=>request(`/api/tasks/${id}/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
    };
  }
  return {client,server};
}

function publicOnly(variant) {
  assert.ok(typeof variant.id==='string' && variant.id.length>20);
  assert.ok(variant.tasks.length);
  for(const task of variant.tasks) {
    assert.equal(typeof task.id,'string');
    assert.equal(typeof task.question,'string');
    for(const name of ['answer','explanation','hint','proof','result'])assert.ok(!Object.hasOwn(task,name),name+' must remain private');
  }
}

test('a JSON number from the model becomes a private reference and can be checked without another AI call',async t=>{
  let calls=0;const parameters={...config,topic:'algebra'};
  const numeric={...reference,question:'Вычисли сумму 2 + 3.',answer:5,explanation:'2 + 3 = 5.'};
  const app=(await harness(t,{settings,fetchModel:async()=>{calls++;return modelResponse(generated([numeric],parameters));}})).client();
  const response=await app.generate('ai',parameters);assert.equal(response.status,200);
  const {variant}=await response.json();publicOnly(variant);
  const checked=await(await app.action(variant.tasks[0].id,'respond',{message:'5,0'})).json();
  assert.equal(checked.verdict,'correct');assert.equal(checked.method,'code');assert.equal(calls,1);
  const revealed=await(await app.action(variant.tasks[0].id,'solution')).json();assert.equal(revealed.answer,'5');
});

test('a question without an AI key receives guidance rather than a missing-answer grade',async t=>{
  const app=(await harness(t)).client();const {variant}=await(await app.generate()).json();
  const result=await(await app.action(variant.tasks[0].id,'respond',{message:'Как начать решение?'})).json();
  assert.equal(result.kind,'message');assert.ok(!Object.hasOwn(result,'verdict'));assert.match(result.message,/подключённая модель/);
});

test('physics responses compare equivalent units without spending extra model calls',async t=>{
  let calls=0;
  const parameters={...config,topic:'physics'};
  const measured={...reference,question:'Найди длину отрезка в метрах.',answer:'2 м',hint:'В одном метре сто сантиметров.',explanation:'Длина отрезка равна двум метрам.'};
  const app=(await harness(t,{settings,fetchModel:async()=>{calls++;return modelResponse(generated([measured],parameters));}})).client();
  const {variant}=await(await app.generate('ai',parameters)).json();
  const id=variant.tasks[0].id;
  for(const message of ['200 см','Я получил 0,002 км']){
    const feedback=await(await app.action(id,'respond',{message})).json();
    assert.equal(feedback.kind,'feedback');assert.equal(feedback.verdict,'correct');assert.equal(feedback.method,'code');
  }
  assert.equal((await(await app.action(id,'respond',{message:'2 с'})).json()).verdict,'incorrect');
  const clarify=await(await app.action(id,'check',{answer:'2'})).json();
  assert.equal(clarify.verdict,'clarify');assert.match(clarify.explanation,/единицах/);
  assert.equal(calls,1);
});

test('polite explicit commands open a solution or hint without a classifier, while negation remains chat',async t=>{
  let calls=0;
  const app=(await harness(t,{settings,fetchModel:async()=>modelResponse(++calls===1?generated():{intent:'chat',message:'Хорошо, разберём только следующий шаг.'})})).client();
  const {variant}=await(await app.generate('ai')).json();const id=variant.tasks[0].id;
  const solution=await(await app.action(id,'respond',{message:'Можешь показать мне решение?'})).json();
  assert.equal(solution.kind,'solution');assert.equal(solution.answer,reference.answer);
  assert.equal((await(await app.action(id,'respond',{message:'Можете дать мне подсказку?'})).json()).kind,'message');
  assert.equal(calls,1);
  const chat=await(await app.action(id,'respond',{message:'Можешь не показывать решение?'})).json();
  assert.equal(chat.kind,'message');assert.ok(!Object.hasOwn(chat,'answer'));assert.equal(calls,2);
});

test('failed automatic grading can be retried without duplicating a submitted attempt in history',async t=>{
  let calls=0;
  const app=(await harness(t,{settings,fetchModel:async()=>{
    calls++;
    if(calls===1)return modelResponse(generated());
    if(calls===2||calls===4)return modelResponse({intent:'answer'});
    if(calls===3)return new Response('Unavailable',{status:503});
    return modelResponse({verdict:'correct',explanation:'Способ решения верный.',error:'',hint:''});
  }})).client();
  const {variant}=await(await app.generate('ai')).json();const id=variant.tasks[0].id;
  const message='Я разделил числитель на знаменатель и получил половину.';
  assert.equal((await app.action(id,'respond',{message})).status,503);
  const afterError=(await(await app.get('/api/history')).json()).variants[0];
  assert.deepEqual(afterError.solved,[false]);assert.deepEqual(afterError.tasks[0].chat,[]);
  const retried=await(await app.action(id,'respond',{message})).json();assert.equal(retried.verdict,'correct');
  const history=(await(await app.get('/api/history')).json()).variants[0];publicOnly(history);
  assert.equal(history.tasks[0].chat.filter(item=>item.role==='user'&&item.content===message).length,1);
  assert.match(history.tasks[0].chat[1].content,/Оценка ИИ/);assert.deepEqual(history.solved,[true]);
});

test('custom practice retains its subject through checking, conversation, history and similar tasks',async t=>{
  const parameters={topic:'custom',customTopic:'  Вероятность — честная монета  ',level:'easy',count:1,untrustedExtra:'must not persist'};
  const normalized={topic:'custom',customTopic:parameters.customTopic.trim(),level:'easy',count:1};
  const requests=[];
  const app=(await harness(t,{settings,fetchModel:async(url,options)=>{
    requests.push(JSON.parse(options.body));
    return modelResponse([
      generated([reference],normalized),
      {intent:'chat',message:'Сначала посчитай равновозможные исходы.'},
      generated([{...reference,question:'Вычисли вероятность выпадения орла у честной монеты.'}],normalized)
    ][requests.length-1]);
  }})).client();
  const response=await app.generate('ai',parameters);
  assert.equal(response.status,200);
  const {variant}=await response.json();publicOnly(variant);assert.deepEqual(variant.config,normalized);
  assert.ok(requests[0].messages[1].content.includes(normalized.customTopic));
  const id=variant.tasks[0].id;
  assert.equal((await(await app.action(id,'respond',{message:'1'})).json()).verdict,'incorrect');
  assert.equal((await(await app.action(id,'respond',{message:'0,5'})).json()).verdict,'correct');
  assert.equal((await(await app.action(id,'hint')).json()).message,reference.hint);
  const chat=await(await app.action(id,'respond',{message:'Как найти число исходов?'})).json();
  assert.equal(chat.kind,'message');assert.match(chat.message,/исходы/);
  const history=await(await app.get('/api/history')).json();publicOnly(history.variants[0]);
  assert.deepEqual(history.variants[0].config,normalized);assert.deepEqual(history.variants[0].solved,[true]);
  const solution=await(await app.action(id,'solution')).json();assert.equal(solution.answer,reference.answer);
  const similar=await(await app.action(id,'similar')).json();publicOnly(similar.variant);
  assert.deepEqual(similar.variant.config,normalized);assert.equal(similar.variant.source,'ai');
  assert.ok(requests[2].messages[1].content.includes(normalized.customTopic));
  assert.equal(requests.length,3);
});

test('new preset subjects use AI and cannot accidentally fall through to missing local templates',async t=>{
  const app=(await harness(t,{settings,fetchModel:async(url,options)=>{
    const body=JSON.parse(options.body);
    const topic=JSON.parse(body.messages[1].content.match(/\{[\s\S]*\}/)[0]).topic;
    return modelResponse(generated([reference],{...config,topic}));
  }})).client();
  for (const topic of ['algebra','calculus','linear','probability','sql','physics','history']) {
    const response=await app.generate('ai',{...config,topic});assert.equal(response.status,200,topic);
    const {variant}=await response.json();publicOnly(variant);assert.equal(variant.config.topic,topic);
  }
  const unsupported=await app.generate('local',{...config,topic:'physics'});
  assert.equal(unsupported.status,400);assert.match((await unsupported.json()).error,/ИИ-ассистента/);
});

test('custom generation validates the subject and gives a useful error without an API key',async t=>{
  let calls=0;
  const app=(await harness(t,{fetchModel:async()=>{calls++;throw Error('no model call expected');}})).client();
  const parameters={...config,topic:'custom',customTopic:'Биология'};
  assert.equal((await app.generate('local',parameters)).status,400);
  assert.equal((await app.generate('ai',parameters)).status,503);
  for (const customTopic of ['', ' ', 'a'.repeat(161), 'История\nдругая строка', null]) assert.equal((await app.generate('ai',{...parameters,customTopic})).status,400);
  assert.equal(calls,0);assert.equal((await(await app.get('/api/history')).json()).variants.length,0);
});

test('ordinary generation is server-side and history restores only public task data',async t=>{
  let calls=0;
  const app=(await harness(t,{fetchModel:async()=>{calls++;throw new Error('must not call model');}})).client();
  const response=await app.generate();assert.equal(response.status,200);
  const cookie=response.headers.get('set-cookie');
  assert.match(cookie,/HttpOnly/i);assert.match(cookie,/SameSite=Lax/i);assert.match(cookie,/Path=\/api/i);
  const {variant}=await response.json();publicOnly(variant);
  assert.equal(variant.source,'local');assert.deepEqual(variant.config,config);assert.deepEqual(variant.solved,[false]);
  assert.equal(calls,0);
  const history=await(await app.get('/api/history')).json();
  assert.equal(history.variants.length,1);assert.deepEqual(history.variants[0],variant);
  const restored=await(await app.get('/api/variants/'+variant.id)).json();assert.deepEqual(restored,{variant});
  const solution=await app.action(variant.tasks[0].id,'solution');assert.equal(solution.status,200);
  const data=await solution.json();assert.ok(data.answer);assert.ok(data.explanation);
  // Viewing a solution must not mark an exercise as independently solved.
  assert.deepEqual((await(await app.get('/api/variants/'+variant.id)).json()).variant.solved,[false]);
});

test('AI generation withholds reference data until an explicit solution request',async t=>{
  const app=(await harness(t,{settings,fetchModel:async()=>modelResponse(generated())})).client();
  const response=await app.generate('ai');assert.equal(response.status,200);
  const {variant}=await response.json();publicOnly(variant);
  assert.equal(variant.source,'ai');assert.equal(variant.tasks[0].question,reference.question);
  const history=await(await app.get('/api/history')).json();publicOnly(history.variants[0]);
  const hint=await app.action(variant.tasks[0].id,'hint');assert.equal(hint.status,200);
  assert.ok((await hint.json()).message);
  const solution=await(await app.action(variant.tasks[0].id,'solution')).json();
  assert.deepEqual(solution,{answer:reference.answer,explanation:reference.explanation});
});

test('hints, feedback and chat suppress an obvious leaked reference until solution is requested',async t=>{
  const task={type:'Обоснование',question:'Обоснуй количество элементов множества из условия.',hint:'Готовый ответ: 17',answer:'17',explanation:'REFERENCE_FULL_SOLUTION_DO_NOT_DISCLOSE_BEFORE_REQUEST'};
  let calls=0;
  const app=(await harness(t,{settings,fetchModel:async()=>{
    calls++;
    if(calls===1)return modelResponse(generated([task]));
    if(calls===2)return modelResponse({verdict:'incorrect',explanation:'Правильный ответ 17',error:'Нужно получить 17',hint:task.explanation});
    return modelResponse({message:calls===3?'Ответ:17':task.explanation});
  }})).client();
  const response=await app.generate('ai');assert.equal(response.status,200);
  const {variant}=await response.json(),id=variant.tasks[0].id;
  publicOnly(variant);
  function privateReferenceAbsent(data) {
    const text=JSON.stringify(data);
    assert.ok(!text.includes('17'),'obvious reference-answer leak');
    assert.ok(!text.includes(task.explanation),'full reference-solution leak');
  }
  const hint=await app.action(id,'hint');assert.equal(hint.status,200);privateReferenceAbsent(await hint.json());
  const feedback=await app.action(id,'check',{answer:'Я считаю, что элементов чётное количество, но не доказал.'});
  assert.equal(feedback.status,200);privateReferenceAbsent(await feedback.json());
  const chat=await app.action(id,'chat',{message:'Подскажи следующий шаг.'});
  assert.equal(chat.status,200);privateReferenceAbsent(await chat.json());
  const fullSolutionLeak=await app.action(id,'chat',{message:'Можно другую подсказку?'});
  assert.equal(fullSolutionLeak.status,200);privateReferenceAbsent(await fullSolutionLeak.json());
  assert.equal(calls,4,'grading and both kinds of chat leaks were actually exercised');
  const restored=(await(await app.get('/api/variants/'+variant.id)).json()).variant;
  privateReferenceAbsent(restored.tasks[0].chat);
  const solution=await app.action(id,'solution');assert.equal(solution.status,200);
  assert.deepEqual(await solution.json(),{answer:task.answer,explanation:task.explanation});
});

test('a useful mathematical hint is preserved when a formula contains the same digit as the answer',async t=>{
  const task={type:'Степени i',question:'Вычисли i⁴.',hint:'Используй i² = −1.',answer:'1',explanation:'Квадрат числа −1 равен единице.'};
  const app=(await harness(t,{settings,fetchModel:async()=>modelResponse(generated([task]))})).client();
  const {variant}=await(await app.generate('ai')).json();
  const response=await app.action(variant.tasks[0].id,'hint');assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{message:task.hint});
});

test('only an HTTPS embedded preview opts into partitioned third-party session cookies',async t=>{
  for(const [preview,https] of [[false,false],[false,true],[true,false],[true,true]]) {
    const {server}=await harness(t,{settings:preview?{EMBEDDED_PREVIEW:'1'}:{}});
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/history`,{headers:https?{'X-Forwarded-Proto':'https'}:{}});
    assert.equal(response.status,200);
    const cookie=response.headers.get('set-cookie');
    assert.match(cookie,/HttpOnly/i);assert.match(cookie,/Path=\/api/i);
    if(preview && https)assert.match(cookie,/SameSite=None/i);
    else assert.match(cookie,/SameSite=Lax/i);
    assert.equal(/;\s*Secure(?:;|$)/i.test(cookie),https);
    assert.equal(/;\s*Partitioned(?:;|$)/i.test(cookie),preview && https);
  }
});

test('session ownership protects task actions and variant history from another browser',async t=>{
  const site=await harness(t);
  const owner=site.client(),other=site.client();
  const {variant}=await(await owner.generate()).json();
  assert.deepEqual(await(await other.get('/api/history')).json(),{variants:[]});
  assert.equal((await other.get('/api/variants/'+variant.id)).status,404);
  for(const action of ['solution','hint','check','chat','similar']) {
    const response=await other.action(variant.tasks[0].id,action,{answer:'0',message:'Помоги'});
    assert.equal(response.status,404,action);
  }
  assert.equal((await owner.action(variant.tasks[0].id,'solution')).status,200);
});

test('answer checking accepts equivalent fractions and distinguishes wrong and empty answers',async t=>{
  let calls=0;
  const app=(await harness(t,{settings,fetchModel:async()=>{calls++;return modelResponse(generated());}})).client();
  const {variant}=await(await app.generate('ai')).json(),id=variant.tasks[0].id;
  const empty=await app.action(id,'check',{answer:'  \n '});assert.equal(empty.status,400);
  assert.equal(calls,1);
  const wrong=await(await app.action(id,'check',{answer:'0,6'})).json();
  assert.equal(wrong.verdict,'incorrect');assert.equal(wrong.method,'code');assert.ok(wrong.explanation);assert.ok(wrong.hint);
  assert.ok(!Object.hasOwn(wrong,'answer'));assert.ok(!Object.hasOwn(wrong,'solution'));
  const ambiguous=await(await app.action(id,'check',{answer:'0,5 или 0,6'})).json();
  assert.equal(ambiguous.verdict,'clarify');assert.equal(ambiguous.needsClarification,true);
  const equivalent=await(await app.action(id,'check',{answer:'0,5'})).json();
  assert.equal(equivalent.verdict,'correct');assert.equal(equivalent.method,'code');assert.equal(equivalent.needsClarification,false);
  assert.equal(calls,1,'deterministic numerical comparison must not spend model requests');
  const restored=(await(await app.get('/api/variants/'+variant.id)).json()).variant;
  assert.deepEqual(restored.solved,[true]);
});

test('partially correct complex-number answers are not accepted as completely solved',async t=>{
  const task={type:'Сложение',question:'Вычисли (1+i)+(2+i).',hint:'Сложи действительные и мнимые части отдельно.',answer:'3 + 2i',explanation:'Складываем действительные и мнимые части.'};
  const app=(await harness(t,{settings,fetchModel:async()=>modelResponse(generated([task]))})).client();
  const {variant}=await(await app.generate('ai')).json();
  const response=await app.action(variant.tasks[0].id,'check',{answer:'3+7i'});assert.equal(response.status,200);
  const feedback=await response.json();assert.equal(feedback.verdict,'partial');assert.ok(feedback.error);assert.ok(feedback.hint);
  assert.deepEqual((await(await app.get('/api/variants/'+variant.id)).json()).variant.solved,[false]);
});

test('model checking receives the reference and student work, with an explicit clarification result',async t=>{
  const task={type:'Доказательство',question:'Объясни, почему сумма двух чётных целых чисел чётна.',hint:'Представь оба числа через целый множитель 2.',answer:'Сумма имеет вид 2(k+m).',explanation:'Пусть числа равны 2k и 2m. Их сумма 2(k+m) делится на 2.'};
  const student='Я обозначил числа a и b, но не уточнил, какие они.';
  let calls=0,checking;
  const app=(await harness(t,{settings,fetchModel:async(_url,init)=>{
    calls++;if(calls===1)return modelResponse(generated([task]));
    checking=JSON.parse(init.body);
    return modelResponse({verdict:'clarify',explanation:'Уточни, как выражена чётность чисел a и b.',error:'Не указано, что оба числа делятся на 2.',hint:'Запиши a=2k и b=2m, где k и m целые.'});
  }})).client();
  const {variant}=await(await app.generate('ai')).json();
  const response=await app.action(variant.tasks[0].id,'check',{answer:student});assert.equal(response.status,200);
  const feedback=await response.json();assert.equal(feedback.verdict,'clarify');assert.equal(feedback.needsClarification,true);assert.equal(feedback.method,'ai');
  const prompt=JSON.stringify(checking.messages);
  assert.ok(prompt.includes(task.question));assert.ok(prompt.includes(task.answer));assert.ok(prompt.includes(task.explanation));assert.ok(prompt.includes(student));
  assert.ok(!Object.hasOwn(feedback,'answer'));assert.ok(!Object.hasOwn(feedback,'solution'));
});

test('negative model feedback still gives an error and a next-step hint when the model omits them',async t=>{
  const task={type:'Обоснование',question:'Докажи, что сумма двух чётных целых чисел чётна.',hint:'Вырази каждое чётное число через целый множитель 2.',answer:'Сумма равна 2(k+m).',explanation:'Это произведение двух и целого числа.'};
  for(const verdict of ['incorrect','partial']) {
    let calls=0;
    const app=(await harness(t,{settings,fetchModel:async()=>{
      calls++;
      return modelResponse(calls===1?generated([task]):{verdict,explanation:'В рассуждении пропущено важное условие.',error:'',hint:''});
    }})).client();
    const {variant}=await(await app.generate('ai')).json();
    const response=await app.action(variant.tasks[0].id,'check',{answer:'Я сложил два обозначения, но не указал их свойства.'});
    assert.equal(response.status,200);
    const feedback=await response.json();
    assert.equal(feedback.verdict,verdict);assert.ok(feedback.error.trim());assert.ok(feedback.hint.trim());
    assert.ok(!Object.hasOwn(feedback,'answer'));assert.ok(!JSON.stringify(feedback).includes(task.answer));
  }
});

test('task chat remembers earlier messages without sending the reference solution upstream',async t=>{
  const task={type:'Обоснование',question:'Как доказать существование такого отображения?',hint:'Начни с определения области и множества значений.',answer:'REFERENCE_ANSWER_PRIVATE_917',explanation:'REFERENCE_SOLUTION_PRIVATE_853'};
  const requests=[];
  const app=(await harness(t,{settings,fetchModel:async(_url,init)=>{
    requests.push(JSON.parse(init.body));
    if(requests.length===1)return modelResponse(generated([task]));
    return modelResponse({message:requests.length===2?'Сначала определи, откуда и куда идут элементы.':'Начни с маленького примера отображения.'});
  }})).client();
  const {variant}=await(await app.generate('ai')).json(),id=variant.tasks[0].id;
  assert.equal((await app.action(id,'chat',{message:'Что выбрать первым?'})).status,200);
  const second=await app.action(id,'chat',{message:'Объясни проще',action:'simpler'});assert.equal(second.status,200);
  assert.ok((await second.json()).message);
  assert.equal(requests.length,3);
  for(const request of requests.slice(1)) {
    const prompt=JSON.stringify(request.messages);
    assert.ok(prompt.includes(task.question));
    assert.ok(!prompt.includes(task.answer));assert.ok(!prompt.includes(task.explanation));
  }
  const last=JSON.stringify(requests[2].messages);
  assert.ok(last.includes('Что выбрать первым?'));assert.ok(last.includes('Сначала определи'));
  assert.ok(last.includes('Объясни проще'));
  const hint=await app.action(id,'hint');assert.equal(hint.status,200);
  const publicVariant=(await(await app.get('/api/variants/'+variant.id)).json()).variant;
  const text=JSON.stringify(publicVariant);assert.ok(!text.includes(task.answer));assert.ok(!text.includes(task.explanation));
});

test('task chat can explain the latest student attempt without receiving the reference',async t=>{
  const task={type:'Сложение',question:'Вычисли 2 + 15.',hint:'Сложи два слагаемых.',answer:'17',explanation:'PRIVATE_REFERENCE_SOLUTION'};
  const requests=[];
  const app=(await harness(t,{settings,fetchModel:async(_url,init)=>{
    requests.push(JSON.parse(init.body));
    return modelResponse(requests.length===1?generated([task]):{message:'Перепроверь сложение: твой результат меньше каждого положительного слагаемого.'});
  }})).client();
  const {variant}=await(await app.generate('ai')).json(),id=variant.tasks[0].id;
  const feedback=await(await app.action(id,'check',{answer:'1'})).json();
  assert.equal(feedback.verdict,'incorrect');assert.equal(feedback.method,'code');
  assert.equal((await app.action(id,'chat',{message:'Что не так с моей попыткой?'})).status,200);
  assert.equal(requests.length,2);
  const context=requests[1].messages[1].content;
  assert.ok(context.includes('"studentAttempts":[{"answer":"1","verdict":"incorrect"}]'));
  assert.ok(!context.includes(task.explanation));
  assert.ok(!context.includes('"referenceAnswer"'));assert.ok(!context.includes('"answer":"17"'));
});

test('chat histories belong to their own task and similar tasks retain the selected settings',async t=>{
  const parameters={topic:'sets',level:'medium',count:2};
  const tasks=[
    {type:'Свойства',question:'Докажи свойство множества A.',hint:'Начни с определения.',answer:'PRIVATE_A',explanation:'Эталон A.'},
    {type:'Свойства',question:'Докажи другое свойство множества B.',hint:'Рассмотри произвольный элемент.',answer:'PRIVATE_B',explanation:'Эталон B.'}
  ];
  const requests=[];
  const app=(await harness(t,{settings,fetchModel:async(_url,init)=>{
    requests.push(JSON.parse(init.body));
    if(requests.length===1)return modelResponse(generated(tasks,parameters));
    if(requests.length===4)return modelResponse(generated([{...tasks[0],question:'Докажи похожее свойство множества C.'}],{...parameters,count:1}));
    return modelResponse({message:'Разбери принадлежность произвольного элемента.'});
  }})).client();
  const {variant}=await(await app.generate('ai',parameters)).json();
  assert.equal((await app.action(variant.tasks[0].id,'chat',{message:'УНИКАЛЬНЫЙ ВОПРОС ПЕРВОГО ЗАДАНИЯ'})).status,200);
  assert.equal((await app.action(variant.tasks[1].id,'chat',{message:'Помоги со вторым заданием.'})).status,200);
  assert.ok(!JSON.stringify(requests[2]).includes('УНИКАЛЬНЫЙ ВОПРОС ПЕРВОГО ЗАДАНИЯ'));
  const response=await app.action(variant.tasks[0].id,'similar');assert.equal(response.status,200);
  const similar=(await response.json()).variant;publicOnly(similar);
  assert.deepEqual(similar.config,{...parameters,count:1});assert.equal(similar.source,'ai');
  assert.notEqual(similar.id,variant.id);assert.notEqual(similar.tasks[0].id,variant.tasks[0].id);
});

test('without AI, hint, simpler explanation and similar practice remain usable',async t=>{
  const app=(await harness(t)).client();
  const {variant}=await(await app.generate()).json(),id=variant.tasks[0].id;
  for(const [action,input] of [['hint',{}],['chat',{message:'Объясни проще.',action:'simpler'}]]) {
    const response=await app.action(id,action,input);assert.equal(response.status,200);assert.ok((await response.json()).message);
  }
  const similar=(await(await app.action(id,'similar')).json()).variant;
  publicOnly(similar);assert.equal(similar.source,'local');assert.deepEqual(similar.config,config);
});

test('history is bounded to twenty variants and evicted task identifiers expire',async t=>{
  const app=(await harness(t)).client();
  const {variant:first}=await(await app.generate()).json();
  for(let i=2;i<=21;i++)assert.equal((await app.generate('local',config,i)).status,200);
  const history=await(await app.get('/api/history')).json();assert.equal(history.variants.length,20);
  assert.ok(!history.variants.some(item=>item.id===first.id));
  assert.equal((await app.get('/api/variants/'+first.id)).status,404);
  assert.equal((await app.action(first.tasks[0].id,'solution')).status,404);
});

test('assistant API failures are recoverable and do not mark an answer as solved',async t=>{
  let calls=0;
  const task={...reference,type:'Обоснование',question:'Обоснуй свойство отношения.',answer:'REFERENCE_PRIVATE',explanation:'PRIVATE_EXPLANATION'};
  const app=(await harness(t,{settings,fetchModel:async()=>{
    calls++;if(calls===1)return modelResponse(generated([task]));
    if(calls===2)return new Response('upstream test-key-not-real secret detail',{status:503});
    if(calls===3)return modelResponse({verdict:'anything',explanation:'not valid'});
    return modelResponse({message:'Начни с определения отношения.'});
  }})).client();
  const {variant}=await(await app.generate('ai')).json(),id=variant.tasks[0].id;
  const failed=await app.action(id,'check',{answer:'Я проверил свойства, но объяснение неполное.'});
  assert.equal(failed.status,503);assert.ok(!(await failed.text()).includes(settings.LLM_API_KEY));
  assert.equal((await app.action(id,'check',{answer:'Мой второй развёрнутый ответ.'})).status,502);
  assert.deepEqual((await(await app.get('/api/variants/'+variant.id)).json()).variant.solved,[false]);
  const recovered=await app.action(id,'chat',{message:'Дай небольшой совет.'});assert.equal(recovered.status,200);
  assert.ok((await recovered.json()).message);
});

test('all task actions enforce same-origin JSON and reject oversized student messages',async t=>{
  const {server}=await harness(t);
  const base=`http://127.0.0.1:${server.address().port}`;
  for(const action of ['check','chat','hint','solution','similar']) {
    const url=base+'/api/tasks/missing/'+action;
    const cross=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://other.invalid'},body:'{}'});
    assert.equal(cross.status,403,action);
    const wrongType=await fetch(url,{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'});
    assert.equal(wrongType.status,415,action);
  }
  const site=await harness(t),app=site.client();
  const {variant}=await(await app.generate()).json();
  for(const [action,input] of [['check',{answer:'x'.repeat(10001)}],['chat',{message:'x'.repeat(10001)}]]) {
    const response=await app.action(variant.tasks[0].id,action,input);assert.ok([400,413].includes(response.status));
  }
});

test('model selection routes generation and dialogue to isolated server credentials',async t=>{
  const both={...settings,LLM_BASE_URL:'https://generativelanguage.googleapis.com/v1beta/openai',LLM_MODEL:'gemini-3.1-flash-lite',QWEN_API_KEY:'qwen-only-test-key'};
  const requests=[];
  const app=(await harness(t,{settings:both,fetchModel:async(url,init)=>{
    requests.push({url,headers:init.headers,body:JSON.parse(init.body)});
    return modelResponse(requests.length===1?generated():{intent:'chat',message:'Раздели целое на равные части.'});
  }})).client();
  const models=await(await app.get('/api/models')).json();
  assert.deepEqual(models.providers.map(p=>[p.id,p.available]),[['gemini',true],['qwen',true]]);
  assert.ok(!JSON.stringify(models).includes('test-key'));
  const {variant}=await(await app.post('/api/generate',{config,source:'ai',variantId:1,provider:'gemini'})).json();
  const response=await app.action(variant.tasks[0].id,'respond',{message:'Объясни, как начать?',provider:'qwen'});
  assert.equal(response.status,200);assert.equal((await response.json()).kind,'message');
  assert.match(requests[0].url,/generativelanguage/);assert.equal(requests[0].headers.Authorization,'Bearer '+settings.LLM_API_KEY);
  assert.match(requests[1].url,/sharellm/);assert.equal(requests[1].headers.Authorization,'Bearer qwen-only-test-key');
  assert.equal(requests[1].body.model,'qwen3.8-27b');
  assert.ok(!JSON.stringify(requests[1].body.messages).includes(reference.answer));
  assert.equal((await app.action(variant.tasks[0].id,'respond',{message:'Привет',provider:'https://evil.invalid'})).status,400);
  assert.equal(requests.length,2);
});

test('automatic dialogue distinguishes questions, numerical answers, written work and explicit solutions',async t=>{
  let calls=0;
  const app=(await harness(t,{settings,fetchModel:async(_url,init)=>{
    calls++;const messages=JSON.parse(init.body).messages;
    if(calls===1)return modelResponse(generated());
    if(calls===2){assert.ok(!JSON.stringify(messages).includes(reference.explanation));return modelResponse({intent:'chat',message:'Начни с представления дроби как деления.'});}
    if(calls===3)return modelResponse({intent:'answer'});
    assert.ok(JSON.stringify(messages).includes(reference.explanation));
    return modelResponse({verdict:'correct',explanation:'Рассуждение верное.',error:'',hint:''});
  }})).client();
  const {variant}=await(await app.generate('ai')).json(),id=variant.tasks[0].id;
  const chat=await(await app.action(id,'respond',{message:'Я не понимаю, как начать'})).json();assert.equal(chat.kind,'message');
  const wrong=await(await app.action(id,'respond',{message:'0,6'})).json();assert.equal(wrong.kind,'feedback');assert.equal(wrong.verdict,'incorrect');
  const right=await(await app.action(id,'respond',{message:'0,5'})).json();assert.equal(right.verdict,'correct');assert.equal(calls,2);
  const written=await(await app.action(id,'respond',{message:'Я разделил целое на две равные части и получил половину.'})).json();assert.equal(written.kind,'feedback');assert.equal(written.method,'ai');assert.equal(calls,4);
  const hint=await(await app.action(id,'respond',{message:'Дай подсказку'})).json();assert.equal(hint.kind,'message');assert.equal(calls,4);
  const solution=await(await app.action(id,'respond',{message:'Напиши подробное решение'})).json();assert.equal(solution.kind,'solution');assert.equal(solution.answer,reference.answer);assert.equal(calls,4);
  assert.equal((await app.action(id,'respond',{message:' '})).status,400);
  assert.equal((await app.action(id,'respond',{message:'a'.repeat(4001)})).status,400);
  const restored=(await(await app.get('/api/variants/'+variant.id)).json()).variant;publicOnly(restored);
});

test('clarification contains one explanation without a fabricated error block or boilerplate question',async t=>{
  let calls=0;
  const task={...reference,question:'Обоснуй утверждение из условия.',answer:'PRIVATE_REFERENCE'};
  const app=(await harness(t,{settings,fetchModel:async()=>{
    calls++;return modelResponse(calls===1?generated([task]):{verdict:'clarify',explanation:'Уточни, что обозначает x в твоём решении?',error:'Ответ отсутствует.',hint:'Сначала запиши ответ.'});
  }})).client();
  const {variant}=await(await app.generate('ai')).json();
  const result=await(await app.action(variant.tasks[0].id,'check',{answer:'Я обозначил это через x'})).json();
  assert.equal(result.explanation,'Уточни, что обозначает x в твоём решении?');
  assert.equal(result.error,'');assert.equal(result.hint,'');
});

test('unavailable model is shown disabled and never silently uses another key',async t=>{
  let calls=0;
  const app=(await harness(t,{settings,fetchModel:async()=>{calls++;return modelResponse(generated());}})).client();
  const models=await(await app.get('/api/models')).json();assert.equal(models.providers.find(p=>p.id==='qwen').available,false);
  const response=await app.post('/api/generate',{config,source:'ai',variantId:1,provider:'qwen'});
  assert.equal(response.status,503);assert.equal(calls,0);
});

test('automatic interpretation and grading share one request deadline',async t=>{
  const now=Date.now;let elapsed=0,calls=0;
  t.mock.method(Date,'now',()=>now()+elapsed);
  const app=(await harness(t,{settings,fetchModel:async()=>{
    calls++;
    if(calls===1)return modelResponse(generated());
    elapsed=300000;return modelResponse({intent:'answer'});
  }})).client();
  const {variant}=await(await app.generate('ai')).json();
  const response=await app.action(variant.tasks[0].id,'respond',{message:'Я нашёл половину делением целого на две равные части.'});
  assert.equal(response.status,504);assert.equal(calls,2,'a second model operation cannot start after the request budget expires');
});

test('a standalone Qwen key can be selected without a Gemini key',async t=>{
  let requested;
  const app=(await harness(t,{settings:{QWEN_API_KEY:'qwen-standalone-test'},fetchModel:async(url,init)=>{requested={url,body:JSON.parse(init.body)};return modelResponse(generated());}})).client();
  const models=await(await app.get('/api/models')).json();
  assert.equal(models.defaultProvider,'qwen');assert.equal(models.providers.find(p=>p.id==='gemini').available,false);
  assert.equal((await app.generate('ai')).status,200);
  assert.match(requested.url,/sharellm/);assert.equal(requested.body.model,'qwen3.8-27b');
});
