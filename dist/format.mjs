import katex from './vendor/katex/katex.mjs';
import {escapeHtml} from './generator.mjs';

// Display-only formatting. Original answers and exports stay plain text.
function formula(source, display = false, plain = false) {
  if (source.length > 2000) return escapeHtml(source);
  let tex = source;
  if (plain) tex = tex.replace(/²/g,'^2').replace(/³/g,'^3').replace(/[−–]/g,'-')
    .replace(/≤/g,'\\le ').replace(/≥/g,'\\ge ').replace(/≠/g,'\\ne ')
    .replace(/[×·]/g,'\\cdot ').replace(/÷/g,'\\div ')
    .replace(/\^\(([^()]*)\)/g,'^{$1}').replace(/\^(-?\d+)/g,'^{$1}')
    .replace(/(?:sqrt|√)\(([^()]*)\)/g,'\\sqrt{$1}').replace(/√(\d+|[a-z])/g,'\\sqrt{$1}')
    .replace(/(?<![\w}])(\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)(?![\w{])/g,'\\frac{$1}{$2}')
    .replace(/\|([^|]+)\|/g,'\\left|$1\\right|');
  try {
    return `<span class="math-formula${display?' math-block':''}">${katex.renderToString(tex,{
      displayMode:display,throwOnError:true,trust:false,strict:'ignore',maxExpand:100,maxSize:8,output:'htmlAndMathml'
    })}</span>`;
  } catch { return escapeHtml(source); }
}

// A narrow recognizer for older tasks such as |x^2 - 4x - 5| < 7.
// Ordinary words are excluded; explicit LaTeX supports more complex notation.
const token = '(?:\\d+(?:[.,]\\d+)?|(?:sqrt|sin|cos|tan|log|ln)(?!\\p{L})|(?<!\\p{L})[a-zA-Zα-ωΑ-Ω](?!\\p{L})|[+−–*/^_=<>≤≥≠±×÷·√|()\\[\\]{}²³-])';
const plainMath = new RegExp(`(?<![\\p{L}\\p{N}_])${token}(?:[ \\t]*${token})*`,'gu');
function plainText(text) {
  let html='',position=0;
  for (const match of text.matchAll(plainMath)) {
    const value=match[0].trimEnd();
    html+=escapeHtml(text.slice(position,match.index));
    const mathematical = /\d|[a-zA-Zα-ωΑ-Ω]/u.test(value) && /[+−–*/^_=<>≤≥≠±×÷·√|²³-]/u.test(value);
    html+=mathematical ? formula(value,false,true) : escapeHtml(value);
    html+=escapeHtml(match[0].slice(value.length));position=match.index+match[0].length;
  }
  return html+escapeHtml(text.slice(position));
}

export function formatText(text) {
  const source=String(text), chunks=/```[^\n`]*\n[\s\S]*?```|`[^`\n]+`|https?:\/\/[^\s]+|<\/?[A-Za-z!][^>\n]*>|\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<!\\)\$[^$\n]+\$/g;
  let html='',position=0;
  for (const match of source.matchAll(chunks)) {
    html+=plainText(source.slice(position,match.index));const value=match[0];
    if (value.startsWith('```')) html+=`<pre class="code-block"><code>${escapeHtml(value.slice(value.indexOf('\n')+1,-3))}</code></pre>`;
    else if (value.startsWith('`')) html+=`<code class="inline-code">${escapeHtml(value.slice(1,-1))}</code>`;
    else if (/^(?:https?:|<)/.test(value)) html+=escapeHtml(value);
    else {
      const display=value.startsWith('$$')||value.startsWith('\\['), width=value.startsWith('$')&&!display?1:2;
      const expression=value.slice(width,-width);
      const formatted=formula(expression,display);
      html+=formatted===escapeHtml(expression)?escapeHtml(value):formatted;
    }
    position=match.index+value.length;
  }
  return html+plainText(source.slice(position));
}
