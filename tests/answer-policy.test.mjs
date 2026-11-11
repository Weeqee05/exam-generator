import assert from 'node:assert/strict';
import {test} from 'node:test';
import {incompleteAttempt} from '../server/answer-policy.mjs';
import {checkDeterministic} from '../server/checker.mjs';

test('copied source expressions cannot be credited simply by evaluating the input',()=>{
 for(const [question,answer,copy] of [
  ['Вычисли сумму (3 + 2i) + (1 + 5i).','4+7i','(3+2i)+(1+5i)'],
  ['Вычисли 2 + 3.','5','Ответ: 2+3'],
  ['Найди значение (8 − 2) / 3.','2','(8-2)/3'],
  ['Вычисли \\(2^{3} + 1\\).','9','2^3+1'],
  ['Вычисли √4 + 3.','5','sqrt(4)+3'],
 ]) {
  const task={question,answer};
  if(!copy.includes('sqrt') && !question.includes('^{')) assert.equal(checkDeterministic(task,copy)?.verdict,'correct','baseline calculator evaluates an uncomputed expression');
  assert.equal(incompleteAttempt(task,copy)?.verdict,'clarify',copy);
  assert.equal(incompleteAttempt(task,question)?.verdict,'clarify',question);
  assert.equal(incompleteAttempt(task,answer),null,answer);
 }
});

test('finished fractions, complex values and ordinary questions remain usable',()=>{
 for(const answer of ['1/2','0,5','2/4','3+2i','3 + 2*i','2i+3','-i','√3','-1+sqrt(3)*i','Мой ответ: 0,5']) {
  assert.equal(incompleteAttempt({question:`Вычисли ${answer} + 0.`},answer),null,answer);
 }
 assert.equal(incompleteAttempt({question:'Вычисли 2+3.'},'Как вычислить 2+3?'),null);
 assert.equal(incompleteAttempt({question:'Вычисли 2+3.'},'2+3=5'),null);
 assert.equal(incompleteAttempt({question:'Найди число отношений.'},'2^12'),null);
});
