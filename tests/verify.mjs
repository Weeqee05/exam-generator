import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {TOPICS,LEVELS,makeTasks,buildPrompt,validConfig} from '../dist/generator.mjs';

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

console.log(`PASS: ${variants} variants; ${checkedTasks} task calculations; ${pythonCases.length} Python executions.`);
console.log('UI scenarios are checked separately in tests/browser.py against the real browser and server.');
