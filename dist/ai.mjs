import {validConfig, escapeHtml} from './generator.mjs';

// Model output is untrusted plain text, never executable HTML or Python.
export function validateModelResult(data, config) {
  if (!validConfig(config) || !data || data.topic !== config.topic || data.difficulty !== config.level || !Array.isArray(data.tasks) || data.tasks.length !== config.count) {
    throw new Error('Модель вернула вариант с неверными параметрами. Попробуй ещё раз.');
  }
  const fields = ['type', 'question', 'hint', 'answer', 'explanation'];
  const tasks = data.tasks.map(task => {
    if (!task || fields.some(key => typeof task[key] !== 'string' || !task[key].trim() || task[key].length > (key === 'type' ? 100 : 8000))) {
      throw new Error('В ответе модели отсутствует условие, подсказка или решение. Попробуй ещё раз.');
    }
    return Object.fromEntries(fields.map(key => [key, task[key].trim()]));
  });
  if (new Set(tasks.map(task => task.question.toLocaleLowerCase('ru-RU').replace(/\s+/g, ' '))).size !== tasks.length) {
    throw new Error('Модель вернула повторяющиеся задания. Попробуй ещё раз.');
  }
  return {topic: config.topic, difficulty: config.level, tasks};
}

export function displayModelTasks(result, config) {
  return validateModelResult(result, config).tasks.map(task => ({
    tag: task.type,
    ...Object.fromEntries(['question', 'hint', 'answer', 'explanation'].map(key => [key, `<span class="model-text">${escapeHtml(task[key])}</span>`]))
  }));
}
