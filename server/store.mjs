import {randomUUID} from 'node:crypto';

// A small, bounded in-memory repository is enough for this educational version.
// Restarting the process deliberately clears sessions, tasks and reference answers.
export function createStore({now = Date.now, ttl = 24 * 60 * 60 * 1000, maxSessions = 100, maxTasks = 1000} = {}) {
  const sessions = new Map();
  function clean() {
    for (const [id, session] of sessions) if (session.until <= now()) sessions.delete(id);
  }
  function session(id, create = false) {
    clean();
    let value = sessions.get(id);
    if (!value && create) {
      while (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value);
      value = {id: randomUUID(), until: now() + ttl, variants: []};
      sessions.set(value.id, value);
    }
    if (value) {
      value.until = now() + ttl;
      // Map insertion order acts as least-recently-used eviction order.
      sessions.delete(value.id);
      sessions.set(value.id, value);
    }
    return value;
  }
  function add(owner, {number, config, source, tasks}) {
    const variant = {
      id: randomUUID(), number, config: {...config}, source, created: new Date(now()).toISOString(),
      tasks: tasks.map(task => ({...task, id: randomUUID(), chat: [], solved: false, attempts: []}))
    };
    owner.variants.unshift(variant);
    owner.variants.length = Math.min(owner.variants.length, 20);
    let count = () => [...sessions.values()].reduce((total, item) => total + item.variants.reduce((sum, entry) => sum + entry.tasks.length, 0), 0);
    while (count() > maxTasks) {
      const oldest = [...sessions.values()].find(item => item.id !== owner.id);
      if (oldest) sessions.delete(oldest.id);
      else if (owner.variants.length > 1) owner.variants.pop();
      else break;
    }
    return variant;
  }
  function findTask(owner, id) {
    for (const variant of owner?.variants || []) {
      const task = variant.tasks.find(item => item.id === id);
      if (task) return {variant, task};
    }
  }
  function remember(task, userMessage, response) {
    task.chat.push({role: 'user', content: userMessage}, {role: 'assistant', content: response});
    if (task.chat.length > 20) task.chat.splice(0, task.chat.length - 20);
  }
  return {session, add, findTask, remember};
}

// Explicit projection is the boundary between private references and the browser.
export function publicVariant(variant) {
  return {
    id: variant.id, number: variant.number, config: {...variant.config}, source: variant.source, created: variant.created,
    tasks: variant.tasks.map(task => ({id: task.id, tag: task.tag, question: task.question, chat: task.chat.map(item => ({...item}))})),
    solved: variant.tasks.map(task => task.solved)
  };
}
