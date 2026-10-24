// A few unambiguous commands are handled without an extra model request.
// Everything else is interpreted with the current exercise's context.
export function directAction(text) {
  const value = text.toLocaleLowerCase('ru-RU').trim().replace(/[.!?]+$/u, '').replace(/\s+/g, ' ');
  if (/^(?:пожалуйста[, ]+)?(?:покажи|напиши|распиши|дай|пришли|хочу|можно) (?:мне )?(?:(?:полное|подробное|пошаговое|полный|подробный) )?(?:решение|ответ|разбор)(?: (?:этого )?задания)?(?:[, ]+пожалуйста)?$/u.test(value)) return 'solution';
  if (/^(?:дай |покажи )?подсказк[ау](?:[, ]+пожалуйста)?$/u.test(value)) return 'hint';
  if (/^(?:объясни проще|объясни попроще|можно проще)$/u.test(value)) return 'simpler';
  if (/^(?:дай|создай|покажи) похожее задание$/u.test(value)) return 'similar';
  return null;
}

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
