// A deliberately small calculator, not a JavaScript or Python interpreter.
// It compares short, unambiguous final answers. Free-form proofs go to the AI.
const MAX_INPUT = 400;
const scalar = value => [value, 0];
const isReal = value => value[1] === 0;
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const negate = a => [-a[0], -a[1]];
const normalize = value => value.replace(/[−–]/g, '-').replace(/[×·]/g, '*').replace(/÷/g, '/').replace(/\*\*/g, '^').replace(/²/g, '^2').replace(/³/g, '^3');

function close(a, b) {
  if (Number.isSafeInteger(a) && Number.isSafeInteger(b)) return a === b;
  return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * Number.EPSILON * 16;
}
const sameComplex = (a, b) => close(a[0], b[0]) && close(a[1], b[1]);

// Recursive descent: expression -> product -> unary -> power -> atom.
// Only fixed operators and numeric literals are accepted; there is no eval.
function expression(source, allowDecimalComma = true) {
  if (typeof source !== 'string' || source.length > MAX_INPUT) return null;
  // Do not merge two space-separated output values into a different number.
  if (/[\d.,]\s+[\d.,]/.test(source)) return null;
  const text = normalize(source).replace(/\s+/g, '');
  if (!text) return null;
  let position = 0, operations = 0, depth = 0;
  const bounded = value => {
    if (++operations > 256 || value.some(number => !Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER || number !== 0 && Math.abs(number) < 1e-100)) throw Error('limit');
    return value;
  };
  function checkedMultiply(a, b) {
    const products = [[a[0],b[0]],[a[1],b[1]],[a[0],b[1]],[a[1],b[0]]].map(([left,right]) => {
      const product = left * right;
      if (left !== 0 && right !== 0 && product === 0) throw Error('underflow');
      return bounded(scalar(product))[0];
    });
    return bounded([products[0] - products[1],products[2] + products[3]]);
  }
  const startsAtom = () => /[\di(√]/.test(text[position] || '') || text.startsWith('sqrt', position);
  function atom() {
    if (++depth > 32) throw Error('depth');
    let result;
    if (text[position] === '(') {
      position++;
      result = sum();
      if (text[position++] !== ')') throw Error('parenthesis');
    } else if (text[position] === 'i') {
      position++;
      result = [0, 1];
    } else if (text[position] === '√' || text.startsWith('sqrt', position)) {
      position += text[position] === '√' ? 1 : 4;
      const value = atom();
      if (!isReal(value) || value[0] < 0) throw Error('sqrt');
      result = scalar(Math.sqrt(value[0]));
    } else {
      const pattern = allowDecimalComma ? /^(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:[eE][+-]?\d{1,3})?/ : /^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d{1,3})?/;
      const number = text.slice(position).match(pattern)?.[0];
      if (!number) throw Error('number');
      position += number.length;
      const parsed = Number(number.replace(',', '.'));
      if (parsed === 0 && /[1-9]/.test(number.split(/[eE]/)[0])) throw Error('underflow');
      result = scalar(parsed);
    }
    depth--;
    return bounded(result);
  }
  function power() {
    let value = atom();
    if (text[position] === '^') {
      position++;
      const exponent = unary();
      if (!isReal(exponent) || !Number.isInteger(exponent[0]) || Math.abs(exponent[0]) > 1000) throw Error('power');
      if (isReal(value)) {
        const powered = value[0] ** exponent[0];
        if (value[0] !== 0 && powered === 0) throw Error('underflow');
        value = scalar(powered);
      }
      else {
        let count = Math.abs(exponent[0]), result = scalar(1), factor = value;
        while (count) {
          if (count % 2) result = checkedMultiply(result,factor);
          count = Math.floor(count / 2);
          if (count) factor = checkedMultiply(factor,factor);
        }
        if (exponent[0] < 0) {
          const norm = result[0] ** 2 + result[1] ** 2;
          if (!norm) throw Error('zero');
          result = [result[0] / norm, -result[1] / norm];
        }
        if (value.some(component => component !== 0) && result.every(component => component === 0)) throw Error('underflow');
        value = result;
      }
    }
    return bounded(value);
  }
  function unary() {
    if (text[position] === '+') { position++; return unary(); }
    if (text[position] === '-') { position++; return negate(unary()); }
    return power();
  }
  function product() {
    let value = unary();
    while (text[position] === '*' || text[position] === '/' || startsAtom()) {
      const operator = text[position];
      if (operator === '*' || operator === '/') position++;
      const right = unary();
      if (operator === '/') {
        const norm = right[0] ** 2 + right[1] ** 2;
        if (!norm) throw Error('zero');
        value = checkedMultiply(value, [right[0] / norm, -right[1] / norm]);
      } else value = checkedMultiply(value, right);
      value = bounded(value);
    }
    return value;
  }
  function sum() {
    let value = product();
    while (text[position] === '+' || text[position] === '-') {
      const operator = text[position++], right = product();
      value = bounded(add(value, operator === '-' ? negate(right) : right));
    }
    return value;
  }
  try {
    const value = sum();
    return position === text.length ? value : null;
  } catch { return null; }
}

function splitTopLevel(text, separators) {
  const parts = [];
  let start = 0, depth = 0;
  for (let index = 0; index < text.length; index++) {
    if ('([{'.includes(text[index])) depth++;
    if (')]}'.includes(text[index])) depth--;
    if (depth < 0) return null;
    if (depth === 0 && separators.includes(text[index])) { parts.push(text.slice(start, index).trim()); start = index + 1; }
  }
  if (depth !== 0) return null;
  parts.push(text.slice(start).trim());
  return parts;
}

function numericSet(text) {
  text = text.trim();
  if (text === '∅') return [];
  if (!text.startsWith('{') || !text.endsWith('}')) return null;
  const body = text.slice(1, -1).trim();
  if (!body) return [];
  const parts = splitTopLevel(body, body.includes(';') ? ';' : ',');
  if (!parts || parts.length > 100) return null;
  const values = parts.map(part => expression(part, body.includes(';')));
  if (values.some(value => !value || !isReal(value))) return null;
  return values.map(value => value[0]).filter((value, index, all) => all.findIndex(item => close(item, value)) === index);
}

function numericSequence(text, depth = 0) {
  if (depth > 6 || text.length > MAX_INPUT) return null;
  text = text.trim();
  const bracketed = text.startsWith('[') && text.endsWith(']') || text.startsWith('(') && text.endsWith(')');
  if (!bracketed) return null;
  const kind = text.startsWith('[') ? 'list' : 'tuple';
  const body = text.slice(1, -1).trim();
  if (!body) return {kind,items:[]};
  // In Python (1) is grouping, while (1,) is a one-item tuple.
  if (kind === 'tuple' && !splitTopLevel(body, ',;')?.some((_,index) => index > 0)) return null;
  const parts = splitTopLevel(body, ',;');
  if (parts?.at(-1) === '') parts.pop();
  if (!parts || parts.length > 100 || parts.some(part => !part)) return null;
  const values = parts.map(part => {
    if (part.startsWith('[')) return numericSequence(part, depth + 1);
    if (part.startsWith('(')) {
      const sequence = numericSequence(part, depth + 1);
      if (sequence) return sequence;
    }
    const number = expression(part, false);
    return number && isReal(number) ? number[0] : null;
  });
  return values.some(value => value === null) ? null : {kind,items:values};
}

const equalTree = (a, b) => typeof a === 'number' && typeof b === 'number'
  ? close(a,b)
  : !!a && !!b && a.kind === b.kind && Array.isArray(a.items) && Array.isArray(b.items)
    && a.items.length === b.items.length && a.items.every((value,index) => equalTree(value,b.items[index]));
const listValue = (items, nestedKind = 'list') => ({kind:'list',items:items.map(value => Array.isArray(value) ? {kind:nestedKind,items:value} : value)});

function result(verdict, hint, component = '') {
  const correct = verdict === 'correct', partial = verdict === 'partial', clarify = verdict === 'clarify';
  return {
    verdict,
    explanation: correct ? 'Ответ совпадает с эталоном после приведения записи к числовому виду.'
      : clarify ? 'Эту запись нельзя однозначно сравнить автоматически.'
      : partial ? 'Часть ответа верна, но задание пока выполнено не полностью.'
      : 'Полученное значение не совпадает с эталоном. Попробуй проверить вычисления ещё раз.',
    error: correct ? '' : clarify ? 'Нужна более точная запись ответа.' : component || (partial ? 'Проверь остальные части ответа.' : 'В итоговом ответе есть расхождение.'),
    hint: correct ? 'Можно перейти к следующему заданию.' : hint,
    method: 'code',
    needsClarification: clarify
  };
}

function compareComplex(expected, input) {
  const actual = expression(input);
  if (!actual) return null;
  if (sameComplex(expected, actual)) return result('correct', '');
  if (expected[1] !== 0 && (close(expected[0], actual[0]) || close(expected[1], actual[1]))) {
    return result('partial', 'Сравни отдельно действительную и мнимую части; при умножении используй i² = −1.', close(expected[0], actual[0]) ? 'Действительная часть верна, а мнимая требует проверки.' : 'Мнимая часть верна, а действительная требует проверки.');
  }
  return result('incorrect', expected[1] === 0 ? 'Проверь знаки и порядок действий. Дробь можно записать через /, десятичную часть — через запятую.' : 'Вычисли действительную и мнимую части отдельно. Сначала проверь знаки и раскрытие скобок.');
}

function compareSet(expected, input) {
  const actual = numericSet(input);
  if (!actual) return null;
  const matches = actual.filter(value => expected.some(item => close(item, value))).length;
  if (matches === expected.length && actual.length === expected.length) return result('correct', '');
  return result(matches > 0 ? 'partial' : 'incorrect', 'Проверь каждый элемент по определению операции. Порядок элементов множества не важен, повторы не учитываются.', 'Есть пропущенные или лишние элементы множества.');
}

function compareSequence(expected, input) {
  const actual = numericSequence(input);
  if (!actual) return null;
  if (equalTree(expected, actual)) return result('correct', '');
  const matched = expected.kind === actual.kind && expected.items.some((value, index) => equalTree(value, actual.items[index]));
  return result(matched ? 'partial' : 'incorrect', 'Проследи выполнение программы по шагам. В Python-списке важны порядок элементов и повторы.', 'Проверь значения, порядок и число элементов списка.');
}

function comparePair(expected, input) {
  const stripped = input.trim().replace(/^\(|\)$/g, '');
  const parts = splitTopLevel(stripped, ';')?.length === 2 ? splitTopLevel(stripped, ';') : stripped.split(/\s+/).filter(Boolean);
  if (parts.length !== 2) return null;
  const actual = parts.map(part => expression(part));
  if (actual.some(value => !value || !isReal(value))) return null;
  const matches = expected.filter((value, index) => close(value, actual[index][0])).length;
  return result(matches === 2 ? 'correct' : matches ? 'partial' : 'incorrect', 'Запиши оба результата в порядке из условия и проверь каждую часть отдельно.', matches === 1 ? 'Одна часть ответа верна; проверь вторую.' : 'Не совпадают результаты составного ответа.');
}

// A short, explicit table keeps unit checking explainable at the defence.
// Unknown units, compound answers and written derivations still go to the model.
const units = new Map();
for (const [aliases, dimension, factor] of [
  [['мм','mm'],'length',0.001], [['см','cm'],'length',0.01], [['м','m'],'length',1], [['км','km'],'length',1000],
  [['мс','ms'],'time',0.001], [['с','s'],'time',1], [['мин','min'],'time',60], [['ч','h'],'time',3600],
  [['мг','mg'],'mass',0.000001], [['г','g'],'mass',0.001], [['кг','kg'],'mass',1],
  [['м/с','m/s'],'speed',1], [['км/ч','km/h'],'speed',1/3.6]
]) for (const alias of aliases) units.set(alias,{dimension,factor});
const unitNames = [...units.keys()].sort((a,b)=>b.length-a.length);
const uncertainParts = input => /[?≈]|(?<!\p{L})(?:или|либо)(?!\p{L})/iu.test(input)
  ? input.split(/[?≈]|(?<!\p{L})(?:или|либо)(?!\p{L})/iu).map(part=>part.trim()).filter(Boolean) : [];
function quantity(text) {
  const value=text.trim();
  const unit=unitNames.find(name=>value.endsWith(name));
  if (!unit) return null;
  const number=expression(value.slice(0,-unit.length).trim());
  if (!number || !isReal(number)) return null;
  const {dimension,factor}=units.get(unit), normalized=number[0]*factor;
  if (!Number.isFinite(normalized) || Math.abs(normalized)>Number.MAX_SAFE_INTEGER || (number[0]!==0 && normalized===0)) return null;
  return {dimension,value:normalized};
}
function compareQuantity(reference, input) {
  const expected=quantity(reference);
  if (!expected) return null;
  if (uncertainParts(input).some(part=>quantity(part)||expression(part))) return result('clarify','Укажи одно значение вместе с единицей измерения.');
  const actual=quantity(input);
  if (!actual) {
    if (expression(input)) return {...result('clarify',''),explanation:'В каких единицах записан твой результат?'};
    return null;
  }
  if (expected.dimension!==actual.dimension) return result('incorrect','Проверь, какую физическую величину нужно найти и в каких единицах она измеряется.','Единица измерения относится к другой физической величине.');
  if (close(expected.value,actual.value)) return {...result('correct',''),explanation:'Значения совпадают после перевода в одинаковые единицы измерения.'};
  return result('incorrect','Приведи значения к одной единице и проверь вычисления.','После перевода единиц значения не совпадают.');
}

// Expected values of template tasks are recomputed from the task parameters.
// This does not execute either the displayed Python program or a student's code.
function localExpected(proof) {
  if (!proof || typeof proof.kind !== 'string') return null;
  const p = proof;
  switch (p.kind) {
    case 'complex-add': return {type:'complex', value:[p.a + p.c, p.b + p.d]};
    case 'scalar-complex': return {type:'complex', value:[p.a * p.c, p.a * p.d]};
    case 'complex-product': return {type:'complex', value:[p.a * p.c - p.b * p.d, p.a * p.d + p.b * p.c]};
    case 'complex-division': {
      const norm = p.c ** 2 + p.d ** 2;
      return {type:'complex', value:[(p.re * p.c + p.im * p.d) / norm, (p.im * p.c - p.re * p.d) / norm]};
    }
    case 'i-power': return {type:'complex', value:[[1,0],[0,1],[-1,0],[0,-1]][((p.n % 4) + 4) % 4]};
    case 'complex-power': return {type:'complex', value:scalar((-4) ** (p.n / 4))};
    case 'set-operation': return {type:'set', value:p.family === 0 ? p.A.filter(value => p.B.includes(value)) : p.family === 1 ? [...new Set([...p.A,...p.B])] : p.A.filter(value => !p.B.includes(value))};
    case 'inclusion-two': return {type:'complex', value:scalar(p.shared + p.onlyA + p.onlyB)};
    case 'relations-count': return {type:'complex', value:scalar(2 ** (p.a * p.b))};
    case 'subsets': return {type:'pair', value:[2 ** p.n, 2 ** p.n - 1]};
    case 'python-sum': return {type:'complex', value:scalar(p.a * p.n * (p.n - 1) / 2)};
    case 'python-slice': return {type:'sequence', value:listValue(p.a.slice(p.start,p.end))};
    case 'python-digits': return {type:'pair', value:[Math.floor(p.n / 10),p.n % 10]};
    case 'python-filter-sum': return {type:'complex', value:scalar(p.a.filter(value => value > 0 && value % 2 === 0).reduce((sum,value) => sum + value,0))};
    case 'python-digit-sum': return {type:'complex', value:scalar([...String(p.n)].reduce((sum,value) => sum + Number(value),0))};
    case 'python-comprehension': return {type:'sequence', value:listValue(Array.from({length:p.n},(_,value) => value).filter(value => value % 3 === 1).map(value => value ** 2))};
    case 'python-nested': {
      let count = 0;
      for (let i = 1; i <= p.n; i++) for (let j = 1; j < i; j++) if ((i + j) % p.k === 0) count++;
      return {type:'complex', value:scalar(count)};
    }
    case 'python-frequency': return {type:'sequence', value:listValue([...new Set(p.a)].sort((a,b) => a-b).map(value => [value,p.a.filter(item => item === value).length]),'tuple')};
    case 'python-neighbors': return {type:'complex', value:scalar(p.a.slice(0,-1).filter((value,index) => value > 0 && ((p.a[index+1] % 10) + 10) % 10 === 3).reduce((product,value) => product * value,1))};
    default: return null;
  }
}

// Bounded arithmetic for private generation checks. No code is executed.
export function evaluateReal(source) {
  const value = expression(source);
  return value && isReal(value) ? value[0] : null;
}

export function checkDeterministic(task, answer) {
  if (typeof answer !== 'string' || !answer.trim()) return result('clarify', 'Введи свой ответ: число, комплексное число, множество или результат программы.');
  if (!task || typeof task.answer !== 'string' || answer.length > MAX_INPUT) return null;
  const input = answer.trim().replace(/^(?:(?:мой\s+)?ответ(?:\s*[:=]\s*|\s+)|[xzsvtlm]\s*=\s*|(?:я\s+получил[а]?|получилось)(?:\s*[:=]\s*|\s+))/iu, '');
  let expected = localExpected(task.proof);
  // A proof requiring reasoning must not turn into a false positive based on
  // matching a few numbers occurring in its reference explanation.
  if (task.proof && !expected) return null;
  if (!expected) {
    // A numeric reference does not prove that a one-number student answer
    // satisfies a request for reasoning or several separate results.
    const question = typeof task.question === 'string' ? task.question : '';
    const reasoning = /докаж|доказы|обосну|обоснов|объясн|поясн|аргументир|почему|проанализир|прокомментир|prove|justify|explain|demonstrate|show\s+(?:your\s+)?work/iu;
    const multipleParts = /(?:найди|вычисли|определи|запиши|укажи|перечисли|сравни|построй|реши)[\s\S]*\sи\s/iu;
    if (reasoning.test(question) || multipleParts.test(question)) return null;
    const measured=compareQuantity(task.answer,input);
    if (measured) return measured;
    const pythonOutput = /python|программ|список|списка|кортеж|вывед/iu.test(question);
    if (pythonOutput && /^[[(]/.test(task.answer.trim())) {
      const sequence = numericSequence(task.answer);
      return sequence ? compareSequence(sequence,input) : null;
    }
    const value = expression(task.answer);
    if (value) expected = {type:'complex',value};
    else {
      const set = numericSet(task.answer), sequence = numericSequence(task.answer);
      if (set) expected = {type:'set',value:set};
      else if (sequence) expected = {type:'sequence',value:sequence};
      else return null;
    }
  }
  const compare = {complex:compareComplex,set:compareSet,sequence:compareSequence,pair:comparePair}[expected.type];
  if (uncertainParts(input).some(part=>compare(expected.value,part))) return result('clarify', 'Укажи один окончательный ответ. Если результат составной, явно подпиши его части.');
  return compare(expected.value,input);
}
