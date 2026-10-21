import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {TOPICS,LEVELS,makeTasks,buildPrompt,validConfig} from '../dist/generator.mjs';
import {mountApp,readSaved} from '../dist/app.mjs';

const index=fs.readFileSync(new URL('../dist/index.html',import.meta.url),'utf8');
const pythonCases=[];
let variants=0,checkedTasks=0;
const decode=s=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&');
const multiply=(a,b,c,d)=>[a*c-b*d,a*d+b*c];
function verify(t) {
  for(const key of ['question','hint','answer','explanation','tag'])assert.ok(typeof t[key]==='string'&&t[key].trim());
  const p=t.proof;
  switch(p.kind){
    case 'complex-add': assert.deepEqual([p.re,p.im],[p.a+p.c,p.b+p.d]);break;
    case 'scalar-complex':assert.deepEqual([p.re,p.im],multiply(p.a,0,p.c,p.d));break;
    case 'complex-product':assert.deepEqual([p.re,p.im],multiply(p.a,p.b,p.c,p.d));break;
    case 'complex-division':assert.deepEqual(multiply(p.answerRe,p.answerIm,p.c,p.d),[p.re,p.im]);break;
    case 'complex-modulus':assert.equal(Math.hypot(p.re,p.im),p.modulus);break;
    case 'i-power':{let re=1,im=0;for(let j=0;j<p.n;j++)[re,im]=multiply(re,im,0,1);assert.equal(p.answer,im===1?'i':im===-1?'−i':re===1?'1':'−1');break;}
    case 'complex-quadratic':for(const im of [p.b,-p.b]){const [r,i]=multiply(p.a,im,p.a,im);assert.equal(r-2*p.a*p.a+p.constant,0);assert.equal(i-2*p.a*im,0);}break;
    case 'complex-power':{let re=1,im=0;for(let j=0;j<p.n;j++)[re,im]=multiply(re,im,1,p.s);assert.equal(re,p.answer);assert.equal(im,0);break;}
    case 'complex-cube-roots':for(const [re,im] of [[p.t,0],[-p.k,p.k*Math.sqrt(3)],[-p.k,-p.k*Math.sqrt(3)]]){const [r,i]=multiply(...multiply(re,im,re,im),re,im);assert.ok(Math.abs(r-p.t**3)<1e-8&&Math.abs(i)<1e-8);}break;
    case 'set-operation':for(let x=0;x<50;x++){const a=p.A.includes(x),b=p.B.includes(x);assert.equal(p.result.includes(x),p.family===0?a&&b:p.family===1?a||b:a&&!b);}break;
    case 'cartesian':assert.equal(p.pairs.length,p.X.length*p.Y.length);for(const x of p.X)for(const y of p.Y)assert.ok(p.pairs.some(v=>v[0]===x&&v[1]===y));break;
    case 'subsets':{let total=0;for(let mask=0;mask<(1<<p.n);mask++)total++;assert.equal(p.total,total);assert.equal(p.nonempty,total-1);break;}
    case 'inclusion-two':{const A=new Set(Array.from({length:p.shared+p.onlyA},(_,i)=>i));const B=new Set([...Array.from({length:p.shared},(_,i)=>i),...Array.from({length:p.onlyB},(_,i)=>100+i)]);assert.equal(new Set([...A,...B]).size,p.total);break;}
    case 'mod-equivalence':for(let x=-30;x<=30;x++)assert.equal(((x%p.m)+p.m)%p.m,(((x+p.m*7)%p.m)+p.m)%p.m);break;
    case 'relations-count':assert.equal(p.exponent,p.a*p.b);break;
    case 'shift-relation':{const R=(x,y)=>x<=y+p.shift;assert.ok(R(0,p.shift+1)&&!R(p.shift+1,0));assert.ok(R(0,p.shift)&&R(p.shift,0));assert.ok(R(p.shift*2,p.shift)&&R(p.shift,0)&&!R(p.shift*2,0));break;}
  }
  if(p.kind.startsWith('python-')){
    const source=decode(t.question.match(/<pre><code>([\s\S]*?)<\/code><\/pre>/)[1]);
    const expected=decode(t.answer.match(/<pre><code>([\s\S]*?)<\/code><\/pre>/)[1]);
    pythonCases.push({source,expected});
  }
  checkedTasks++;
}
for(const topic of Object.keys(TOPICS))for(const level of Object.keys(LEVELS))for(const count of [1,5,10])for(let seed=0;seed<35;seed++){
  const c={topic,level,count},tasks=makeTasks(c,seed);
  assert.equal(tasks.length,count);assert.equal(new Set(tasks.map(t=>t.question)).size,count);
  assert.deepEqual(tasks,makeTasks(c,seed));tasks.forEach(verify);
  const prompt=buildPrompt(c,42);assert.ok(prompt.includes(`ровно ${count}`)&&prompt.includes(TOPICS[topic].name)&&prompt.includes(LEVELS[level].name.toLowerCase()));
  variants++;
}
for(const c of [{topic:'oops',level:'easy',count:1},{topic:'sets',level:'medium',count:0},{topic:'sets',level:'medium',count:11},{topic:'sets',level:'medium',count:2.5}]){assert.equal(validConfig(c),false);assert.throws(()=>makeTasks(c,1));}
const py=spawnSync('python',['-c',`import json,sys,io,contextlib\ncases=json.load(sys.stdin)\nfor n,c in enumerate(cases):\n    out=io.StringIO()\n    with contextlib.redirect_stdout(out): exec(c['source'], {})\n    actual=out.getvalue().strip()\n    if actual != c['expected']: raise AssertionError((n,c,actual))\nprint(f"Python output verified: {len(cases)} programs")`],{input:JSON.stringify(pythonCases),encoding:'utf8'});
assert.equal(py.status,0,py.stderr);process.stdout.write(py.stdout);

// Event-level UI checks with a DOM adapter. This does not claim browser/layout QA.
class Element {
  constructor(id,doc){this.id=id;this.doc=doc;this.listeners={};this.attributes={};this.dataset={};this.style={};this.hidden=false;this.value='';this.checked=false;this.disabled=false;this.textContent='';this._html='';this.classList={toggle:(c,value)=>this.solved=value};this.open=false;}
  set innerHTML(value){this._html=value;for(const id of value.matchAll(/id="([^"]+)"/g))this.doc.elements[id[1]]=new Element(id[1],this.doc);}
  get innerHTML(){return this._html;}
  addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}
  async emit(name,event={}){event.target??=this;event.preventDefault??=()=>{};for(const fn of this.listeners[name]||[])await fn(event);}
  setAttribute(k,v){this.attributes[k]=v;}
  focus(){this.doc.focused=this.id;}
  scrollIntoView(){}
  showModal(){this.open=true;}
  close(){this.open=false;}
  matches(s){return s==='input[data-solved]'&&this.dataset.solved!==undefined;}
  closest(s){if(s==='dialog')return this.parent;if(s==='button[data-load]'&&this.dataset.load!==undefined)return this;return null;}
  getBoundingClientRect(){return {left:0,right:560,top:0,bottom:600};}
}
class Document {
  constructor(){this.elements={};for(const id of index.matchAll(/id="([^"]+)"/g))this.elements[id[1]]=new Element(id[1],this);this.levels=['easy','medium','hard'].map((v,i)=>{const e=new Element('level-'+v,this);e.value=v;e.checked=i===0;return e;});this.elements.topic.value='complex';this.elements.count.value='5';this.closers=['history','guide'].map(v=>{const e=new Element('close-'+v,this);e.parent=this.elements[v+'-dialog'];return e;});}
  getElementById(id){assert.ok(this.elements[id],`Missing element: ${id}`);return this.elements[id];}
  querySelector(s){if(s==='input[name="level"]:checked')return this.levels.find(e=>e.checked);throw new Error(s);}
  querySelectorAll(s){if(s==='input[name="level"]')return this.levels;if(s==='[data-close]')return this.closers;if(s==='dialog')return [this.elements['history-dialog'],this.elements['guide-dialog']];throw new Error(s);}
  choose(level){this.levels.forEach(e=>e.checked=e.value===level);}
}
class Storage {constructor(){this.data={};}getItem(k){return this.data[k]||null;}setItem(k,v){this.data[k]=v;}}
const doc=new Document(),storage=new Storage();let seed=100;
const app=mountApp(doc,storage,{randomSeed:()=>seed++,now:()=>new Date('2026-10-10T10:00:00Z').toISOString()});
const $=id=>doc.getElementById(id);
assert.equal(app.getState().tasks.length,5);assert.equal(app.getState().history.length,1);
assert.equal(($('task-list').innerHTML.match(/<details>/g)||[]).length,10);assert.ok(!$('task-list').innerHTML.includes('<details open'));
const old=app.getState().tasks.map(x=>x.question);
await $('regenerate').emit('click');assert.equal(app.getState().current.id,2);assert.notDeepEqual(app.getState().tasks.map(x=>x.question),old);
for(const topic of Object.keys(TOPICS))for(const level of Object.keys(LEVELS))for(const count of [1,10]){
  $('topic').value=topic;doc.choose(level);$('count').value=String(count);await $('topic').emit('change');assert.equal($('settings-notice').hidden,false);
  await $('generator-form').emit('submit');assert.deepEqual(app.getState().current.config,{topic,level,count});assert.equal(app.getState().tasks.length,count);assert.equal($('settings-notice').hidden,true);assert.equal($('progress-label').textContent,`Решено 0 из ${count}`);
}
const latest=app.getState().current.id;
for(let i=0;i<10;i++){const checkbox=new Element('check',doc);checkbox.dataset.solved=String(i);checkbox.checked=true;await $('task-list').emit('change',{target:checkbox});}
assert.equal($('completion-note').hidden,false);assert.equal($('progress-fill').style.width,'100%');
await $('prompt-tab').emit('click');assert.equal($('prompt-panel').hidden,false);assert.equal($('tasks-panel').hidden,true);assert.equal($('prompt-tab').attributes['aria-selected'],'true');
await $('prompt-tab').emit('keydown',{key:'ArrowLeft'});assert.equal(app.getState().activeTab,'tasks');
await $('nav-history').emit('click');assert.equal($('history-dialog').open,true);assert.ok($('history-list').innerHTML.includes('data-load'));
const restored=app.getState().history.at(-1);assert.ok(app.loadVariant(restored.id));assert.equal($('history-dialog').open,false);
assert.ok(app.loadVariant(latest));assert.equal($('completion-note').hidden,false);
const doc2=new Document(),app2=mountApp(doc2,storage,{randomSeed:()=>555});assert.equal(app2.getState().current.id,latest);assert.equal(app2.getState().current.solved.filter(Boolean).length,10);
for(const count of ['0','11','2.5','']){const before=app.getState().sequence;$('count').value=count;assert.equal(app.generate(),false);assert.equal(app.getState().sequence,before);}
$('count').value='1';await $('decrease').emit('click');assert.equal(Number($('count').value),1);assert.equal($('decrease').disabled,true);
$('count').value='10';await $('increase').emit('click');assert.equal(Number($('count').value),10);assert.equal($('increase').disabled,true);
for(let n=0;n<23;n++)app.generate({notify:false});assert.equal(app.getState().history.length,20);
assert.equal(readSaved({getItem:()=>'{broken'}).history.length,0);
assert.equal(readSaved({getItem:()=>JSON.stringify({version:1,history:[{id:1,seed:1,config:{topic:'bad',level:'easy',count:2},created:'bad'}]})}).history.length,0);
const noStorage=mountApp(new Document(),{getItem(){throw Error();},setItem(){throw Error();}},{randomSeed:()=>1});assert.equal(noStorage.getState().tasks.length,5);
await $('nav-guide').emit('click');assert.equal($('guide-dialog').open,true);await doc.closers[1].emit('click');assert.equal($('guide-dialog').open,false);
await $('copy-prompt').emit('click');assert.ok($('toast').textContent.includes('скопируй'));
let copied;Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async text=>{copied=text;}}}});
await $('copy-prompt').emit('click');assert.equal(copied,$('prompt-text').textContent);assert.equal($('toast').textContent,'Промпт скопирован.');
await $('nav-history').emit('click');const historyButton=new Element('load-button',doc);historyButton.dataset.load=String(app.getState().history[1].id);await $('history-list').emit('click',{target:historyButton});assert.equal(app.getState().current.id,Number(historyButton.dataset.load));assert.equal($('history-dialog').open,false);
assert.ok(index.includes('lang="ru"')&&index.includes('name="viewport"')&&index.includes('role="tablist"'));
assert.ok(!/https?:\/\//.test(fs.readFileSync(new URL('../dist/app.mjs',import.meta.url),'utf8')),'No runtime external API calls');
console.log(`PASS: ${variants} variants; ${checkedTasks} task calculations; ${pythonCases.length} Python executions.`);
console.log('PASS: generation, all settings, regeneration, hidden hint/answer markup, progress, tabs/keyboard, history/restore, validation/bounds, 20-item limit, corrupt/blocked storage, guide and copy fallback.');
console.log('LIMIT: this suite uses a DOM adapter. Run tests/browser.py separately for real-browser checks.');
