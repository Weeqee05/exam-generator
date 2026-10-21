import {TOPICS, LEVELS} from './generator.mjs';

export function plainText(html) {
  return html.replace(/<sup>(.*?)<\/sup>/g, '^($1)').replace(/<br\s*\/?\s*>|<\/?pre>|<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
}

export function exportVariant(variant, tasks, includeAnswers = false) {
  const lines = ['ПРАКТИКУМ · Вариант ' + String(variant.id).padStart(3, '0'), `${TOPICS[variant.config.topic].name} · ${LEVELS[variant.config.level].name}`, `Создан: ${new Date(variant.created).toLocaleDateString('ru-RU')}`, `Источник: ${variant.source === 'ai' ? 'Языковая модель. Ответы требуют самостоятельной проверки.' : 'Локальные шаблоны'}`, ''];
  tasks.forEach((task, index) => {
    lines.push(`ЗАДАНИЕ ${index + 1}. ${task.tag}`, plainText(task.question), '');
    if (includeAnswers) lines.push('Подсказка: ' + plainText(task.hint), 'Ответ: ' + plainText(task.answer), 'Решение: ' + plainText(task.explanation), '');
  });
  return lines.join('\n');
}
