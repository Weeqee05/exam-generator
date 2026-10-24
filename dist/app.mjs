import {TOPICS, LEVELS, validConfig, escapeHtml} from './generator.mjs';

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
    return {activeId: safeId(data?.activeId) ? data.activeId : null, drafts};
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
    created: value.created, tasks, solved: tasks.map((_, index) => value.solved?.[index] === true)};
}

export function mountApp(doc, storage, env = {}) {
  const $ = id => doc.getElementById(id), saved = readSaved(storage);
  const request = env.fetch || globalThis.fetch?.bind(globalThis);
  let current = null, history = [], selectedTaskId = null, busy = false, aiAvailable = false;
  let toastTimer, storageWarned = false;
  const feedback = new Map(), hints = new Map(), solutions = new Map();
  try { storage?.removeItem('praktikum-v1'); } catch {}

  function toast(text) {
    $('toast').textContent = text; $('toast').hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => {$('toast').hidden = true;}, 4200);
  }
  function persist() {
    const validTasks = new Set(history.flatMap(variant => variant.tasks.map(task => task.id)));
    for (const id of Object.keys(saved.drafts)) if (!validTasks.has(id)) delete saved.drafts[id];
    try { storage?.setItem(STORAGE_KEY, JSON.stringify({activeId: current?.id || null, drafts: saved.drafts})); }
    catch { if (!storageWarned) {toast('Браузер не сохраняет черновики. До закрытия страницы они останутся доступны.'); storageWarned = true;} }
  }
  function errorText(error) {
    if (['AbortError', 'TimeoutError'].includes(error.name)) return 'ИИ отвечает слишком долго. Попробуй ещё раз или выбери обычную практику.';
    if (error instanceof SyntaxError) return 'Сервер вернул непонятный ответ. Попробуй ещё раз.';
    if (error.status === 404) return 'Это задание больше недоступно: сервер мог перезапуститься или сессия закончилась. Создай новый вариант.';
    if (error instanceof TypeError) return 'Нет связи с сервером. Проверь соединение и попробуй ещё раз.';
    return error.message || 'Не удалось выполнить запрос. Попробуй ещё раз.';
  }
  async function api(path, data) {
    const options = {credentials: 'same-origin', signal: AbortSignal.timeout(data === undefined ? 10000 : 250000)};
    if (data !== undefined) Object.assign(options, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)});
    const response = await request(path, options), result = await response.json();
    if (!response.ok) {const error = new Error(result.error || 'Не удалось выполнить запрос.'); error.status = response.status; throw error;}
    return result;
  }
  function configFromForm() {
    return {topic: $('topic').value, level: doc.querySelector('input[name="level"]:checked').value, count: Number($('count').value)};
  }
  function updateSettings() {
    const config = configFromForm();
    $('topic-description').textContent = TOPICS[config.topic]?.description || '';
    $('level-description').textContent = LEVELS[config.level]?.description || '';
    $('time-estimate').textContent = validConfig(config) ? `Примерно ${config.count * LEVELS[config.level].minutes} минут практики` : 'Выбери целое количество от 1 до 10';
    $('decrease').disabled = busy || config.count <= 1; $('increase').disabled = busy || config.count >= 10;
    $('settings-notice').hidden = !current || (JSON.stringify(config) === JSON.stringify(current.config) && $('source').value === current.source);
    $('source-description').textContent = $('source').value === 'ai' ? 'Новые задания от модели. Генерация может занять до четырёх минут.' : 'Задания по проверенным шаблонам. Подключение ИИ для их создания не требуется.';
  }
  function setBusy(value, message = '') {
    busy = value;
    for (const node of doc.querySelectorAll('[data-request], #generator-form select, #generator-form input, #generator-form button, .answer-input, #chat-input, #chat-task')) node.disabled = value;
    $('regenerate').disabled = value || !current; $('download-variant').disabled = value || !current; $('print-variant').disabled = value || !current;
    $('generator-form').setAttribute('aria-busy', String(value));
    $('generation-status').hidden = !value; $('generation-status-text').textContent = message;
    $('chat-loading').hidden = !value || !selectedTaskId; $('chat-loading').textContent = message;
    updateSettings();
  }
  function updateProgress() {
    const solved = current?.solved.filter(Boolean).length || 0, total = current?.tasks.length || 0;
    $('progress-label').textContent = `Проверено верно ${solved} из ${total}`;
    $('progress-fill').style.width = `${total ? 100 * solved / total : 0}%`;
    $('completion-note').hidden = !total || solved !== total;
    $('history-count').textContent = history.length; $('saved-variants').textContent = history.length;
    $('solved-total').textContent = history.reduce((sum, variant) => sum + variant.solved.filter(Boolean).length, 0);
  }
  function renderFeedback(taskId, index) {
    const result = feedback.get(taskId), container = $('feedback-' + index);
    if (!result) {container.hidden = true; return;}
    container.hidden = false; container.className = 'task-feedback verdict-' + result.verdict; container.replaceChildren();
    const title = doc.createElement('strong'); title.textContent = labels[result.verdict] || 'Уточни ответ'; container.append(title);
    for (const [name, prefix] of [['explanation', ''], ['error', 'Что исправить: '], ['hint', 'Следующий шаг: ']]) {
      if (typeof result[name] === 'string' && result[name].trim()) {const paragraph = doc.createElement('p'); paragraph.textContent = prefix + result[name]; container.append(paragraph);}
    }
    const method = doc.createElement('span'); method.className = 'feedback-method';
    method.textContent = result.method === 'code' ? 'Проверено вычислением' : result.method === 'ai' ? 'Оценка ИИ — она может ошибаться' : 'Для точной проверки нужно уточнение'; container.append(method);
  }
  function render() {
    if (!current) return;
    $('results').hidden = false; $('empty-state').hidden = true;
    $('variant-number').textContent = String(current.number).padStart(3, '0');
    $('variant-summary').textContent = `${TOPICS[current.config.topic].name} · ${LEVELS[current.config.level].name} · ${current.tasks.length} ${plural(current.tasks.length)}`;
    $('variant-source').textContent = current.source === 'ai' ? 'Создано ИИ' : 'Проверенные шаблоны'; $('model-warning').hidden = current.source !== 'ai';
    $('task-list').dataset.topic = current.config.topic;
    $('task-list').innerHTML = current.tasks.map((task, index) => `<article class="task-card${current.solved[index] ? ' solved' : ''}" id="task-${index}" data-task-id="${escapeHtml(task.id)}">
      <div class="task-topline"><div class="task-meta"><span class="task-index">Задание ${String(index + 1).padStart(2, '0')}</span><span class="task-tag">${escapeHtml(task.tag)}</span></div><span class="verified-mark" id="verified-${index}" ${current.solved[index] ? '' : 'hidden'}>✓ Верно</span></div>
      <div class="task-question model-text">${escapeHtml(task.question)}</div>
      <form class="answer-form" data-check="${index}" novalidate><label for="answer-${index}">Твой ответ или ход решения</label><textarea class="answer-input" id="answer-${index}" data-answer="${index}" rows="2" maxlength="4000" placeholder="Запиши ответ и, если нужно, объясни свой ход мысли">${escapeHtml(saved.drafts[task.id] || '')}</textarea><div class="answer-footer"><span>Можно использовать дроби и десятичную запятую</span><button type="submit" class="primary-button check-button" data-request>Проверить</button></div></form>
      <p class="task-error" id="task-error-${index}" role="alert" hidden></p><div class="task-feedback" id="feedback-${index}" role="status" aria-live="polite" hidden></div>
      <div class="task-actions"><button type="button" class="text-button" data-task-action="hint" data-index="${index}" data-request>Дай подсказку</button><button type="button" class="text-button" data-task-action="discuss" data-index="${index}" data-request>Обсудить с ассистентом ↗</button><button type="button" class="text-button solution-button" data-task-action="solution" data-index="${index}" data-request>Покажи решение</button></div>
      <div class="task-hint reveal-content model-text" id="hint-${index}" hidden></div><section class="task-solution reveal-content" id="solution-${index}" aria-label="Эталонное решение" hidden><strong>Ответ</strong><div class="answer-main model-text" id="solution-answer-${index}"></div><strong>Разбор по шагам</strong><div class="answer-explanation model-text" id="solution-explanation-${index}"></div></section>
    </article>`).join('');
    current.tasks.forEach((task, index) => {
      renderFeedback(task.id, index);
      if (hints.has(task.id)) {$('hint-' + index).textContent = hints.get(task.id); $('hint-' + index).hidden = false;}
      if (solutions.has(task.id)) showSolution(task.id, index);
    });
    if (!current.tasks.some(task => task.id === selectedTaskId)) selectedTaskId = current.tasks[0].id;
    $('chat-task').innerHTML = current.tasks.map((task, index) => `<option value="${escapeHtml(task.id)}">Задание ${index + 1} · ${escapeHtml(task.tag)}</option>`).join('');
    $('chat-task').value = selectedTaskId;
    renderChat(); updateProgress(); updateSettings(); setBusy(busy);
  }
  function selectedTask() {return current?.tasks.find(task => task.id === selectedTaskId);}
  function renderChat() {
    const task = selectedTask();
    $('chat-context').textContent = task ? task.question : 'Создай вариант и выбери задание.'; $('chat-context-details').open = false;
    $('chat-messages').innerHTML = task?.chat?.length ? task.chat.map(message => `<div class="chat-message ${message.role === 'user' ? 'from-student' : 'from-assistant'}"><span class="message-author">${message.role === 'user' ? 'Ты' : 'Ассистент'}</span><div class="model-text">${escapeHtml(message.content)}</div></div>`).join('') : '<div class="chat-welcome"><span class="assistant-avatar" aria-hidden="true">п.</span><p>Разберём задание вместе.<br>Спроси о непонятном шаге или начни с подсказки.</p></div>';
    $('chat-error').hidden = true; $('chat-input').value = '';
    const messages = $('chat-messages'); messages.scrollTop = messages.scrollHeight;
  }
  function appendChat(role, content) {
    const task = selectedTask(); if (!task) return;
    task.chat.push({role, content}); task.chat = task.chat.slice(-24); renderChat();
  }
  function showSolution(taskId, index) {
    const result = solutions.get(taskId); if (!result) return;
    $('solution-answer-' + index).textContent = result.answer; $('solution-explanation-' + index).textContent = result.explanation; $('solution-' + index).hidden = false;
  }
  function acceptVariant(value) {
    current = publicVariant(value); history = [current, ...history.filter(variant => variant.id !== current.id)].slice(0, 20); selectedTaskId = current.tasks[0].id;
    $('topic').value = current.config.topic; $('count').value = current.config.count; $('source').value = current.source;
    for (const input of doc.querySelectorAll('input[name="level"]')) input.checked = input.value === current.config.level;
    render(); persist();
  }
  async function generate({source = $('source').value, notify = true} = {}) {
    if (busy) return false;
    const config = configFromForm();
    if (!validConfig(config)) {toast('Выбери целое количество заданий от 1 до 10.'); $('count').focus(); return false;}
    $('generation-error').hidden = true; setBusy(true, source === 'ai' ? 'Создаём задания с ИИ. Это может занять до четырёх минут…' : 'Готовим задания…');
    try {
      const data = await api('/api/generate', {config, variantId: Math.max(0, ...history.map(variant => variant.number)) + 1, source});
      acceptVariant(data.variant); if (notify) toast('Вариант готов. Попробуй решить первое задание самостоятельно.'); return true;
    } catch (error) {$('generation-error').textContent = errorText(error); $('generation-error').hidden = false; return false;}
    finally {setBusy(false);}
  }
  async function loadVariant(id) {
    if (busy) return false;
    setBusy(true, 'Открываем вариант…');
    try {acceptVariant((await api('/api/variants/' + encodeURIComponent(id))).variant); $('history-dialog').close(); return true;}
    catch (error) {$('generation-error').textContent = errorText(error); $('generation-error').hidden = false; $('history-dialog').close(); return false;}
    finally {setBusy(false);}
  }
  function renderHistory() {
    const query = $('history-search').value.trim().toLocaleLowerCase('ru-RU');
    const found = history.filter(variant => `${variant.number} ${TOPICS[variant.config.topic].name} ${LEVELS[variant.config.level].name}`.toLocaleLowerCase('ru-RU').includes(query));
    $('history-list').innerHTML = found.length ? found.map(variant => `<div class="history-entry"><div><h3>Вариант ${String(variant.number).padStart(3, '0')} · ${escapeHtml(TOPICS[variant.config.topic].name)}</h3><p>${LEVELS[variant.config.level].name} · ${variant.tasks.length} ${plural(variant.tasks.length)} · проверено верно ${variant.solved.filter(Boolean).length}<br>${variant.source === 'ai' ? 'ИИ' : 'Шаблоны'}</p></div><button type="button" class="secondary-button" data-load="${escapeHtml(variant.id)}" data-request>Открыть</button></div>`).join('') : '<p class="empty-history">Вариантов не найдено. Попробуй другую тему или номер.</p>';
  }
  async function showHistory() {if (!busy) {$('history-search').value = ''; renderHistory(); $('history-dialog').showModal();}}
  async function checkAnswer(index) {
    if (busy || !current?.tasks[index]) return;
    const task = current.tasks[index], input = $('answer-' + index), answer = input.value.trim(); $('task-error-' + index).hidden = true;
    if (!answer) {$('task-error-' + index).textContent = 'Сначала введи ответ или свой ход решения.'; $('task-error-' + index).hidden = false; input.focus(); return;}
    saved.drafts[task.id] = input.value; persist(); setBusy(true, 'Проверяем ответ. Дождись объяснения…');
    try {
      const result = await api('/api/tasks/' + encodeURIComponent(task.id) + '/check', {answer});
      if (!Object.hasOwn(labels, result.verdict)) throw new Error('Не удалось понять результат проверки. Попробуй ещё раз.');
      feedback.set(task.id, result); renderFeedback(task.id, index); current.solved[index] ||= result.verdict === 'correct';
      $('task-' + index).classList.toggle('solved', current.solved[index]); $('verified-' + index).hidden = !current.solved[index];
      updateProgress(); $('announcer').textContent = `Задание ${index + 1}: ${labels[result.verdict]}.`;
    } catch (error) {$('task-error-' + index).textContent = errorText(error); $('task-error-' + index).hidden = false;}
    finally {setBusy(false);}
  }
  async function taskAction(action, index) {
    if (busy || !current?.tasks[index]) return;
    const task = current.tasks[index]; selectedTaskId = task.id; $('chat-task').value = task.id; renderChat();
    if (action === 'discuss') {$('assistant-panel').scrollIntoView({behavior: 'smooth', block: 'start'}); $('chat-input').focus({preventScroll: true}); return;}
    if (action === 'solution' && solutions.has(task.id)) {showSolution(task.id, index); $('solution-' + index).scrollIntoView({behavior: 'smooth', block: 'nearest'}); return;}
    setBusy(true, action === 'solution' ? 'Открываем решение…' : 'Готовим подсказку…'); $('task-error-' + index).hidden = true;
    try {
      const result = await api('/api/tasks/' + encodeURIComponent(task.id) + '/' + action, {});
      if (action === 'solution') {
        if (typeof result.answer !== 'string' || typeof result.explanation !== 'string') throw new Error('Не удалось загрузить решение. Попробуй ещё раз.');
        solutions.set(task.id, result); showSolution(task.id, index);
        $('solution-' + index).scrollIntoView({behavior: 'smooth', block: 'nearest'});
        toast('Решение открыто под условием задания.');
      } else {
        if (typeof result.message !== 'string') throw new Error('Не удалось получить подсказку. Попробуй ещё раз.');
        hints.set(task.id, result.message); $('hint-' + index).textContent = result.message; $('hint-' + index).hidden = false;
        appendChat('user', 'Дай подсказку'); appendChat('assistant', result.message);
      }
    } catch (error) {$('task-error-' + index).textContent = errorText(error); $('task-error-' + index).hidden = false; $('chat-error').textContent = errorText(error); $('chat-error').hidden = false;}
    finally {setBusy(false);}
  }
  async function chatAction(action) {
    if (busy || !selectedTask()) return;
    const index = current.tasks.findIndex(task => task.id === selectedTaskId);
    if (action === 'solution' || action === 'hint') return taskAction(action, index);
    const task = selectedTask(), text = action === 'simpler' ? 'Объясни проще' : $('chat-input').value.trim(); $('chat-error').hidden = true;
    if (action !== 'similar' && !text) {$('chat-error').textContent = 'Напиши вопрос по выбранному заданию.'; $('chat-error').hidden = false; $('chat-input').focus(); return;}
    setBusy(true, action === 'similar' ? 'Создаём похожее задание…' : 'Ассистент готовит объяснение. Это может занять до четырёх минут…');
    try {
      if (action === 'similar') {acceptVariant((await api('/api/tasks/' + encodeURIComponent(task.id) + '/similar', {})).variant); toast('Похожее задание готово — начни с собственной попытки.');}
      else {
        const result = await api('/api/tasks/' + encodeURIComponent(task.id) + '/chat', {message: text, ...(action === 'simpler' ? {action: 'simpler'} : {})});
        if (typeof result.message !== 'string') throw new Error('Ассистент не прислал объяснение. Попробуй ещё раз.');
        appendChat('user', text); appendChat('assistant', result.message);
      }
    } catch (error) {$('chat-error').textContent = errorText(error); $('chat-error').hidden = false;}
    finally {setBusy(false);}
  }
  function downloadVariant() {
    if (!current) return;
    const text = ['ПРАКТИКУМ · Вариант ' + String(current.number).padStart(3, '0'), `${TOPICS[current.config.topic].name} · ${LEVELS[current.config.level].name}`, '', ...current.tasks.flatMap((task, index) => ['ЗАДАНИЕ ' + (index + 1) + '. ' + task.tag, task.question, ''])].join('\n');
    if (env.download) return env.download(text);
    const url = URL.createObjectURL(new Blob(['\uFEFF' + text], {type: 'text/plain;charset=utf-8'})), link = doc.createElement('a');
    link.href = url; link.download = `praktikum-${current.number}.txt`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $('generator-form').addEventListener('submit', event => {event.preventDefault(); return generate();});
  $('regenerate').addEventListener('click', () => generate());
  $('task-list').addEventListener('submit', event => {const form = event.target.closest('form[data-check]'); if (form) {event.preventDefault(); return checkAnswer(Number(form.dataset.check));}});
  $('task-list').addEventListener('input', event => {if (event.target.matches('[data-answer]')) {const task = current?.tasks[Number(event.target.dataset.answer)]; if (task) {saved.drafts[task.id] = event.target.value; persist();}}});
  $('task-list').addEventListener('click', event => {const button = event.target.closest('[data-task-action]'); if (button) return taskAction(button.dataset.taskAction, Number(button.dataset.index));});
  $('chat-task').addEventListener('change', () => {selectedTaskId = $('chat-task').value; renderChat();});
  $('chat-form').addEventListener('submit', event => {event.preventDefault(); return chatAction('message');});
  $('chat-quick-actions').addEventListener('click', event => {const button = event.target.closest('[data-chat-action]'); if (button) return chatAction(button.dataset.chatAction);});
  $('download-variant').addEventListener('click', downloadVariant); $('print-variant').addEventListener('click', () => globalThis.print());
  for (const id of ['topic', 'count', 'source']) $(id).addEventListener(id === 'count' ? 'input' : 'change', updateSettings);
  for (const input of doc.querySelectorAll('input[name="level"]')) input.addEventListener('change', updateSettings);
  for (const [id, step] of [['decrease', -1], ['increase', 1]]) $(id).addEventListener('click', () => {$('count').value = Math.max(1, Math.min(10, (Math.trunc(Number($('count').value)) || 1) + step)); updateSettings();});
  $('nav-history').addEventListener('click', showHistory); $('history-search').addEventListener('input', renderHistory);
  $('history-list').addEventListener('click', event => {const button = event.target.closest('[data-load]'); if (button) return loadVariant(button.dataset.load);});
  for (const id of ['nav-guide', 'footer-about']) $(id).addEventListener('click', () => $('guide-dialog').showModal());
  $('nav-generator').addEventListener('click', () => {$('config-title').scrollIntoView({behavior: 'smooth', block: 'center'}); $('topic').focus({preventScroll: true});});
  for (const button of doc.querySelectorAll('[data-close]')) button.addEventListener('click', () => button.closest('dialog').close());
  for (const dialog of doc.querySelectorAll('dialog')) dialog.addEventListener('click', event => {if (event.target === dialog) {const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();}});

  async function initialize() {
    if (env.offline || globalThis.location?.protocol === 'file:') {
      $('connection-status').textContent = 'Для этой версии нужен запущенный сервер.';
      $('generation-error').textContent = 'Запусти проект командой npm start и открой адрес сервера в браузере. Инструкция — в README. Проверка ответов и ассистент работают через сервер.';
      $('generation-error').hidden = false;
      for (const node of doc.querySelectorAll('#generator-form input, #generator-form select, #generator-form button')) node.disabled = true;
      return;
    }
    setBusy(true, 'Подключаем учебную практику…');
    const results = await Promise.allSettled([api('/api/status'), api('/api/history')]);
    aiAvailable = results[0].status === 'fulfilled' && results[0].value.aiAvailable === true; $('ai-option').disabled = !aiAvailable;
    $('connection-status').textContent = aiAvailable ? 'ИИ подключён. Запрос отправится только после твоего действия.' : 'Обычная практика доступна. Для свободного чата и сложных проверок нужен ИИ.';
    let found = false;
    if (results[1].status === 'fulfilled') {
      try {
        history = (results[1].value.variants || []).slice(0, 20).map(publicVariant);
        const previous = history.find(variant => variant.id === saved.activeId) || history[0];
        if (previous) {acceptVariant(previous); found = true;}
        else if (saved.activeId) toast('Предыдущая сессия закончилась. Создадим новый вариант.');
      } catch (error) {$('generation-error').textContent = errorText(error); $('generation-error').hidden = false;}
    }
    setBusy(false);
    if (!found && results[1].status === 'fulfilled') await generate({source: 'local', notify: false});
    else if (!found) {$('generation-error').textContent = errorText(results[1].reason); $('generation-error').hidden = false;}
    // Select AI for the next explicit generation, never for an automatic request.
    if (aiAvailable && current?.source !== 'ai') {$('source').value = 'ai'; updateSettings();}
    if (!current) {$('empty-state').hidden = false; updateProgress();}
  }
  const ready = initialize();
  return {ready, generate, loadVariant, showHistory, checkAnswer, chatAction, updateSettings,
    getState: () => ({history, current, tasks: current?.tasks || [], busy, selectedTaskId, aiAvailable})};
}

if (typeof document !== 'undefined') {
  let storage; try {storage = globalThis.localStorage;} catch {}
  mountApp(document, storage);
}
