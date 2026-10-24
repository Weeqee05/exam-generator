// A small literal safeguard, not a semantic verifier of arbitrary model text.
// Reference fields themselves are only returned by the explicit solution route.
const GENERIC_HINT = 'Выпиши, что дано и что требуется найти. Выбери подходящее определение или формулу и выполни только первый шаг.';
const GENERIC_TUTOR = 'Попробуй начать с одного шага: выдели исходные данные и нужную формулу. Напиши, на каком переходе возник вопрос. Полное решение можно открыть кнопкой «Покажи решение».';

function normalized(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('ru-RU')
    .replace(/[−–—]/g, '-').replace(/(\d),(\d)/g, '$1.$2');
}
const compact = value => normalized(value).replace(/\s+/g, '');
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function containsReference(text, task, studentAnswer = '') {
  const message = compact(text);
  if (!message) return false;
  const solution = compact(task.explanation);
  if (solution.length >= 24 && message.includes(solution)) return true;
  const answer = compact(task.answer);
  if (!answer || compact(studentAnswer) === answer) return false;
  const numeric = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\/[+-]?\d+(?:\.\d+)?)?$/.test(answer);
  // Include signs in the boundary: expected 1 must not match the -1 in i² = -1,
  // and expected 17 must not match 117 or a larger expression token.
  const pattern = numeric ? escapeRegExp(answer) : [...answer].map(escapeRegExp).join('\\s*');
  const before = numeric ? '[\\p{L}\\p{N}_.+\\-/]' : '[\\p{L}\\p{N}_]';
  // A trailing full stop is punctuation; only a dot followed by a digit makes
  // the next decimal token (17.2) different from the reference number 17.
  const after = numeric ? '[\\p{L}\\p{N}_+\\-/]|\\.\\d' : '[\\p{L}\\p{N}_]';
  const occurrence = new RegExp(`(?<!${before})${pattern}(?!${after})`, 'u');
  if (numeric || answer.length >= 3) return occurrence.test(normalized(text));
  // A single i in a teaching formula is not itself an answer disclosure.
  return message === answer || (/(?:ответ|итог|результат)[:=]/u.test(message) && occurrence.test(normalized(text)));
}

export function safeHint(task) {
  return containsReference(task.hint, task) ? GENERIC_HINT : task.hint;
}

export function safeTutorMessage(task, message) {
  return containsReference(message, task) ? GENERIC_TUTOR : message;
}

export function safeFeedback(task, feedback, studentAnswer) {
  const result = {...feedback};
  const fallback = {
    correct: 'Ответ соответствует условию. Полное объяснение можно открыть отдельно.',
    incorrect: 'В ответе есть расхождение с условием. Перепроверь вычисления и выбранный способ решения.',
    partial: 'Часть ответа верна, но задание выполнено не полностью. Проверь, все ли требуемые результаты записаны.',
    clarify: 'Пока нельзя однозначно проверить ответ. Уточни, какие значения или вывод ты получил.'
  };
  for (const field of ['explanation', 'error', 'hint']) {
    if (containsReference(result[field], task, studentAnswer)) {
      result[field] = field === 'explanation' ? fallback[result.verdict]
        : field === 'error' ? 'Перепроверь соответствие ответа всем требованиям условия.' : safeHint(task);
    }
  }
  if (['incorrect', 'partial'].includes(result.verdict)) {
    result.error ||= 'Проверь последний переход: он должен соответствовать условию и выполненным вычислениям.';
    result.hint ||= safeHint(task);
  }
  if (result.verdict === 'clarify' && !/[?？]/u.test(result.explanation)) {
    result.explanation = result.explanation.slice(0, 1350) + ' Что означает твоя запись и какой итоговый ответ ты получил?';
  }
  return result;
}
