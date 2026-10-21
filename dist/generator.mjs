export const TOPICS = {
  complex: {name:'Комплексные числа', description:'Арифметика, степени и уравнения'},
  sets: {name:'Множества и отношения', description:'Операции, мощности и свойства отношений'},
  python: {name:'Python: основы и алгоритмы', description:'Циклы, списки и разбор кода'}
};
export const LEVELS = {
  easy: {name:'Базовый', description:'Чтобы разобраться в основах', minutes:3},
  medium: {name:'Средний', description:'Несколько шагов в каждом решении', minutes:5},
  hard: {name:'Сложный', description:'Сочетание приёмов и рассуждение', minutes:8}
};
export function validConfig(c) {
  return !!c && Object.hasOwn(TOPICS,c.topic) && Object.hasOwn(LEVELS,c.level) && Number.isInteger(c.count) && c.count>=1 && c.count<=10;
}
export function rng(seed) {
  let a=seed>>>0;
  return () => {a+=0x6D2B79F5;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};
}
export const escapeHtml = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const math=s=>`<span class="math">${s}</span>`;
const code=s=>`<pre><code>${escapeHtml(s)}</code></pre>`;
const sign=n=>n<0?'−':'+';
const term=(n,suffix='')=>`${sign(n)} ${Math.abs(n)}${suffix}`;
export const complex=(a,b)=>b===0?`${a}`:a===0?(b===1?'i':b===-1?'−i':`${b<0?'−':''}${Math.abs(b)}i`):`${a} ${sign(b)} ${Math.abs(b)===1?'':Math.abs(b)}i`;
const set=a=>`{${a.join('; ')}}`;
const task=(tag,question,hint,answer,explanation,proof)=>({tag,question,hint,answer,explanation,proof});
const fractions=(n,d)=>n%d===0?String(n/d):`${n}/${d}`;

function complexTask(level,family,int,choose) {
  const a=int(1,9),b=int(1,8),c=int(1,9),d=int(1,8),s=choose([-1,1]);
  if(level==='easy') {
    if(family===0) return task('Сложение',`Вычисли ${math(`(${complex(a,b)}) + (${complex(c,s*d)})`)}. Запиши ответ в алгебраической форме.`, 'Сложи действительные части отдельно, а коэффициенты при i — отдельно.',math(complex(a+c,b+s*d)),`${a} + ${c} = ${a+c}; коэффициент при i: ${b} ${term(s*d)} = ${b+s*d}.`,{kind:'complex-add',a,b,c,d:s*d,re:a+c,im:b+s*d});
    if(family===1) {const n=int(5,79),ans=['1','i','−1','−i'][n%4];return task('Степени i',`Вычисли ${math(`i<sup>${n}</sup>`)}.`, 'Степени i повторяются через четыре: i, −1, −i, 1. Найди остаток показателя при делении на 4.',math(ans),`${n} = 4 · ${Math.floor(n/4)} + ${n%4}. Поэтому i<sup>${n}</sup> = i<sup>${n%4}</sup> = ${ans}.`,{kind:'i-power',n,answer:ans});}
    return task('Умножение на число',`Раскрой скобки и вычисли ${math(`${a}(${complex(c,s*d)})`)}.`, 'Умножь число перед скобками на каждое слагаемое внутри.',math(complex(a*c,a*s*d)),`Действительная часть: ${a} · ${c} = ${a*c}. Коэффициент при i: ${a} · (${s*d}) = ${a*s*d}.`,{kind:'scalar-complex',a,c,d:s*d,re:a*c,im:a*s*d});
  }
  if(level==='medium') {
    if(family===0) return task('Произведение',`Вычисли ${math(`(${complex(a,b)})(${complex(c,s*d)})`)}.`, 'Раскрой скобки: (a + bi)(c + di) = ac + adi + bci + bdi². Затем замени i² на −1.',math(complex(a*c-b*s*d,a*s*d+b*c)),`Действительная часть: ${a*c} − (${b*s*d}) = ${a*c-b*s*d}. Коэффициент при i: ${a*s*d} + ${b*c} = ${a*s*d+b*c}.`,{kind:'complex-product',a,b,c,d:s*d,re:a*c-b*s*d,im:a*s*d+b*c});
    if(family===1) {const re=a*c-b*s*d,im=a*s*d+b*c;return task('Деление',`Вычисли ${math(`(${complex(re,im)}) / (${complex(c,s*d)})`)}.`, `Домножь числитель и знаменатель на сопряжённое число ${complex(c,-s*d)}. Знаменатель станет действительным.`,math(complex(a,b)),`Знаменатель: ${c}² + (${s*d})² = ${c*c+d*d}. После умножения числитель равен ${complex(a*(c*c+d*d),b*(c*c+d*d))}. Раздели обе части на ${c*c+d*d}.`,{kind:'complex-division',re,im,c,d:s*d,answerRe:a,answerIm:b});}
    const k=int(1,7),re=3*k*s,im=4*k*choose([-1,1]);return task('Модуль и сопряжение',`Для ${math(`z = ${complex(re,im)}`)} найди модуль |z| и сопряжённое число z̄.`, 'Для z = a + bi: |z| = √(a² + b²), а z̄ = a − bi.',math(`|z| = ${5*k}; z̄ = ${complex(re,-im)}`),`|z| = √((${re})² + (${im})²) = √${25*k*k} = ${5*k}. При сопряжении меняется знак только у мнимой части.`,{kind:'complex-modulus',re,im,modulus:5*k});
  }
  if(family===0) {const sum=a*a+b*b;return task('Квадратное уравнение',`Реши над комплексными числами ${math(`z² − ${2*a}z + ${sum} = 0`)}.`, 'Вычисли дискриминант. Если он отрицательный, используй √(−b²) = bi и формулу корней.',math(`z₁ = ${complex(a,b)}, z₂ = ${complex(a,-b)}`),`D = ${2*a}² − 4 · ${sum} = ${-4*b*b}. √D = ${2*b}i. Значит, z = (${2*a} ± ${2*b}i)/2 = ${a} ± ${b}i.`,{kind:'complex-quadratic',a,b,constant:sum});}
  if(family===1) {const k=int(2,7),n=4*k,ans=(-4)**k;return task('Степень числа',`Вычисли ${math(`(1 ${s===1?'+':'−'} i)<sup>${n}</sup>`)} без последовательного раскрытия всех скобок.`, 'Сначала найди квадрат, затем четвёртую степень основания. Представь показатель как 4k.',math(ans),`(1 ${s===1?'+':'−'} i)² = ${s===1?'2i':'−2i'}, поэтому (1 ${s===1?'+':'−'} i)⁴ = −4. Тогда (1 ${s===1?'+':'−'} i)<sup>${n}</sup> = (−4)<sup>${k}</sup> = ${ans}.`,{kind:'complex-power',s,n,answer:ans});}
  const k=int(1,9),t=2*k;return task('Комплексные корни',`Найди все комплексные решения уравнения ${math(`z³ = ${t**3}`)}.`, `Запиши ${t**3} в тригонометрической форме. Модуль корней — ${t}, аргументы — 0, 2π/3 и 4π/3.`,math(`${t}; −${k} + ${k===1?'':k}√3i; −${k} − ${k===1?'':k}√3i`),`zⱼ = ${t}(cos(2πj/3) + i sin(2πj/3)), j = 0, 1, 2. При углах 2π/3 и 4π/3 косинус равен −1/2, а синус — ±√3/2.`,{kind:'complex-cube-roots',t,k});
}

function setsTask(level,family,int,choose) {
  const k=int(1,40), A=[k,k+1,k+2,k+3],B=[k+2,k+3,k+4];
  if(level==='easy') {
    const symbol=['∩','∪','\\'][family],result=[A.filter(x=>B.includes(x)),[...new Set([...A,...B])],A.filter(x=>!B.includes(x))][family];
    return task(['Пересечение','Объединение','Разность'][family],`Даны ${math(`A = ${set(A)}, B = ${set(B)}`)}. Найди ${math(`A ${symbol} B`)}.`,['Оставь только элементы, входящие и в A, и в B.','Собери все элементы обоих множеств. Каждый элемент запиши один раз.','Возьми элементы A и убери из них все элементы B.'][family],math(set(result)),['Общие элементы находятся в обоих списках.','Объединение содержит элементы хотя бы одного из множеств. Повторы не добавляются.','Разность A \\ B содержит элементы, которые входят в A и не входят в B.'][family],{kind:'set-operation',family,A,B,result});
  }
  if(level==='medium') {
    if(family===0) {const X=[k,k+1],Y=[k+2,k+3,k+4],pairs=X.flatMap(x=>Y.map(y=>[x,y]));return task('Декартово произведение',`Даны ${math(`A = ${set(X)}, B = ${set(Y)}`)}. Выпиши A × B и найди его мощность.`, 'Для каждого элемента A составь упорядоченную пару с каждым элементом B. Порядок координат важен.',`${math(`A × B = {${pairs.map(p=>`(${p[0]}; ${p[1]})`).join('; ')}}`)}<br>${math('|A × B| = 6')}`,'В A два элемента, в B три. Каждый из двух элементов A даёт три пары: 2 · 3 = 6.',{kind:'cartesian',X,Y,pairs});}
    if(family===1) {const n=int(3,15);return task('Число подмножеств',`Множество A содержит ${n} различных элементов. Сколько у него всего подмножеств? Сколько непустых?`, 'Для каждого элемента есть два варианта: включить в подмножество или не включить. Пустое подмножество входит в общее число.',math(`Всего: 2<sup>${n}</sup> = ${2**n}. Непустых: ${2**n-1}.`),`Независимые выборы для ${n} элементов дают 2<sup>${n}</sup> подмножеств. Чтобы оставить непустые, вычти одно пустое.`,{kind:'subsets',n,total:2**n,nonempty:2**n-1});}
    const shared=int(3,12),onlyA=int(4,19),onlyB=int(4,19);return task('Формула включений',`В группе ${shared+onlyA} студентов изучают Python, ${shared+onlyB} — C++, а ${shared} — оба языка. Сколько студентов изучают хотя бы один из этих языков?`, 'При сложении двух численностей студенты, изучающие оба языка, учитываются дважды. Вычти пересечение один раз.',math(shared+onlyA+onlyB),`|A ∪ B| = |A| + |B| − |A ∩ B| = ${shared+onlyA} + ${shared+onlyB} − ${shared} = ${shared+onlyA+onlyB}.`,{kind:'inclusion-two',shared,onlyA,onlyB,total:shared+onlyA+onlyB});
  }
  if(family===0) {const m=int(2,10);return task('Классы эквивалентности',`На ℤ задано отношение ${math(`x ~ y ⇔ ${m} делит (x − y)`)}. Докажи, что это эквивалентность, опиши классы и найди их количество и мощность каждого.`, 'Проверь делимость x − x, смену знака и сумму (x − y) + (y − z). Затем сгруппируй целые числа по остаткам.',`Это эквивалентность. ${math(`[r] = {r + ${m}k : k ∈ ℤ}, r = 0, …, ${m-1}`)}. Всего ${m} классов; каждый — счётно бесконечный.`,`Рефлексивность: ${m} делит 0. Симметричность: если делится x − y, то делится и y − x. Транзитивность: сумма двух чисел, кратных ${m}, тоже кратна ${m}. Разные остатки дают разные классы; отображение k ↦ r + ${m}k — биекция из ℤ в класс.`,{kind:'mod-equivalence',m});}
  if(family===1) {const a=int(2,7),b=int(2,7);return task('Мощность множества отношений',`Множества A и B конечны: ${math(`|A| = ${a}, |B| = ${b}`)}. Сколько существует различных бинарных отношений из A в B, включая пустое?`, 'Бинарное отношение из A в B — любое подмножество A × B. Сначала посчитай число пар.',math(`2<sup>${a*b}</sup>${a*b<=20?` = ${2**(a*b)}`:''}`),`В A × B ровно ${a*b} пар. Для каждой пары независимо решаем: включить её в отношение или нет. Получаем 2<sup>${a*b}</sup> отношений.`,{kind:'relations-count',a,b,exponent:a*b});}
  const shift=int(1,12);return task('Свойства отношения',`На ℤ задано отношение ${math(`x R y ⇔ x ≤ y + ${shift}`)}. Проверь рефлексивность, симметричность, антисимметричность и транзитивность.`, 'Для отрицательного ответа достаточно одного контрпримера. Для транзитивности попробуй два последовательных шага длиной, равной сдвигу.', 'Рефлексивно. Не симметрично, не антисимметрично, не транзитивно.',`Рефлексивность: x ≤ x + ${shift}. Симметричность нарушается: 0 R ${shift+1}, но ${shift+1} R 0 неверно. Антисимметричность нарушается: 0 R ${shift} и ${shift} R 0, хотя 0 ≠ ${shift}. Транзитивность нарушается: ${2*shift} R ${shift} и ${shift} R 0, но ${2*shift} R 0 неверно.`,{kind:'shift-relation',shift});
}

function pythonTask(level,family,int,choose) {
  if(level==='easy') {
    if(family===0) {const n=int(4,16),a=int(1,5),answer=a*(n*(n-1)/2);return task('Цикл for',`Что выведет программа?${code(`s = 0\nfor i in range(${n}):\n    s += ${a} * i\nprint(s)`)} `,`range(${n}) даёт числа от 0 до ${n-1}. Переменная s накапливает сумму.`,code(answer),`s = ${a} · (0 + 1 + … + ${n-1}) = ${a} · (${n} · ${n-1} / 2) = ${answer}.`,{kind:'python-sum',n,a,answer});}
    if(family===1) {const a=Array.from({length:6},()=>int(1,30)),start=int(0,2),end=int(4,6),answer=a.slice(start,end);return task('Срезы списков',`Что выведет программа?${code(`a = [${a.join(', ')}]\nprint(a[${start}:${end}])`)}`, 'Начальный индекс входит в срез, конечный — нет. Индексация начинается с нуля.',code(`[${answer.join(', ')}]`),`В срез входят элементы с индексами ${start}, …, ${end-1}. Всего ${end-start} элементов.`,{kind:'python-slice',a,start,end,answer});}
    const n=int(110,998);return task('Цифры числа',`Что выведет программа?${code(`n = ${n}\nprint(n // 10, n % 10)`)}`, 'Для положительного целого // 10 убирает последнюю цифру, а % 10 возвращает её.',code(`${Math.floor(n/10)} ${n%10}`),`${n} = ${Math.floor(n/10)} · 10 + ${n%10}. print разделяет два результата пробелом.`,{kind:'python-digits',n,quotient:Math.floor(n/10),remainder:n%10});
  }
  if(level==='medium') {
    if(family===0) {const a=Array.from({length:7},()=>int(-8,12)),answer=a.filter(x=>x>0&&x%2===0).reduce((s,x)=>s+x,0),selected=a.filter(x=>x>0&&x%2===0);return task('Условие в цикле',`Что выведет программа?${code(`a = [${a.join(', ')}]\ns = 0\nfor x in a:\n    if x > 0 and x % 2 == 0:\n        s += x\nprint(s)`)}`, 'Проверяй два условия одновременно: число положительное и чётное. Ноль не положительный.',code(answer),`Подходящие элементы: ${selected.length?selected.join(', '):'нет'}. ${selected.length?`Их сумма равна ${answer}.`:'Начальное значение s остаётся равным 0.'}`,{kind:'python-filter-sum',a,answer});}
    if(family===1) {const n=int(123,9876);let t=n,sum=0;const digits=[];while(t>0){digits.push(t%10);sum+=t%10;t=Math.floor(t/10);}return task('Цикл while',`Что выведет программа?${code(`n = ${n}\ns = 0\nwhile n > 0:\n    s += n % 10\n    n //= 10\nprint(s)`)}`, 'На каждом шаге прибавляется последняя цифра, после чего она удаляется. Составь таблицу значений n и s.',code(sum),`Цифры обрабатываются справа налево: ${digits.join(', ')}. Их сумма: ${digits.join(' + ')} = ${sum}.`,{kind:'python-digit-sum',n,answer:sum});}
    const n=int(6,17),answer=Array.from({length:n},(_,x)=>x).filter(x=>x%3===1).map(x=>x*x);return task('Генератор списка',`Что выведет программа?${code(`a = [x * x for x in range(${n}) if x % 3 == 1]\nprint(a)`)}`, 'Сначала выбери x с остатком 1 при делении на 3, затем возведи выбранные x в квадрат.',code(`[${answer.join(', ')}]`),`Подходящие x: ${Array.from({length:n},(_,x)=>x).filter(x=>x%3===1).join(', ')}. После возведения в квадрат получаем указанный список.`,{kind:'python-comprehension',n,answer});
  }
  if(family===0) {const n=int(4,12),k=int(2,4);let answer=0;for(let i=1;i<=n;i++)for(let j=1;j<i;j++)if((i+j)%k===0)answer++;return task('Вложенные циклы',`Что выведет программа?${code(`count = 0\nfor i in range(1, ${n+1}):\n    for j in range(1, i):\n        if (i + j) % ${k} == 0:\n            count += 1\nprint(count)`)}`, `Перебери пары 1 ≤ j < i ≤ ${n}. Засчитывай пару только тогда, когда i + j кратно ${k}.`,code(answer),`Количество подходящих пар для i = 1, …, ${n}: ${Array.from({length:n},(_,x)=>{const i=x+1;let c=0;for(let j=1;j<i;j++)if((i+j)%k===0)c++;return c;}).join(', ')}. Сумма этих количеств равна ${answer}.`,{kind:'python-nested',n,k,answer});}
  if(family===1) {const a=Array.from({length:6},()=>int(1,5)),unique=[...new Set(a)].sort((x,y)=>x-y),answer=unique.map(x=>[x,a.filter(y=>y===x).length]);return task('Два прохода по списку',`Что выведет программа?${code(`a = [${a.join(', ')}]\nresult = []\nfor x in sorted(set(a)):\n    count = 0\n    for y in a:\n        if y == x:\n            count += 1\n    result.append((x, count))\nprint(result)`)}`, 'Внешний цикл проходит по уникальным значениям по возрастанию. Внутренний считает число появлений каждого значения.',code(`[${answer.map(([x,c])=>`(${x}, ${c})`).join(', ')}]`),'Каждый кортеж содержит значение и число его появлений в исходном списке. Сумма всех вторых координат равна длине списка: 6.',{kind:'python-frequency',a,answer});}
  const a=Array.from({length:8},()=>int(-3,9)),answer=a.slice(0,-1).filter((x,i)=>x>0&&a[i+1]%10===3).reduce((p,x)=>p*x,1);return task('Соседние элементы',`Что выведет программа?${code(`a = [${a.join(', ')}]\np = 1\nfor i in range(len(a) - 1):\n    if a[i] > 0 and a[i + 1] % 10 == 3:\n        p *= a[i]\nprint(p)`)}`, 'Рассмотри пары соседей. В произведение входит первый элемент пары, если он положительный, а следующий даёт остаток 3 при делении на 10.',code(answer),`Подходящие первые элементы: ${a.slice(0,-1).filter((x,i)=>x>0&&a[i+1]%10===3).join(', ')||'нет'}. ${answer===1?'Если подходящих элементов нет, p остаётся равным 1; множитель 1 также не меняет результат.':`Их произведение равно ${answer}.`} Последний элемент не проверяется как первый: после него нет соседа.`,{kind:'python-neighbors',a,answer});
}

export function makeTasks(config,seed) {
  if(!validConfig(config)) throw new RangeError('Недопустимые параметры варианта');
  const random=rng(seed),int=(a,b)=>Math.floor(random()*(b-a+1))+a,choose=a=>a[int(0,a.length-1)];
  const make={complex:complexTask,sets:setsTask,python:pythonTask}[config.topic];
  const tasks=[],seen=new Set(),offset=int(0,2);
  for(let attempt=0;tasks.length<config.count && attempt<500;attempt++) {
    const t=make(config.level,(tasks.length+offset)%3,int,choose);
    if(!seen.has(t.question)){seen.add(t.question);tasks.push(t);}
  }
  if(tasks.length!==config.count)throw new Error('Не удалось собрать уникальный вариант');
  return tasks;
}
export function buildPrompt(config,variantId) {
  if(!validConfig(config)) throw new RangeError('Недопустимые параметры промпта');
  const difficulty={easy:'одно основное действие; прямое применение определения или формулы',medium:'несколько последовательных действий; выбор подходящего приёма',hard:'сочетание приёмов; обоснование или анализ алгоритма'};
  return `РОЛЬ\nТы — преподаватель и репетитор студента первого курса.\n\nКОНТЕКСТ\nПодготовка к экзамену. Тема: «${TOPICS[config.topic].name}». Вариант №${String(variantId).padStart(3,'0')}.\n\nЗАДАЧА\nСоздай ровно ${config.count} различных практических заданий.\nСложность: ${LEVELS[config.level].name.toLowerCase()} — ${difficulty[config.level]}.\n\nТРЕБОВАНИЯ\n• Условия должны быть однозначными и самодостаточными.\n• Измени числовые параметры и используй разные типы заданий.\n• Для каждого задания дай одну направляющую подсказку, точный ответ и объяснение по шагам.\n• Подсказка не должна раскрывать готовый ответ.\n• Проверь вычисления и соответствие уровню сложности.\n• Пиши по-русски, понятно первокурснику.\n\nФОРМАТ ОТВЕТА\nВерни только JSON, без Markdown и без пояснений вне JSON:\n{\n  "topic": "${config.topic}",\n  "difficulty": "${config.level}",\n  "tasks": [\n    {\n      "type": "тип задания",\n      "question": "условие",\n      "hint": "подсказка",\n      "answer": "точный ответ",\n      "explanation": "пошаговое решение"\n    }\n  ]\n}\n\nПеред ответом проверь: tasks содержит ровно ${config.count} объектов; задания не повторяются; у каждого задания заполнены все пять полей.`;
}
