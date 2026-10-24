import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkDeterministic} from '../server/checker.mjs';
import {makeTasks} from '../dist/generator.mjs';
import {plainText} from '../dist/export.mjs';

const task = (answer, proof) => ({question:'Учебное задание', answer, hint:'Не раскрывать этот текст автоматически.', explanation:'Эталонное решение', ...(proof ? {proof} : {})});
const check = (expected, answer) => checkDeterministic(task(expected), answer);

test('equivalent fractions, decimal comma and safe arithmetic are accepted', () => {
  for (const answer of ['0,5','0.50','2/4','(3-1)/4','Ответ: 1/2','x=0,5']) assert.equal(check('1/2',answer)?.verdict,'correct',answer);
  assert.equal(check('2^(49)','562949953421312').verdict,'correct');
  assert.equal(check('2^(49)','562949953421313').verdict,'incorrect','large integers must not use a broad relative tolerance');
  assert.equal(check('1/3','0.3333').verdict,'incorrect','rounded answers are not automatically equal');
  assert.equal(check('1e-20','0').verdict,'incorrect','small nonzero values are distinct from zero');
  assert.equal(check('1e-20','1e-20').verdict,'correct');
  assert.notEqual(check('0','1e-999')?.verdict,'correct','underflow must not turn nonzero input into zero');
  assert.notEqual(check('0','(1e-100)^4')?.verdict,'correct');
  assert.notEqual(check('0','(1e-50i)^20')?.verdict,'correct','complex exponentiation must not underflow into a false zero');
  assert.notEqual(check('9007199254740992','9007199254740993')?.verdict,'correct','unsafe integers must defer rather than collapse to the same Number');
  assert.equal(check('-4','-2^2').verdict,'correct');
  assert.equal(check('4','(-2)^2').verdict,'correct');
  assert.notEqual(check('12','1 2')?.verdict,'correct','separate values must not merge into a number');
});

test('wrong, empty and ambiguous answers do not pass or reveal a reference', () => {
  const incorrect = check('1/2','0.6');
  assert.equal(incorrect.verdict,'incorrect');
  assert.ok(incorrect.error && incorrect.hint);
  assert.ok(!JSON.stringify(incorrect).includes('1/2'));
  assert.equal(check('1/2','').verdict,'clarify');
  const ambiguous = check('1/2','0,5 или 0,6');
  assert.equal(ambiguous.verdict,'clarify');
  assert.equal(ambiguous.needsClarification,true);
});

test('complex numbers compare both components and detect a partial answer', () => {
  for (const answer of ['3+2i','2i+3','(6+4i)/2','3 + 2*i']) assert.equal(check('3 + 2i',answer)?.verdict,'correct',answer);
  assert.equal(check('3+2i','3-2i').verdict,'partial');
  assert.equal(check('3+2i','4-2i').verdict,'incorrect');
  assert.equal(check('-i','i^3').verdict,'correct');
  assert.equal(check('-1+√3i','-1+sqrt(3)*i').verdict,'correct');
});

test('sets ignore order and repetitions, while Python lists preserve them', () => {
  assert.equal(check('{1; 2; 3}','{3,1,2,2}').verdict,'correct');
  assert.equal(check('{1; 2; 3}','{1; 2}').verdict,'partial');
  assert.equal(check('{1; 2; 3}','{8; 9}').verdict,'incorrect');
  assert.equal(check('{1/2; 2}','{2; 0,5}').verdict,'correct');
  assert.equal(check('{}','∅').verdict,'correct');
  assert.equal(check('[1, 2, 2]','[1,2,2]').verdict,'correct');
  assert.notEqual(check('[1, 2, 2]','[2,1,2]').verdict,'correct');
  assert.notEqual(check('[1, 2, 2]','[1,2]').verdict,'correct');
  assert.equal(check('[(1,2), (3,4)]','[(1, 2),(3,4)]').verdict,'correct');
  assert.notEqual(check('[1,2]','(1,2)')?.verdict,'correct','a Python tuple is not a list');
  assert.notEqual(check('[(1,2),[3,4]]','[[1,2],(3,4)]')?.verdict,'correct','nested container types must also match');
  assert.equal(check('[(1,2),[3,4]]','[(1,2),[3,4]]').verdict,'correct');
  const tupleOutput = {...task('(1,2)'),question:'Что выведет программа Python?'};
  assert.equal(checkDeterministic(tupleOutput,'(1,2)').verdict,'correct');
  assert.notEqual(checkDeterministic(tupleOutput,'[1,2]')?.verdict,'correct');
  assert.notEqual(checkDeterministic(tupleOutput,'1,2')?.verdict,'correct','a printed tuple is not a decimal');
});

test('template proof parameters are used, rather than blindly trusting stored answer text', () => {
  const addition = task('Ошибочный эталон',{kind:'complex-add',a:1,b:2,c:3,d:4,re:999,im:999});
  assert.equal(checkDeterministic(addition,'4+6i').verdict,'correct');
  const digitSum = task('999',{kind:'python-digit-sum',n:1234,answer:999});
  assert.equal(checkDeterministic(digitSum,'10').verdict,'correct');
  const relation = task('0',{kind:'relations-count',a:3,b:4});
  assert.equal(checkDeterministic(relation,'2^12').verdict,'correct');
});

test('compound outputs require both parts and reasoning tasks defer to the AI', () => {
  const digits = task('12 3',{kind:'python-digits',n:123});
  assert.equal(checkDeterministic(digits,'12 3').verdict,'correct');
  assert.equal(checkDeterministic(digits,'12; 4').verdict,'partial');
  assert.notEqual(checkDeterministic(digits,'12')?.verdict,'correct');
  const proof = task('Это эквивалентность. 3 класса.',{kind:'mod-equivalence',m:3});
  assert.equal(checkDeterministic(proof,'3'),null);
  assert.equal(checkDeterministic(proof,'Это эквивалентность. 3 класса.'),null);
  assert.equal(check('4','Пусть x = 2. Тогда я прибавляю ещё 2, получаю 4.'),null);
});

test('a numeric model reference does not waive proof or multiple-part requirements', () => {
  for (const question of [
    'Докажи, что 2 + 2 = 4. Обоснуй каждый шаг.',
    'Вычисли 2 + 2 и объясни, почему результат именно такой.',
    'Найди значение 2 + 2. Поясни ход решения.',
    'Вычисли 2 + 2 и 3 + 3.',
    'Найди модуль и сопряжённое число.',
    'Prove that 2 + 2 = 4 and justify your answer.'
  ]) {
    assert.equal(checkDeterministic({...task('4'),question},'4'),null,question);
  }
  assert.equal(checkDeterministic({...task('4'),question:'Вычисли 2 + 2.'},'4').verdict,'correct');
});

test('untrusted code, impossible arithmetic and excessive expressions are never executed', () => {
  globalThis.__checkerExecuted = false;
  for (const answer of ['globalThis.__checkerExecuted=true','process.exit(0)','(()=>4)()','import("node:fs")','1/0','sqrt(-1)','2^1001','('.repeat(100)+'1'+')'.repeat(100),'1+'.repeat(500)+'1']) {
    assert.notEqual(check('4',answer)?.verdict,'correct',answer);
  }
  assert.equal(globalThis.__checkerExecuted,false);
  delete globalThis.__checkerExecuted;
});

test('all supported template families accept their independently generated final answer', () => {
  let checked = 0;
  for (const topic of ['complex','sets','python']) for (const level of ['easy','medium','hard']) {
    for (let seed = 1; seed <= 20; seed++) for (const item of makeTasks({topic,level,count:3},seed)) {
      const plain = {...item, answer:plainText(item.answer)};
      const result = checkDeterministic(plain,plain.answer);
      if (result !== null) { assert.equal(result.verdict,'correct',JSON.stringify({topic,level,proof:item.proof,answer:plain.answer,result})); checked++; }
    }
  }
  assert.ok(checked > 350,`Too few supported short-answer cases: ${checked}`);
});
