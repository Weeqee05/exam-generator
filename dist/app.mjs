import {TOPICS,LEVELS,makeTasks,buildPrompt,validConfig,escapeHtml} from './generator.mjs';
import {validateModelResult,displayModelTasks} from './ai.mjs';
import {exportVariant} from './export.mjs';

const STORAGE_KEY='praktikum-v1';
export function readSaved(storage) {
  try {
    const data=JSON.parse(storage?.getItem(STORAGE_KEY)||'null');
    if(!data || data.version!==1 || !Array.isArray(data.history))return {sequence:0,history:[]};
    const history=[];
    for(const v of data.history) {
      if(!v || !Number.isSafeInteger(v.id) || v.id<1 || !Number.isInteger(v.seed) || v.seed<0 || v.seed>0xffffffff || !validConfig(v.config) || typeof v.created!=='string' || !Number.isFinite(Date.parse(v.created)) || history.some(item=>item.id===v.id))continue;
      let result;
      if(v.source==='ai'){try{result=validateModelResult(v.result,v.config);}catch{continue;}}
      history.push({id:v.id,seed:v.seed,config:{...v.config},created:v.created,source:v.source==='ai'?'ai':'local',...(result?{result}:{}),solved:Array.from({length:v.config.count},(_,i)=>v.solved?.[i]===true)});
      if(history.length===20)break;
    }
    return {sequence:Math.max(Number.isSafeInteger(data.sequence)&&data.sequence>0?data.sequence:0,...history.map(v=>v.id)),history,activeId:history.some(v=>v.id===data.activeId)?data.activeId:history[0]?.id};
  }catch{return {sequence:0,history:[]};}
}

export function mountApp(doc,storage,env={}) {
  const $=id=>doc.getElementById(id),state=readSaved(storage);
  let current=null,tasks=[],toastTimer,activeTab='tasks',memoryWarning=false,busy=false,aiAvailable=false,sourceChosen=false;
  const request=env.fetch||globalThis.fetch?.bind(globalThis);
  const randomSeed=env.randomSeed||(()=>{if(globalThis.crypto?.getRandomValues){const a=new Uint32Array(1);globalThis.crypto.getRandomValues(a);return a[0];}return Math.floor(Math.random()*4294967296);});
  const now=env.now||(()=>new Date().toISOString());
  const announce=text=>$('announcer').textContent=text;
  function toast(message) {$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{$('toast').hidden=true;},4200);}
  function persist() {
    try {if(!storage)throw new Error('No storage');storage.setItem(STORAGE_KEY,JSON.stringify({version:1,...state}));}
    catch {if(!memoryWarning){toast('История доступна до закрытия страницы: браузер не разрешил сохранение.');memoryWarning=true;}}
    $('history-count').textContent=state.history.length;
    $('saved-variants').textContent=state.history.length;
    $('saved-variants-label').textContent=(state.history.length===1?'вариант':state.history.length>=2&&state.history.length<=4?'варианта':'вариантов')+' в истории';
    $('solved-total').textContent=state.history.reduce((sum,v)=>sum+v.solved.filter(Boolean).length,0);
  }
  function configFromForm() {return {topic:$('topic').value,level:doc.querySelector('input[name="level"]:checked').value,count:Number($('count').value)};}
  function updateSettings() {
    const c=configFromForm();
    $('topic-description').textContent=TOPICS[c.topic].description;
    $('level-description').textContent=LEVELS[c.level].description;
    $('time-estimate').textContent=validConfig(c)?`Примерно ${c.count*LEVELS[c.level].minutes} минут практики`:'Выбери целое количество от 1 до 10';
    $('decrease').disabled=busy||c.count<=1;
    $('increase').disabled=busy||c.count>=10;
    const selectedSource=$('source').value==='ai'?'ai':'local';
    $('settings-notice').hidden=!current||(JSON.stringify(c)===JSON.stringify(current.config)&&selectedSource===(current.source||'local'));
    $('source-description').textContent=$('source').value==='ai'?'Новые задания от языковой модели. На генерацию может понадобиться до четырёх минут.':'Проверенные шаблоны со случайными числами. Работает без подключения ИИ.';
  }
  function updateProgress() {
    const n=current.solved.filter(Boolean).length;
    $('progress-label').textContent=`Решено ${n} из ${tasks.length}`;
    $('progress-fill').style.width=`${100*n/tasks.length}%`;
    $('completion-note').hidden=n!==tasks.length;
  }
  function setTab(name) {
    activeTab=name;
    for(const id of ['tasks','prompt']) {
      const selected=id===name;
      $(id+'-tab').setAttribute('aria-selected',String(selected));
      $(id+'-tab').tabIndex=selected?0:-1;
      $(id+'-panel').hidden=!selected;
    }
  }
  function render() {
    const {config,id}=current;
    tasks=current.source==='ai'?displayModelTasks(current.result,config):makeTasks(config,current.seed);
    $('variant-number').textContent=String(id).padStart(3,'0');
    $('variant-summary').textContent=`${TOPICS[config.topic].name} · ${LEVELS[config.level].name} · ${config.count} ${plural(config.count)}`;
    $('task-count').textContent=config.count;
    $('prompt-text').textContent=buildPrompt(config,id);
    $('variant-source').textContent=current.source==='ai'?'Создано ИИ':'Локальные шаблоны';
    $('model-warning').hidden=current.source!=='ai';
    $('prompt-note-title').textContent=current.source==='ai'?'Промпт этого варианта':'Промпт для эксперимента';
    $('prompt-note-text').textContent=current.source==='ai'?'Этот запрос отправлен языковой модели при создании варианта. Формат ответа проверен программой; правильность решения нужно проверить самостоятельно.':'Этот вариант создан локально по шаблонам. Промпт можно скопировать и проверить в отдельном чате или выбрать режим ИИ, когда он подключён.';
    $('task-list').innerHTML=tasks.map((t,i)=>`<article class="task-card${current.solved[i]?' solved':''}" id="task-${i}"><div class="task-topline"><div class="task-meta"><span class="task-index">Задание ${String(i+1).padStart(2,'0')}</span><span class="task-tag">${escapeHtml(t.tag)}</span></div><label class="solved-checkbox"><input type="checkbox" data-solved="${i}" ${current.solved[i]?'checked':''} aria-label="Отметить задание ${i+1} решённым">Решено</label></div><div class="task-question">${t.question}</div><div class="task-reveals"><details><summary><svg><use href="#i-bulb"/></svg>Подсказка</summary><div class="reveal-content">${t.hint}</div></details><details><summary><svg><use href="#i-check"/></svg>Ответ и решение</summary><div class="reveal-content"><div class="answer-main">${t.answer}</div><p class="answer-explanation">${t.explanation}</p></div></details></div></article>`).join('');
    updateProgress();updateSettings();
  }
  function generate({notify=true}={}) {
    if(busy)return false;
    const config=configFromForm();
    if(!validConfig(config)){toast('Количество заданий должно быть целым числом от 1 до 10.');$('count').focus();return false;}
    const old=tasks.map(t=>t.question).join(''),startSeed=randomSeed();
    let seed=startSeed>>>0,newTasks;
    for(let i=0;i<50;i++){seed=(startSeed+i)>>>0;newTasks=makeTasks(config,seed);if(newTasks.map(t=>t.question).join('')!==old)break;}
    const previousSequence=state.sequence;
    state.sequence=previousSequence+1;
    current={id:state.sequence,seed,config,created:now(),source:'local',solved:Array(config.count).fill(false)};
    state.activeId=current.id;
    state.history.unshift(current);state.history=state.history.slice(0,20);
    setTab('tasks');render();persist();
    if(notify){announce(`Создан вариант ${current.id}. ${config.count} ${plural(config.count)}.`);toast(`Вариант ${String(current.id).padStart(3,'0')} готов. Можно приступать!`);}
    return true;
  }
  function loadVariant(id) {
    if(busy){toast('Подожди завершения генерации.');return false;}
    const variant=state.history.find(v=>v.id===id);
    if(!variant)return false;
    current=variant;
    state.activeId=id;
    $('topic').value=current.config.topic;$('count').value=current.config.count;
    for(const input of doc.querySelectorAll('input[name="level"]'))input.checked=input.value===current.config.level;
    setTab('tasks');render();persist();$('history-dialog').close();
    announce(`Открыт вариант ${current.id}.`);
    return true;
  }
  function showHistory() {
    $('history-search').value='';renderHistory();
    $('history-dialog').showModal();
  }
  function renderHistory() {
    const query=$('history-search').value.trim().toLocaleLowerCase('ru-RU');
    const found=state.history.filter(v=>`${v.id} ${TOPICS[v.config.topic].name} ${LEVELS[v.config.level].name} ${v.source==='ai'?'ИИ':'шаблоны'}`.toLocaleLowerCase('ru-RU').includes(query));
    $('history-list').innerHTML=found.length?found.map(v=>`<div class="history-entry"><div><h3>Вариант ${String(v.id).padStart(3,'0')} · ${escapeHtml(TOPICS[v.config.topic].name)}</h3><p>${LEVELS[v.config.level].name} · ${v.config.count} ${plural(v.config.count)} · решено ${v.solved.filter(Boolean).length}<br>${v.source==='ai'?'ИИ':'Шаблоны'} · ${escapeHtml(new Date(v.created).toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}))}</p></div><button type="button" class="secondary-button" data-load="${v.id}" aria-label="Открыть вариант ${v.id}">Открыть <svg><use href="#i-arrow"/></svg></button></div>`).join(''):'<p class="empty-history">Ничего не найдено. Попробуй другую тему или номер.</p>';
  }
  function setBusy(value) {
    busy=value;
    for(const id of ['generate-button','regenerate','topic','count','source'])$(id).disabled=value;
    for(const input of doc.querySelectorAll('input[name="level"]'))input.disabled=value;
    $('generator-form').setAttribute('aria-busy',String(value));
    $('generation-status').hidden=!value;
    updateSettings();
  }
  async function generateAI() {
    if(busy)return false;
    const config=configFromForm();
    if(!validConfig(config)){toast('Количество заданий должно быть целым числом от 1 до 10.');return false;}
    if(!aiAvailable){toast('ИИ пока не подключён. Выбери обычную практику.');return false;}
    $('generation-error').hidden=true;setBusy(true);announce('Создаём задания. Подожди немного.');
    try {
      const response=await request('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({config,variantId:state.sequence+1}),signal:AbortSignal.timeout(250000)});
      const data=await response.json();
      if(!response.ok)throw new Error(data.error||'Не удалось создать вариант. Попробуй ещё раз.');
      const result=validateModelResult(data.result,config);
      state.sequence++;
      current={id:state.sequence,seed:0,config,created:now(),source:'ai',result,solved:Array(config.count).fill(false)};
      state.activeId=current.id;state.history.unshift(current);state.history=state.history.slice(0,20);
      setTab('tasks');render();persist();announce('Вариант от ИИ готов.');toast('Вариант готов. Проверь рассуждения модели перед использованием.');
      return true;
    } catch(error) {
      $('generation-error').textContent=['AbortError','TimeoutError'].includes(error.name)?'Модель отвечает слишком долго. Попробуй ещё раз или выбери обычную практику.':error instanceof SyntaxError?'Сервер вернул неверный ответ. Попробуй позже.':error.message==='Failed to fetch'?'Нет связи с сервером. Проверь соединение или выбери обычную практику.':error.message;
      $('generation-error').hidden=false;return false;
    } finally {setBusy(false);}
  }
  function submitGeneration() { $('generation-error').hidden=true;return $('source').value==='ai'?generateAI():generate(); }
  async function checkConnection() {
    try {
      const response=await request('/api/status',{signal:AbortSignal.timeout(5000)});
      const data=await response.json();
      aiAvailable=response.ok&&data.aiAvailable===true;
    } catch {aiAvailable=false;}
    $('ai-option').disabled=!aiAvailable;
    if(aiAvailable&&!sourceChosen)$('source').value='ai';
    if(!aiAvailable&&$('source').value==='ai')$('source').value='local';
    $('connection-status').textContent=aiAvailable?'Режим ИИ доступен. Нажми «Создать вариант», чтобы получить задания.':'Обычная практика доступна. ИИ пока не подключён.';
    updateSettings();
  }
  $('generator-form').addEventListener('submit',e=>{e.preventDefault();return submitGeneration();});
  $('regenerate').addEventListener('click',submitGeneration);
  $('source').addEventListener('change',()=>{sourceChosen=true;updateSettings();});
  $('history-search').addEventListener('input',renderHistory);
  $('download-variant').addEventListener('click',()=>{
    const text=exportVariant(current,tasks,$('include-answers').checked);
    if(env.download){env.download(text);return;}
    const url=URL.createObjectURL(new Blob(['\uFEFF'+text],{type:'text/plain;charset=utf-8'}));
    const link=doc.createElement('a');link.href=url;link.download=`praktikum-${String(current.id).padStart(3,'0')}.txt`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    toast('Вариант скачан.');
  });
  $('print-variant').addEventListener('click',()=>{
    const previousTab=activeTab;
    const details=Array.from($('task-list').querySelectorAll('details'));
    const opened=details.map(item=>item.open);
    const restore=()=>{details.forEach((item,i)=>item.open=opened[i]);setTab(previousTab);};
    setTab('tasks');details.forEach((item,i)=>item.open=$('include-answers').checked&&i%2===1);
    globalThis.addEventListener('afterprint',restore,{once:true});
    globalThis.print();
  });
  $('topic').addEventListener('change',updateSettings);
  $('count').addEventListener('input',updateSettings);
  for(const input of doc.querySelectorAll('input[name="level"]'))input.addEventListener('change',updateSettings);
  for(const [id,diff] of [['decrease',-1],['increase',1]])$(id).addEventListener('click',()=>{const value=Number($('count').value);$('count').value=Math.min(10,Math.max(1,(Number.isFinite(value)&&value>=1?Math.trunc(value):1)+diff));updateSettings();});
  $('task-list').addEventListener('change',e=>{
    const index=Number(e.target.dataset.solved);
    if(e.target.matches('input[data-solved]')&&Number.isInteger(index)&&index>=0&&index<tasks.length){current.solved[index]=e.target.checked;$('task-'+index).classList.toggle('solved',e.target.checked);updateProgress();persist();announce(`Задание ${index+1} ${e.target.checked?'отмечено решённым':'снова доступно для решения'}.`);}
  });
  $('history-list').addEventListener('click',e=>{const button=e.target.closest('button[data-load]');if(button)loadVariant(Number(button.dataset.load));});
  $('nav-history').addEventListener('click',showHistory);
  for(const id of ['nav-guide','footer-about'])$(id).addEventListener('click',()=>$('guide-dialog').showModal());
  $('nav-generator').addEventListener('click',()=>{$('config-title').scrollIntoView({behavior:globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'center'});$('topic').focus({preventScroll:true});});
  for(const button of doc.querySelectorAll('[data-close]'))button.addEventListener('click',()=>button.closest('dialog').close());
  for(const dialog of doc.querySelectorAll('dialog'))dialog.addEventListener('click',e=>{if(e.target===dialog){const rect=dialog.getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)dialog.close();}});
  for(const name of ['tasks','prompt']) {
    $(name+'-tab').addEventListener('click',()=>setTab(name));
    $(name+'-tab').addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const target=e.key==='Home'?'tasks':e.key==='End'?'prompt':activeTab==='tasks'?'prompt':'tasks';setTab(target);$(target+'-tab').focus();}});
  }
  $('copy-prompt').addEventListener('click',async()=>{
    try {if(!globalThis.navigator?.clipboard?.writeText)throw new Error('Clipboard unavailable');await globalThis.navigator.clipboard.writeText($('prompt-text').textContent);toast('Промпт скопирован.');}
    catch {const selection=doc.getSelection?.();if(selection&&doc.createRange){const range=doc.createRange();range.selectNodeContents($('prompt-text'));selection.removeAllRanges();selection.addRange(range);}toast('Выдели текст промпта и скопируй его: Ctrl+C или ⌘C.');}
  });
  if(state.history.length)loadVariant(state.activeId||state.history[0].id);else generate({notify:false});
  $('history-count').textContent=state.history.length;
  if(env.offline)$('connection-status').textContent='Автономная версия. Обычная практика работает без интернета.';
  else if(request&&(env.fetch||globalThis.document===doc))checkConnection();
  return {generate,generateAI,loadVariant,setTab,showHistory,updateSettings,checkConnection,getState:()=>({sequence:state.sequence,history:state.history,current,tasks,activeTab,busy})};
}
function plural(n){return n===1?'задание':n>=2&&n<=4?'задания':'заданий';}
if(typeof document!=='undefined') {
  let storage;try{storage=globalThis.localStorage;}catch{}
  mountApp(document,storage);
}
