import {feedbackParagraphs} from './dialogue.mjs';
import {TOPICS, LEVELS, validConfig, hasTemplates, topicName, escapeHtml} from './generator.mjs';

// Only the selected variant id and the student's drafts are persisted here.
// Reference answers and solutions are owned by the server.
const STORAGE_KEY = 'praktikum-assistant-v2';
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const labels = {correct: 'Верно', incorrect: 'Неверно', partial: 'Частично верно', clarify: 'Уточни ответ'};
const plural = n => n === 1 ? 'задание' : n < 5 ? 'задания' : 'заданий';

export function readSaved(storage) {
  try {
    const data = JSON.parse(storage?.getItem(STORAGE_KEY) || 'null'), drafts = {};
    if (data?.drafts && typeof data.drafts === 'object') for (const [id, text] of Object.entries(data.drafts).slice(-200)) {
      if (safeId(id) && typeof text === 'string' && text.length <= 4000) drafts[id] = text;
    }
    return {activeId: safeId(data?.activeId) ? data.activeId : null, selectedTaskId: safeId(data?.selectedTaskId) ? data.selectedTaskId : null, preferredProvider: ['gemini','qwen','default'].includes(data?.preferredProvider) ? data.preferredProvider : null, drafts};
  } catch { return {activeId: null, drafts: {}}; }
}

// Select only public fields. Unexpected server fields are never persisted.
function publicVariant(value) {
  if (!value || !safeId(value.id) || !validConfig(value.config) || !Number.isSafeInteger(value.number) || value.number < 1 ||
      !['local', 'ai'].includes(value.source) || !Array.isArray(value.tasks) || value.tasks.length !== value.config.count) {
    throw new Error('Сервер вернул неверный вариант. Попробуй ещё раз.');
  }
  const tasks = value.tasks.map(task => {
    if (!task || !safeId(task.id) || typeof task.question !== 'string' || !task.question.trim() || typeof task.tag !== 'string') throw new Error('В задании не хватает условия. Создай новый вариант.');
    const chat = Array.isArray(task.chat) ? task.chat.filter(item => ['user', 'assistant'].includes(item?.role) && typeof item.content === 'string')
      .slice(-24).map(item => ({role: item.role, content: item.content.slice(0, 12000)})) : [];
    return {id: task.id, tag: task.tag, question: task.question, chat};
  });
  return {id: value.id, number: value.number, config: {...value.config}, source: value.source,
    created: value.created, provider: value.provider, tasks, solved: tasks.map((_, index) => value.solved?.[index] === true)};
}

export function mountApp(doc, storage, env = {}) {
  const $ = id => doc.getElementById(id), saved = readSaved(storage);
  const request = env.fetch || globalThis.fetch?.bind(globalThis);
  let current = null, history = [], selectedTaskId = null, busy = false, aiAvailable = false;
  let providers = [], activeProvider = saved.preferredProvider || 'gemini';
  let toastTimer, storageWarned = false;
  const conversations = new Map(), solutions = new Map();
  $('topic').innerHTML = Object.entries(TOPICS).map(([id, topic]) => `<option value="${id}">${escapeHtml(topic.name)}</option>`).join('');
  const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const selectedTask = () => current?.tasks.find(task => task.id === selectedTaskId);
  const taskPath = action => '/api/tasks/' + encodeURIComponent(selectedTaskId) + '/' + action;

  function toast(text) {
    $('toast').textContent = text; $('toast').hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => {$('toast').hidden = true;}, 4200);
  }
  function persist() {
    const validTasks = new Set(history.flatMap(variant => variant.tasks.map(task => task.id)));
    for (const id of Object.keys(saved.drafts)) if (!validTasks.has(id)) delete saved.drafts[id];
    try { storage?.setItem(STORAGE_KEY, JSON.stringify({activeId: current?.id || null, selectedTaskId, preferredProvider: activeProvider, drafts: saved.drafts})); }
    catch { if (!storageWarned) {toast('Браузер не сохраняет черновики. До закрытия страницы они останутся доступны.'); storageWarned = true;} }
  }
  function errorText(error) {
    if (['AbortError', 'TimeoutError'].includes(error.name)) return 'ИИ отвечает слишком долго. Попробуй позже или выбери тренировочные шаблоны в настройках.';
    if (error instanceof SyntaxError) return 'Сервер вернул непонятный ответ. Попробуй ещё раз.';
    if (error.status === 404) return 'Это задание больше недоступно: сервер мог перезапуститься или сессия закончилась. Начни новую практику.';
    if (error instanceof TypeError) return 'Нет связи с сервером. Проверь соединение и попробуй ещё раз.';
    return error.message || 'Не удалось выполнить запрос. Попробуй ещё раз.';
  }
  async function api(path, data) {
    const options = {credentials:'same-origin', signal:AbortSignal.timeout(data === undefined ? 10000 : 250000)};
    if (data !== undefined) Object.assign(options, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...data,provider:data.provider ?? activeProvider})});
    const response = await request(path, options), result = await response.json();
    if (!response.ok) {const error = new Error(result.error || 'Не удалось выполнить запрос.'); error.status = response.status; throw error;}
    return result;
  }
  function configFromForm() {
    const topic = $('topic').value;
    return {topic, level:doc.querySelector('input[name="level"]:checked').value, count:Number($('count').value), ...(topic === 'custom' ? {customTopic:$('custom-topic').value.trim()} : {})};
  }
  function updateSettings() {
    const topic = $('topic').value, aiOnly = !hasTemplates(topic), custom = topic === 'custom';
    $('custom-topic-field').hidden = !custom;
    $('custom-topic').required = custom;
    $('custom-topic').disabled = busy || !custom;
    for (const option of $('topic').options) {
      option.disabled = !aiAvailable && !hasTemplates(option.value);
      option.textContent = TOPICS[option.value].name + (!aiAvailable && !hasTemplates(option.value) ? ' — нужен ИИ' : '');
    }
    $('ai-option').disabled = !aiAvailable;
    $('local-option').disabled = aiOnly;
    if (aiOnly) $('source').value = 'ai';
    else if (!aiAvailable) $('source').value = 'local';
    $('source').disabled = busy || aiOnly;
    $('generate-button').disabled = busy || (aiOnly && !aiAvailable);
    $('topic-description').textContent = TOPICS[$('topic').value]?.description || '';
    updateProviderState();
    $('source-description').textContent = aiOnly && !aiAvailable ? 'Для этой темы подключи Gemini или Qwen на сервере. Три темы с шаблонами доступны без ИИ.' : $('source').value === 'ai'
      ? 'Задания создаёт модель. Ожидание может занять до четырёх минут.'
      : 'Проверенные задания со случайными числами. Их создание не требует ИИ.';
  }
  function setBusy(value, message = '') {
    busy = value;
    for (const node of doc.querySelectorAll('[data-request], #generator-form select, #generator-form input, #generator-form button')) node.disabled = value;
    for (const node of doc.querySelectorAll('[data-task-request], #chat-input')) node.disabled = value || !current;
    $('download-variant').disabled = value || !current; $('print-variant').disabled = value || !current;
    $('generator-form').setAttribute('aria-busy', String(value)); $('chat-form').setAttribute('aria-busy', String(value));
    $('request-status').hidden = !value; $('request-status-text').textContent = message;
    $('generation-status').hidden = !value; $('generation-status').textContent = message;
    updateSettings();
  }
  function settings(topic) {
    if (busy) return;
    if (topic) $('topic').value = topic;
    $('provider').value = activeProvider; updateSettings(); $('generation-error').hidden = true;
    if (!$('settings-dialog').open) $('settings-dialog').showModal();
  }
  function conversationFor(task) {
    if (!conversations.has(task.id)) conversations.set(task.id, task.chat.map(item => ({...item, kind:'text'})));
    return conversations.get(task.id);
  }
  function saveDraft() {
    if (!selectedTask()) return;
    saved.drafts[selectedTaskId] = $('chat-input').value; persist();
  }
  function fillInput() {
    $('chat-input').value = selectedTask() ? saved.drafts[selectedTaskId] || '' : '';
    $('chat-input').placeholder = !current ? 'Сначала создай задания — и начнём практику' : 'Твой ответ, вопрос или просьба…';
    $('chat-error').hidden = true;
  }
  function updateProviderState() {
    const any = providers.some(item => item.available);
    for (const id of ['provider','chat-provider']) $(id).disabled = busy || !any;
    $('provider-status').textContent = any ? 'Для ответов и общения в этом диалоге.' : 'Добавь ключ Gemini или Qwen в настройки сервера.';
    $('provider-note').textContent = $('provider').value === 'qwen' ? 'Qwen может отвечать дольше. Выбор применяется к новым заданиям.' : 'Gemini создаёт задания и помогает разбирать решения.';
  }
  function setProvider(id) {
    if (busy || !providers.some(item => item.id === id && item.available)) return;
    activeProvider = id; $('chat-provider').value = id; $('provider').value = id;
    updateProviderState();persist();
  }
  function updateProgress() {
    $('history-count').textContent = history.length;
    if (!current) return;
    const solved = current.solved.filter(Boolean).length;
    $('progress-label').textContent = `Проверено верно ${solved} из ${current.tasks.length}`;
    $('progress-fill').style.width = `${100 * solved / current.tasks.length}%`;
    $('completion-note').hidden = solved !== current.tasks.length;
    $('task-list').innerHTML = current.tasks.map((task, index) => `<button type="button" class="task-nav-item${task.id === selectedTaskId ? ' active' : ''}" data-select-task="${escapeHtml(task.id)}" data-request aria-current="${task.id === selectedTaskId ? 'step' : 'false'}"><span class="task-number">${String(index+1).padStart(2,'0')}</span><span class="task-name">${escapeHtml(task.tag)}</span>${current.solved[index] ? '<span class="task-solved" aria-label="Проверено верно">✓</span>' : ''}</button>`).join('');
  }
  function renderQuestion(task) {
    const area = $('task-question'); area.replaceChildren();
    const lines = task.question.split('\n');
    const start = current.config.topic === 'python' ? lines.findIndex(line => /^(?:[A-Za-z_]\w*\s*=|for\s|while\s|print\(|def\s|if\s)/.test(line.trimStart())) : -1;
    if (start >= 0) {
      if (start) {const p=doc.createElement('p');p.textContent=lines.slice(0,start).join('\n');area.append(p);}
      const pre=doc.createElement('pre');pre.className='code-block';const code=doc.createElement('code');
      code.innerHTML=escapeHtml(lines.slice(start).join('\n')).replace(/\b(for|in|range|print|while|if|else|def|return|and|or|not)\b/g,'<span class="code-keyword">$1</span>');
      pre.append(code);area.append(pre);
    } else area.textContent = task.question;
  }
  function renderMessages() {
    const task=selectedTask(); if (!task) return;
    $('chat-messages').innerHTML = conversationFor(task).map(item => {
      if (item.role === 'user') return `<article class="message from-student"><div class="message-body">${escapeHtml(item.content)}</div><span class="student-mark" aria-hidden="true">ты</span></article>`;
      let body, css='';
      if (item.kind === 'feedback') {
        const f=item.feedback; css=' verdict-'+f.verdict;
        const paragraphs = feedbackParagraphs(f);
        body=`<span class="verdict-label">${labels[f.verdict]}</span>${paragraphs.map(text=>`<p>${escapeHtml(text)}</p>`).join('')}<span class="feedback-method">${f.method==='code'?'Проверено вычислением':f.method==='ai'?'Оценка ИИ — она может ошибаться':'Нужно уточнение для точной проверки'}</span>`;
      } else if (item.kind === 'solution') {
        css=' solution-content'; body=`<strong>Ответ</strong><div class="solution-answer">${escapeHtml(item.solution.answer)}</div><strong>Разбор по шагам</strong><div class="solution-explanation">${escapeHtml(item.solution.explanation)}</div>`;
      } else body=escapeHtml(item.content);
      return `<article class="message from-assistant"><span class="avatar" aria-hidden="true">✦</span><div class="message-body"><div class="message-author">Ассистент</div><div class="reply${css}">${body}</div></div></article>`;
    }).join('');
  }
  function render() {
    const task=selectedTask(); if (!task) return;
    $('welcome').hidden=true; $('thread').hidden=false; $('task-navigation').hidden=false;
    $('context-label').textContent=`${topicName(current.config)} · ${LEVELS[current.config.level].name}`.toLocaleUpperCase('ru-RU');
    $('session-topic').textContent=topicName(current.config); $('session-level').textContent=LEVELS[current.config.level].name; $('session-count').textContent=current.tasks.length;
    $('topic-icon').innerHTML=`<use href="#i-${current.config.topic==='python'?'code':'book'}"/>`;
    $('variant-source').textContent=current.source==='ai'?'Создано ИИ':'Тренировочное задание';
    const index=current.tasks.findIndex(t=>t.id===selectedTaskId);
    $('task-position').textContent=`Задание ${index+1} / ${current.tasks.length}`; $('task-tag').textContent=task.tag;
    renderQuestion(task);renderMessages();updateProgress();fillInput();setBusy(busy);
  }
  function acceptVariant(value, restoring = false) {
    current=publicVariant(value);history=[current,...history.filter(v=>v.id!==current.id)].slice(0,20);
    selectedTaskId=restoring && current.tasks.some(t=>t.id===saved.selectedTaskId) ? saved.selectedTaskId : current.tasks[0].id;
    $('topic').value=current.config.topic;$('count').value=current.config.count;
    $('custom-topic').value=current.config.customTopic || '';
    for(const input of doc.querySelectorAll('input[name="level"]'))input.checked=input.value===current.config.level;
    render();persist();
    const validTasks=new Set(history.flatMap(v=>v.tasks.map(t=>t.id)));
    for(const map of [conversations,solutions]) for(const id of map.keys())if(!validTasks.has(id))map.delete(id);
  }
  async function generate() {
    if(busy)return false;
    const provider=$('provider').value;
    const config=configFromForm(),source=$('source').value;
    if(!validConfig(config)){$('generation-error').textContent='Укажи тему от 2 до 160 символов и целое количество заданий от 1 до 10.';$('generation-error').hidden=false;return false;}
    saveDraft();$('generation-error').hidden=true;$('app-error').hidden=true;
    setBusy(true,source==='ai'?'Создаём задания с ИИ. Ожидание — до четырёх минут…':'Готовим тренировочные задания…');
    try {
      acceptVariant((await api('/api/generate',{config,variantId:Math.max(0,...history.map(v=>v.number))+1,source,provider})).variant);
      activeProvider=provider;$('chat-provider').value=provider;persist();$('settings-dialog').close();return true;
    } catch(error){
      const message=errorText(error);$('generation-error').textContent=message;$('generation-error').hidden=false;
      if(!$('settings-dialog').open){$('app-error').textContent=message;$('app-error').hidden=false;}
      return false;
    }
    finally{setBusy(false);if(!$('settings-dialog').open && current)$('chat-input').focus({preventScroll:true});}
  }
  async function loadVariant(id) {
    if(busy)return false;saveDraft();setBusy(true,'Открываем занятие…');
    try{acceptVariant((await api('/api/variants/'+encodeURIComponent(id))).variant);$('history-dialog').close();return true;}
    catch(error){$('history-dialog').close();$('app-error').textContent=errorText(error);$('app-error').hidden=false;return false;}
    finally{setBusy(false);}
  }
  function selectTask(id) {
    if(busy || !current?.tasks.some(t=>t.id===id))return;
    saveDraft();selectedTaskId=id;render();persist();
  }
  function showHistory() {
    if(busy)return;$('history-search').value='';renderHistory();$('history-dialog').showModal();
  }
  function renderHistory() {
    const query=$('history-search').value.trim().toLocaleLowerCase('ru-RU');
    const entries=history.filter(v=>`${v.number} ${topicName(v.config)} ${LEVELS[v.config.level].name}`.toLocaleLowerCase('ru-RU').includes(query));
    $('history-list').innerHTML=entries.length?entries.map(v=>`<div class="history-entry"><div><h3>${escapeHtml(topicName(v.config))} · ${String(v.number).padStart(3,'0')}</h3><p>${LEVELS[v.config.level].name} · ${v.tasks.length} ${plural(v.tasks.length)} · верно ${v.solved.filter(Boolean).length}</p></div><button type="button" data-load="${escapeHtml(v.id)}">Открыть</button></div>`).join(''):'<p class="empty-history">Занятий не найдено. Попробуй другую тему или номер.</p>';
  }
  async function submitMessage() {
    if(busy || !selectedTask())return;
    const task=selectedTask(),text=$('chat-input').value.trim();
    $('chat-error').hidden=true;
    if(!text){$('chat-error').textContent='Напиши свой ответ или задай вопрос.';$('chat-error').hidden=false;$('chat-input').focus();return;}
    saveDraft();setBusy(true,'Ассистент разбирает сообщение…');
    try {
      const result=await api(taskPath('respond'),{message:text});
      if(!['feedback','message','solution','variant'].includes(result.kind))throw new Error('Не удалось понять ответ ассистента. Попробуй ещё раз.');
      if(result.kind==='variant') {acceptVariant(result.variant);return;}
      let reply;
      if(result.kind==='feedback') {
        if(!Object.hasOwn(labels,result.verdict))throw new Error('Не удалось понять оценку ответа. Попробуй ещё раз.');
        reply={role:'assistant',kind:'feedback',feedback:result};
        current.solved[current.tasks.findIndex(t=>t.id===task.id)] ||= result.verdict==='correct';
        $('announcer').textContent=labels[result.verdict];
      } else if(result.kind==='solution') {
        if(typeof result.answer!=='string'||typeof result.explanation!=='string')throw new Error('Не удалось загрузить решение.');
        solutions.set(task.id,result);reply={role:'assistant',kind:'solution',solution:result};
      } else {
        if(typeof result.message!=='string')throw new Error('Ассистент не прислал объяснение.');
        reply={role:'assistant',kind:'text',content:result.message};
      }
      conversationFor(task).push({role:'user',content:text,kind:'text'},reply);
      delete saved.drafts[task.id];persist();$('chat-input').value='';
      renderMessages();updateProgress();
      $('chat-messages').lastElementChild?.scrollIntoView({behavior:'smooth',block:'nearest'});
    } catch(error){$('chat-error').textContent=errorText(error);$('chat-error').hidden=false;}
    finally{setBusy(false);$('chat-input').focus({preventScroll:true});}
  }
  async function chatAction(action) {
    if(busy || !selectedTask())return;
    saveDraft();$('chat-error').hidden=true;
    const task=selectedTask();
    if(action==='solution' && solutions.has(task.id)){
      doc.querySelector('.solution-content')?.scrollIntoView({behavior:'smooth',block:'center'});return;
    }
    const caption={hint:'Дай подсказку',simpler:'Объясни проще',solution:'Покажи решение',similar:'Дай похожее задание'}[action];
    if(!caption)return;
    setBusy(true,action==='similar'?'Создаём похожее задание…':action==='solution'?'Открываем решение…':'Готовим объяснение…');
    try {
      const result=await api(taskPath(action==='simpler'?'chat':action),action==='simpler'?{message:caption,action:'simpler'}:{});
      if(action==='similar'){acceptVariant(result.variant);return;}
      let reply;
      if(action==='solution'){
        if(typeof result.answer!=='string'||typeof result.explanation!=='string')throw new Error('Не удалось загрузить решение. Попробуй ещё раз.');
        solutions.set(task.id,result);reply={role:'assistant',kind:'solution',solution:result};
      } else {
        if(typeof result.message!=='string')throw new Error('Ассистент не прислал объяснение. Попробуй ещё раз.');
        reply={role:'assistant',kind:'text',content:result.message};
      }
      conversationFor(task).push({role:'user',content:caption,kind:'text'},reply);renderMessages();
      $('chat-messages').lastElementChild?.scrollIntoView({behavior:'smooth',block:'nearest'});
    } catch(error){$('chat-error').textContent=errorText(error);$('chat-error').hidden=false;}
    finally{setBusy(false);}
  }
  function exportText() {
    return ['ЭКЗАМЕН+ · Занятие '+current.number,`${topicName(current.config)} · ${LEVELS[current.config.level].name}`,'',...current.tasks.flatMap((task,index)=>['ЗАДАНИЕ '+(index+1)+'. '+task.tag,task.question,''])].join('\n');
  }
  function downloadVariant() {
    if(!current)return;
    const text=exportText();if(env.download)return env.download(text);
    const url=URL.createObjectURL(new Blob(['\uFEFF'+text],{type:'text/plain;charset=utf-8'})),link=doc.createElement('a');
    link.href=url;link.download=`examen-plus-${current.number}.txt`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function printVariant() {
    if(!current)return;$('print-sheet').textContent=exportText();globalThis.print();
  }
  $('generator-form').addEventListener('submit',event=>{event.preventDefault();return generate();});
  for(const id of ['new-dialog','start-practice','change-topic'])$(id).addEventListener('click',()=>settings());
  for(const button of doc.querySelectorAll('[data-topic]'))button.addEventListener('click',()=>settings(button.dataset.topic));
  for(const id of ['topic','source','count'])$(id).addEventListener('change',updateSettings);
  $('task-list').addEventListener('click',event=>{const button=event.target.closest('[data-select-task]');if(button)selectTask(button.dataset.selectTask);});
  $('chat-provider').addEventListener('change',()=>setProvider($('chat-provider').value));
  $('provider').addEventListener('change',updateProviderState);
  $('chat-form').addEventListener('submit',event=>{event.preventDefault();return submitMessage();});
  $('chat-input').addEventListener('input',saveDraft);
  $('chat-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();return submitMessage();}});
  $('chat-quick-actions').addEventListener('click',event=>{const button=event.target.closest('[data-chat-action]');if(button)return chatAction(button.dataset.chatAction);});
  for(const id of ['nav-history','rail-history'])$(id).addEventListener('click',showHistory);
  $('history-search').addEventListener('input',renderHistory);
  $('history-list').addEventListener('click',event=>{const button=event.target.closest('[data-load]');if(button)return loadVariant(button.dataset.load);});
  for(const id of ['rail-guide','rail-help','footer-guide'])$(id).addEventListener('click',()=>$('guide-dialog').showModal());
  for(const id of ['nav-generator','rail-practice'])$(id).addEventListener('click',()=>$('conversation-title').scrollIntoView({behavior:'smooth',block:'start'}));
  for(const button of doc.querySelectorAll('[data-close]'))button.addEventListener('click',()=>button.closest('dialog').close());
  for(const dialog of doc.querySelectorAll('dialog')){
    // Closing a dialog does not unlock or duplicate its pending request.
    dialog.addEventListener('click',event=>{if(event.target===dialog && !busy){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
  }
  $('download-variant').addEventListener('click',downloadVariant);$('print-variant').addEventListener('click',printVariant);
  async function initialize() {
    if(env.offline || globalThis.location?.protocol==='file:'){
      $('app-error').textContent='Для Экзамен+ нужен сервер. Запусти npm start и открой адрес сервера в браузере. Инструкция — в README.';$('app-error').hidden=false;setBusy(true);return;
    }
    setBusy(true,'Подключаем учебную практику…');
    const results=await Promise.allSettled([api('/api/status'),api('/api/history'),api('/api/models')]);
    aiAvailable=results[0].status==='fulfilled'&&results[0].value.aiAvailable===true;
    $('ai-option').disabled=!aiAvailable;$('source').value=aiAvailable?'ai':'local';
    if(results[2].status==='fulfilled' && Array.isArray(results[2].value.providers)) {
      providers=results[2].value.providers.filter(item=>['gemini','qwen','default'].includes(item.id));
      activeProvider=providers.find(item=>item.id===saved.preferredProvider&&item.available)?.id || providers.find(item=>item.id===results[2].value.defaultProvider&&item.available)?.id || providers.find(item=>item.available)?.id || results[2].value.defaultProvider;
    } else providers=[{id:'gemini',label:'Gemini',available:aiAvailable},{id:'qwen',label:'Qwen',available:false}];
    for(const id of ['provider','chat-provider']) {
      $(id).innerHTML=providers.map(item=>`<option value="${escapeHtml(item.id)}" ${item.available?'':'disabled'}>${escapeHtml(item.label)}${item.available?'':' — не подключён'}</option>`).join('');
      $(id).value=activeProvider;
    }
    $('connection-status').textContent=aiAvailable?'ИИ настроен. Запрос отправится после твоего действия.':'Тренировочные задания доступны. Для свободного чата нужно подключить ИИ.';
    if(results[1].status==='fulfilled'){
      try{
        history=(results[1].value.variants||[]).slice(0,20).map(publicVariant);
        const previous=history.find(v=>v.id===saved.activeId)||history[0];
        if(previous)acceptVariant(previous,true);
        else if(saved.activeId)toast('Предыдущая сессия закончилась. Начни новую практику.');
      }catch(error){$('app-error').textContent=errorText(error);$('app-error').hidden=false;}
    }else{$('app-error').textContent=errorText(results[1].reason);$('app-error').hidden=false;}
    updateSettings();updateProgress();setBusy(false);
  }
  const ready=initialize();
  return {ready,generate,loadVariant,selectTask,submitMessage,chatAction,getState:()=>({current,history,busy,selectedTaskId,aiAvailable})};
}
if(typeof document!=='undefined'){
  let storage;try{storage=globalThis.localStorage;}catch{}
  mountApp(document,storage);
}
