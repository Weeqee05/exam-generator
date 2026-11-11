// Catch a copied condition before either the calculator or the AI can credit it.
// This is a conservative text check: equivalent final fractions remain valid.
function mathText(value) {
  return value.toLocaleLowerCase('ru-RU').replace(/\\(?:left|right)/g,'')
    .replace(/\\sqrt\{([^{}]+)\}/g,'sqrt($1)').replace(/√(\d+(?:[.,]\d+)?)/g,'sqrt($1)')
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g,'($1)/($2)')
    .replace(/\\(?:[()[\]]|,|;|!)/g,'').replace(/\\(?:cdot|times)/g,'*')
    .replace(/[−–]/g,'-').replace(/[×·]/g,'*').replace(/²/g,'^2').replace(/³/g,'^3')
    .replace(/\*\*/g,'^').replace(/,/g,'.').replace(/[\s{}]/g,'');
}

function finalNumber(value) {
  value=value.replace(/(?<![\p{L}\p{N}_])\(([+-]?(?:\d+(?:\.\d+)?|\.\d+))\)/gu,'$1');
  const number='[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:e[+-]?\\d+)?';
  const real=`(?:${number})(?:/(?:${number}))?`;
  // Keep ordinary fractions, radicals and a + bi available as final answers.
  const term=`(?:${real}|(?:${real}\\*?)?(?:sqrt\\(\\d+(?:\\.\\d+)?\\)|√\\d+(?:\\.\\d+)?))`;
  return new RegExp(`^(?:${term}|[+-]?(?:${term}\\*?)?i|${term}[+-](?:${term}\\*?)?i|[+-]?(?:${term}\\*?)?i[+-]${term})$`).test(value);
}

export function incompleteAttempt(task, answer) {
  if(typeof answer!=='string' || typeof task?.question!=='string') return null;
  const input=mathText(answer.trim().replace(/^(?:(?:мой\s+)?ответ\s*[:=]\s*|я\s+получил[а]?\s*[:=]?\s*)/iu,''));
  const question=mathText(task.question);
  const ungroup=value=>value.replace(/[()]/g,'');
  const copiedQuestion=input.length>8 && input.replace(/[.!?]+$/u,'')===question.replace(/[.!?]+$/u,'');
  const expression=/^[\d.ei+*/^()√-]+$/.test(input) || /^[\d.eisqrt+*/^()√-]+$/.test(input) && input.includes('sqrt');
  const computation=/вычисл|слож|сумм|произведен|значени|чему рав|сколько|выведет/iu.test(task.question);
  const copiedExpression=computation && expression && !finalNumber(input.replace(/^\(([^()]+)\)$/u,'$1')) && input.length>=3
    && ungroup(question).includes(ungroup(input));
  if(!copiedQuestion && !copiedExpression) return null;
  return {verdict:'clarify',explanation:'Ты повторил условие или исходное выражение. Выполни вычисления и пришли полученный результат.',error:'',hint:'',method:'limited',needsClarification:true};
}
