import assert from 'node:assert/strict';
import {test} from 'node:test';
import {directAction,feedbackParagraphs} from '../dist/dialogue.mjs';

test('explicit tutoring commands do not become submitted answers',()=>{
  for(const text of ['Покажи решение','Напиши подробное решение','Дай пошаговое решение этого задания, пожалуйста!','Можешь показать решение?','Можете написать полное решение?','Пожалуйста, можешь показать мне ответ?']) assert.equal(directAction(text),'solution',text);
  assert.equal(directAction('Дай подсказку'),'hint');
  assert.equal(directAction('Объясни проще'),'simpler');
  assert.equal(directAction('Дай похожее задание'),'similar');
  assert.equal(directAction('Можешь дать мне подсказку?'),'hint');
  assert.equal(directAction('Создайте похожее задание, пожалуйста'),'similar');
  assert.equal(directAction('Можешь объяснить проще?'),'simpler');
});
test('student answers and negated solution requests never disclose a solution automatically',()=>{
  for(const text of ['3 + 2i','Решение: сначала раскрываем скобки','Не показывай решение','Можешь не показывать решение?','Не можешь показать решение?','Правильно ли моё решение?','Почему так?','я получил 3 + 2i']) assert.equal(directAction(text),null,text);
});

test('clarification is a single explanation and useful feedback is not duplicated',()=>{
  assert.deepEqual(feedbackParagraphs({verdict:'clarify',explanation:'Какой ответ у тебя получился?',error:'Ответ отсутствует.',hint:'Сначала ответь.'}),['Какой ответ у тебя получился?']);
  assert.deepEqual(feedbackParagraphs({verdict:'incorrect',explanation:'Проверь знак в ответе.',error:'Проверь знак в ответе',hint:'Раскрой скобки ещё раз.'}),['Проверь знак в ответе.','Раскрой скобки ещё раз.']);
});
