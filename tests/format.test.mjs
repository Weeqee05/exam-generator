import assert from 'node:assert/strict';
import {test} from 'node:test';
import {formatText} from '../dist/format.mjs';

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
