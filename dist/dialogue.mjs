// A few unambiguous commands are handled without an extra model request.
// Everything else is interpreted with the current exercise's context.
export function directAction(text) {
  const value = text.toLocaleLowerCase('ru-RU').trim().replace(/[.!?]+$/u, '').replace(/\s+/g, ' ')
    .replace(/^(?:пожалуйста[, ]+)?(?:можешь|можете|мог бы ты|могли бы вы) (?:мне )?/u, '')
    .replace(/^(?:показать|покажите) /u, 'покажи ').replace(/^(?:написать|напишите) /u, 'напиши ')
    .replace(/^(?:дать|дайте) /u, 'дай ').replace(/^(?:объяснить|объясните) /u, 'объясни ')
    .replace(/^(?:создать|создайте) /u, 'создай ');
  if (/^(?:пожалуйста[, ]+)?(?:покажи|напиши|распиши|дай|пришли|хочу|можно) (?:мне )?(?:(?:полное|подробное|пошаговое|полный|подробный) )?(?:решение|ответ|разбор)(?: (?:этого )?задания)?(?:[, ]+пожалуйста)?$/u.test(value)) return 'solution';
  if (/^(?:(?:дай|покажи) (?:мне )?)?подсказк[ау](?:[, ]+пожалуйста)?$/u.test(value)) return 'hint';
  if (/^(?:объясни проще|объясни попроще|можно проще)(?:[, ]+пожалуйста)?$/u.test(value)) return 'simpler';
  if (/^(?:дай|создай|покажи) (?:мне )?похожее задание(?:[, ]+пожалуйста)?$/u.test(value)) return 'similar';
  return null;
}

export const feedbackMethod = feedback => feedback.method === 'code' ? 'Проверено вычислением'
  : feedback.method === 'ai' ? 'Оценка ИИ — она может ошибаться' : 'Нужно уточнение для точной проверки';

// Feedback is conversational text. Clarification is not a list of mistakes.
export function feedbackParagraphs(feedback) {
  const paragraphs = [];
  const fields = ['incorrect','partial'].includes(feedback.verdict) ? ['explanation','error','hint'] : ['explanation'];
  const normalize = value => value.toLocaleLowerCase('ru-RU').replace(/[.,!?]/g,'');
  for (const key of fields) {
    const text = typeof feedback[key] === 'string' ? feedback[key].trim() : '';
    if (text && !paragraphs.some(value => normalize(value).includes(normalize(text)))) paragraphs.push(text);
  }
  return paragraphs;
}
