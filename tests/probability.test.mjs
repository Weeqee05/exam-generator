import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validateProbabilityReference} from '../server/probability.mjs';

test('probability arithmetic accepts equivalent fractions and rejects inconsistent or unsafe references',()=>{
 const task={answer:'23/45',explanation:'Формула полной вероятности.\nОтвет: 46/90'};
 const calculation='(3/5)*(5/9)+(2/5)*(4/9)';
 assert.equal(validateProbabilityReference(task,calculation),true);
 assert.equal(validateProbabilityReference({...task,explanation:'По формуле получаем 23/45. Ответ: 23/45.'},calculation),true);
 for(const answer of ['37/80','-0.1','1.1','1/0','i','process.exit()']) assert.equal(validateProbabilityReference({...task,answer},calculation),false,answer);
 for(const input of [undefined,{},'', 'process.exit()', '1/0', '0.5', '('.repeat(500)+'1']) assert.equal(validateProbabilityReference(task,input),false);
 assert.equal(validateProbabilityReference({...task,explanation:'Ответ: 37/80'},calculation),false);
 assert.equal(validateProbabilityReference({...task,explanation:'Нет итоговой строки'},calculation),false);
 assert.equal(validateProbabilityReference({answer:'0',explanation:'Ответ: 0'},'0.00000000000000000001'),false);
 for(const answer of ['0','1','0,5']) assert.equal(validateProbabilityReference({answer,explanation:`Ответ: ${answer}`},answer),true);
});
