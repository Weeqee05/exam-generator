import assert from 'node:assert/strict';
import {test} from 'node:test';
import {formatText} from '../dist/format.mjs';
import {validateModelResult} from '../dist/ai.mjs';

test('an existing plain-text inequality gets typeset powers and absolute-value bars',()=>{
  const text='Найдите все целые решения неравенства |x^2 - 4x - 5| < 7. Запишите их через запятую.';
  const html=formatText(text);
  assert.match(html,/Найдите все целые/);assert.match(html,/class="katex"/);
  assert.match(html,/<msup>/);assert.match(html,/Запишите их через запятую/);
  assert.ok(!html.includes('katex-error'));
  assert.match(formatText('Доля 1/2'),/<mfrac>/);
});

test('explicit LaTeX fractions, roots and display equations are formatted',()=>{
  for(const text of [String.raw`Найди \(\frac{x^2}{2}\).`,String.raw`$$\sqrt{x+1} \ge 2$$`,String.raw`\[x_{12} = \frac{1}{2}\]`]) {
    const html=formatText(text);assert.match(html,/<math/);assert.ok(!html.includes('katex-error'));
  }
  assert.match(formatText('x^(n+1) = √(x+1)'),/<msqrt>/);
});

test('code, URLs and ordinary text keep their contents',()=>{
  assert.equal(formatText('Привет, давай разберёмся.'),'Привет, давай разберёмся.');
  assert.equal(formatText('https://example.org/a^2'),'https://example.org/a^2');
  assert.match(formatText('`x**2 < 7`'),/^<code class="inline-code">x\*\*2 &lt; 7<\/code>$/);
  const html=formatText('```python\nprint("<img src=x>")\nx = 2**3\n```');
  assert.match(html,/&lt;img src=x&gt;/);assert.ok(!html.includes('class="katex"'));
});

test('HTML and unsafe TeX cannot inject scripts, links, images or styles',()=>{
  for(const text of ['<img src=x onerror=alert(1)>',String.raw`\(\href{javascript:alert(1)}{x}\)`,String.raw`\(\includegraphics{https://evil.invalid/x}\)`,String.raw`\(\htmlStyle{position:fixed}{x}\)`]) {
    const html=formatText(text);
    assert.ok(!/<(?:script|img|iframe|a)\b/i.test(html),text);
    assert.ok(!html.includes('href='));assert.ok(!html.includes('position:fixed;'));
  }
});

test('invalid and excessively expanded math falls back to escaped readable text',()=>{
  assert.equal(formatText(String.raw`\(\frac{\)`),String.raw`\(\frac{\)`);
  assert.match(formatText(String.raw`\(\def\a{\a}\a\)`),/\\def/);
  assert.ok(formatText('x^'+'2'.repeat(2100)).length<3000);
});

test('a safe JSON numeric reference is normalized, while missing and unsafe answers are rejected',()=>{
  const config={topic:'algebra',level:'easy',count:1};
  const task={type:'Вычисление',question:'Найди сумму 2 и 3.',hint:'Сложи слагаемые.',answer:5,explanation:'2 + 3 = 5.'};
  const result=answer=>({topic:'algebra',difficulty:'easy',tasks:[{...task,answer}]});
  for(const answer of [5,0,0.5,-2])assert.equal(validateModelResult(result(answer),config).tasks[0].answer,String(answer));
  for(const answer of [NaN,Infinity,Number.MAX_SAFE_INTEGER+1,null,{},''])assert.throws(()=>validateModelResult(result(answer),config));
});
