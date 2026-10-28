import {evaluateReal} from './checker.mjs';

// This catches inconsistent arithmetic, not an incorrect choice of formula.
// The calculation is private and never included in a public task projection.
export function validateProbabilityReference(task, calculation) {
  if(typeof calculation!=='string' || !/^[\d\s.,()+*/^−–×·÷-]+$/u.test(calculation)) return false;
  const answer = evaluateReal(task.answer);
  const computed = evaluateReal(calculation);
  // Accept the final answer on the same line as the last step too.
  const finalAnswer = task.explanation.trim().match(/(?:^|\s)Ответ:\s*([^\n]+)$/u);
  const explained = finalAnswer ? evaluateReal(finalAnswer[1].trim().replace(/\.$/u,'')) : null;
  const equal = (a,b) => a !== null && b !== null && Math.abs(a-b) <= Math.max(Math.abs(a),Math.abs(b))*Number.EPSILON*16;
  return answer !== null && answer >= 0 && answer <= 1 && equal(answer,computed) && equal(answer,explained);
}
