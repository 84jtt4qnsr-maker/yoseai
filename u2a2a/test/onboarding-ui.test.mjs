import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const onboarding=fs.readFileSync(new URL('../public/onboarding-ui.js',import.meta.url),'utf8');
const avatars=fs.readFileSync(new URL('../public/avatars.js',import.meta.url),'utf8');
class Element {
 constructor(tag,doc){Object.assign(this,{tagName:tag,doc,children:[],attrs:{},events:{},_text:'',hidden:false,disabled:false,checked:false,value:'',isConnected:true,style:{setProperty(){}},dataset:{},options:[]});const classes=new Set();this.classList={add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x),toggle:(x,on)=>on?classes.add(x):classes.delete(x)};}
 set textContent(v){this.children=[];this._text=String(v);}
 get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
 setAttribute(k,v){this.attrs[k]=String(v);if(k==='id')this.doc.ids[v]=this;if(k==='hidden')this.hidden=true;}
 getAttribute(k){return this.attrs[k]??null;}
 removeAttribute(k){delete this.attrs[k];if(k==='href')delete this.href;if(k==='src')this.src='';}
 append(...nodes){for(const n of nodes){n.parentElement=this;this.children.push(n);}}
 appendChild(n){this.append(n);return n;}
 replaceChildren(...nodes){this.children=[];this._text='';this.append(...nodes);}
 remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(n=>n!==this);}
 addEventListener(k,f){(this.events[k]??=[]).push(f);}
 fire(k){return Promise.all((this.events[k]||[]).map(f=>f({target:this})));}
 focus(){this.doc.activeElement=this;}
 closest(selector){for(let n=this;n;n=n.parentElement)if(n.className?.split(' ').includes(selector.slice(1)))return n;return null;}
 cloneNode(){const n=new Element(this.tagName,this.doc);n.src=this.src;n.alt=this.alt;return n;}
 querySelector(tag){return this.querySelectorAll(tag)[0]||null;}
 querySelectorAll(tag){return this.children.flatMap(n=>[...(n.tagName===tag?[n]:[]),...n.querySelectorAll(tag)]);}
}
const fn=name=>html.match(new RegExp('(?:async )?function '+name+'\\([^]*?\\n}'))?.[0]||assert.fail(name);
const plain=x=>JSON.parse(JSON.stringify(x));
function setup(){
 const doc={ids:{},activeElement:null,getElementById(id){return this.ids[id]||null;}};
 doc.createElement=tag=>new Element(tag,doc);doc.createTextNode=t=>{const n=doc.createElement('#text');n.textContent=t;return n;};doc.body=doc.createElement('body');
 const calls=[],notes=[],images=[],state={agents:{claude:{auto:false,authed:true},codex:{auto:false,authed:true},grok:{auto:false,authed:false}}};
 const ctx=vm.createContext({document:doc,URL,location:{href:'http://localhost/',origin:'http://localhost'},Image:class extends Element {constructor(){super('img',doc);images.push(this);}},requestAnimationFrame:()=>1,cancelAnimationFrame(){},state,NAMES:{claude:'Claude',codex:'Codex',grok:'Grok'},$:s=>s==='main'?doc.body:doc.ids[s.slice(1)],currentTopic:()=>({id:'t',agents:{}}),participantsOf:()=>['claude','codex'],autoSaving:new Set(),foldedColumns:new Map(),api:async(...args)=>{calls.push(plain(args));return {};},toast:s=>notes.push(s),isRunning:()=>false,applyThreadGlow(){},agentColor:()=>'',scheduleLinks(){},toggleWideColumn(){},toggleColumn(){},setViewMode:mode=>{calls.push(['view',mode]);doc.body.classList.remove('flow-view');},applyColumnLayout:()=>calls.push(['layout']),el:(tag,attrs={},children=[])=>{const n=doc.createElement(tag);for(const[k,v]of Object.entries(attrs)){if(k==='text')n.textContent=v;else if(k==='class')n.className=v;else if(k.startsWith('on'))n.addEventListener(k.slice(2),v);else n.setAttribute(k,v);}n.append(...children);return n;}});
 vm.runInContext(onboarding,ctx);vm.runInContext(avatars,ctx);
 vm.runInContext("const AV=U2AAvatar; const agentDefs=()=>state.agents;"+html.match(/const agentReady =[^\n]+/)[0]+html.match(/const authLabel =[^\n]+/)[0],ctx);
 for(const n of ['createThreadColumn','manualEmpty','showAgentInput','hideAgentInput','sendAgent','renderAgentStatus','updateAuto'])vm.runInContext(fn(n),ctx);
 return {ctx,doc,calls,notes,images,state,O:ctx.U2AOnboarding,A:ctx.U2AAvatar};
}
test('unknown authentication is independent of auto and server auth flags',()=>{
 const {O,state}=setup(),before=plain(state);
 for(const id of ['claude','codex'])for(const value of [true,false,null,undefined])assert.equal(O.authLabel(id,value),'認証状態: 未確認');
 assert.deepEqual(plain(state),before);
});
test('Grok actual true/false/checking labels are preserved',()=>{
 const {O}=setup();assert.equal(O.authLabel('grok',true),'認証済み');assert.equal(O.authLabel('grok',false),'未認証（grok login）');assert.equal(O.authLabel('grok',null),'確認中');
});
test('column empty entry only opens on explicit click, no API or auto enabling',async()=>{
 const {ctx,doc,calls}=setup();const column=ctx.createThreadColumn('claude');doc.body.append(column);
 const empty=ctx.manualEmpty(['claude']);assert.match(empty.textContent,/列で手動入力/);assert.equal(calls.length,0);
 await empty.querySelectorAll('button')[0].fire('click');assert.equal(doc.ids['input-claude'].closest('.agent-input').hidden,false);assert.equal(doc.activeElement,doc.ids['input-claude']);assert.equal(calls.length,0);
});
test('flow entry explains switch and unfolds the selected column before focus',async()=>{
 const {ctx,doc,calls}=setup();doc.body.append(ctx.createThreadColumn('codex'));doc.body.classList.add('flow-view');ctx.foldedColumns.set('t',new Set(['codex']));
 const empty=ctx.manualEmpty(['codex'],true);assert.match(empty.textContent,/入力欄は列にあるため/);assert.match(empty.textContent,/フローにも表示/);
 await empty.querySelectorAll('button')[0].fire('click');assert.deepEqual(calls,[['view','columns'],['layout']]);assert.equal(ctx.foldedColumns.get('t').has('codex'),false);assert.equal(doc.activeElement,doc.ids['input-codex']);
});
test('removed participant input does not throw or send anything',()=>{const {ctx,calls}=setup();ctx.showAgentInput('gone');assert.equal(calls.length,0);});
test('Grok unavailable manual control stays disabled and gives real auth reason',async()=>{
 const {ctx,calls}=setup(),empty=ctx.manualEmpty(['grok']);const b=empty.querySelectorAll('button')[0];assert.equal(b.disabled,true);await b.fire('click');assert.match(empty.textContent,/未認証（grok login）/);assert.equal(calls.length,0);
});
test('guide names optional CLIs, login, unknown auth and external transmission/cost',()=>{
 const {O}=setup(),g=O.guide();assert.match(g.textContent,/claude \/ codex \/ grok/);assert.match(g.textContent,/CLIなしで始め/);assert.match(g.textContent,/ログイン/);assert.match(g.textContent,/外部サービス/);assert.match(g.textContent,/利用料金/);
});
test('untrusted display names remain text, no executable markup',()=>{
 const {O}=setup(),b=O.emptyState({agents:[{id:'x',name:'<script>alert(1)</script>',ready:true}],flow:true,onManual(){}});assert.match(b.textContent,/<script>/);assert.equal(b.querySelectorAll('script').length,0);
});
test('persistent header entry survives first message and notice describes auto control',async()=>{
 const {ctx,doc}=setup();doc.body.append(ctx.createThreadColumn('claude'));const b=doc.ids['manual-claude'];assert.ok(b);await b.fire('click');assert.equal(doc.activeElement,doc.ids['input-claude']);
 assert.equal(doc.ids['auto-claude'].getAttribute('aria-describedby'),'auto-notice');assert.equal(doc.ids['auto-notice-claude'],undefined);
 assert.equal((html.match(/id="auto-notice"/g)||[]).length,1);assert.match(html,/id="auto-notice"[^]*?外部送信[^]*?利用料金/);
});
test('unknown auth is neutral while auto ON/OFF renders independently',()=>{
 const {ctx,doc,state}=setup();doc.body.append(ctx.createThreadColumn('claude'));
 for(const auto of [false,true]){state.agents.claude.auto=auto;ctx.renderAgentStatus('claude');assert.equal(doc.ids['auth-state-claude'].textContent,'認証状態: 未確認');assert.equal(doc.ids['status-claude'].dataset.s,'');assert.equal(doc.ids['auto-label-claude'].textContent,'自動応答 '+(auto?'ON':'OFF'));}
});
test('real error and Grok failed auth retain error presentation',()=>{
 const {ctx,doc,state}=setup();doc.body.append(ctx.createThreadColumn('claude'),ctx.createThreadColumn('grok'));
 state.agents.claude.lastError='actual CLI failure';ctx.renderAgentStatus('claude');assert.equal(doc.ids['status-claude'].dataset.s,'error');
 ctx.renderAgentStatus('grok');assert.equal(doc.ids['status-grok'].dataset.s,'error');assert.match(doc.ids['status-grok'].textContent,/未認証/);
});
test('manual paste posts own author with auto OFF; never enables auto or sends user request',async()=>{
 const {ctx,doc,calls,state}=setup();doc.body.append(ctx.createThreadColumn('codex'));doc.ids['input-codex'].value='  pasted answer  ';
 await ctx.sendAgent('codex');assert.deepEqual(calls,[['/api/messages','POST',{thread:'codex',author:'codex',text:'pasted answer',topicId:'t'}]]);assert.equal(state.agents.codex.auto,false);assert.equal(doc.ids['input-codex'].value,'');
});
test('manual paste failure retains text for retry',async()=>{
 const {ctx,doc,notes}=setup();doc.body.append(ctx.createThreadColumn('claude'));doc.ids['input-claude'].value='keep';ctx.api=async()=>{throw Error('offline');};await ctx.sendAgent('claude');assert.equal(doc.ids['input-claude'].value,'keep');assert.equal(doc.ids['input-claude'].disabled,false);assert.deepEqual(notes,['offline']);
});
test('auto toggle prevents duplicate requests and sends only the selected auto flag',async()=>{
 const {ctx,doc,state}=setup();doc.body.append(ctx.createThreadColumn('claude'));const b=doc.ids['auto-claude'];b.checked=true;const calls=[];let resolve;ctx.api=(...a)=>{calls.push(plain(a));return new Promise(r=>resolve=r);};
 const request=ctx.updateAuto('claude',b);assert.equal(b.disabled,true);await ctx.updateAuto('claude',b);assert.equal(calls.length,1);resolve({});await request;
 assert.deepEqual(calls,[['/api/agents/claude','PATCH',{auto:true}]]);assert.equal(state.agents.claude.authed,true);assert.equal(b.disabled,false);assert.equal(b.checked,true);
});
test('failed enabling restores the prior switch and reports failure',async()=>{
 const {ctx,doc,state,notes}=setup();doc.body.append(ctx.createThreadColumn('codex'));const b=doc.ids['auto-codex'];b.checked=true;ctx.api=async()=>{throw Error('rejected');};await ctx.updateAuto('codex',b);assert.equal(b.checked,false);assert.equal(state.agents.codex.auto,false);assert.deepEqual(notes,['rejected']);
});
test('missing portraits for all agents retain letter and ring with no broken link',()=>{
 const {A,images}=setup();for(const[id,letter]of [['claude','C'],['codex','X'],['grok','G']]){const b=A.badge(id,true),img=images.at(-1);assert.equal(b.textContent,letter);assert.equal(b.href,undefined);assert.equal(b.querySelectorAll('img').length,0);img.onerror();assert.equal(b.querySelectorAll('img').length,0);assert.equal(b.textContent,letter);assert.equal(b.href,undefined);assert.match(b.getAttribute('aria-label'),/画像なし/);assert.match(b.className,/agent-avatar-face/);}
});
test('available portrait reveals image and enables existing full portrait link',()=>{
 const {A,images}=setup(),b=A.badge('grok',true),img=images.at(-1);assert.equal(img.src,'/api/pool/file/avatars/grok%2Fportrait.jpg');img.onload();assert.equal(b.querySelectorAll('img').length,1);assert.equal(b.href,img.src);assert.match(b.getAttribute('aria-label'),/自画像を見る/);
});
test('small nodes are letters and do not request any image',()=>{const{A,images}=setup();for(const id of ['claude','codex','grok'])assert.equal(A.badge(id).querySelectorAll('img').length,0);assert.equal(images.length,0);});
test('absent avatar manifest entry shows pet letter, clears stale still and loaded sprite',()=>{
 const {A}=setup();const c=Object.create(A.Controller.prototype);c.assets={};const p={agent:'codex',sprite:'old',loaded:true,placeholder:'old',still:{removeAttribute(k){assert.equal(k,'src');},hidden:false},fallback:{hidden:true}};c.setAsset(p);assert.equal(p.loaded,false);assert.equal(p.still.hidden,true);assert.equal(p.fallback.hidden,false);assert.equal(p.sprite,null);
});
test('production inline script parses and empty entry wiring differentiates filters',()=>{
 for(const m of html.matchAll(/<script>([^]*?)<\/script>/g))if(m[1].trim())new vm.Script(m[1]);
 assert.match(html,/if \(!graph.nodes.length\) flowEmpty.append\(manualEmpty\(participantsOf\(\), true\)\)/);assert.match(html,/box.appendChild\(manualEmpty\(\[agent\]\)\)/);
 assert.match(html,/agent-avatar-face img\[hidden\]/);
});

test('pending and failed portrait probes are shared per agent across repeated badge renders',()=>{
 const {A,images}=setup();const a=A.badge('codex',true),b=A.badge('codex',true);assert.equal(images.length,1);assert.equal(a.href,undefined);assert.equal(b.href,undefined);
 images[0].onerror();for(let i=0;i<100;i++){const c=A.badge('codex',true);assert.equal(c.href,undefined);assert.equal(c.textContent,'X');}
 assert.equal(images.length,1);assert.match(a.getAttribute('aria-label'),/画像なし/);assert.match(b.getAttribute('aria-label'),/画像なし/);
 A.badge('grok',true);assert.equal(images.length,2,'other agent has an independent cache');
});
test('successful shared probe enables all badges and is cached for future badges',()=>{
 const {A,images}=setup();const a=A.badge('claude',true),b=A.badge('claude',true);const probe=images[0];probe.onload();const c=A.badge('claude',true);
 assert.equal(images.length,1);for(const n of [a,b,c]){assert.equal(n.href,probe.src);assert.equal(n.querySelectorAll('img').length,1);}
 assert.notEqual(a.children[0],b.children[0],'each badge owns its own display image');
});
function petController(A){const c=Object.create(A.Controller.prototype);c.pets=new Map();c.assets={};c.io={observe(){}};return c;}
test('pet link waits for the same portrait probe even when a still exists',()=>{
 const {A,images}=setup(),c=petController(A);const b=A.badge('grok',true),probe=images[0],p=c.create('grok');
 assert.equal(p.node.href,undefined);assert.doesNotMatch(p.node.title,/自画像を見る/);p.still.onload();assert.equal(p.node.href,undefined,'still success does not prove portrait availability');
 probe.onload();assert.equal(b.href,probe.src);assert.equal(p.node.href,probe.src);assert.match(p.node.getAttribute('aria-label'),/自画像を見る/);
 const p2=c.create('grok');assert.equal(p2.node.href,probe.src);assert.equal(images.length,3,'one portrait probe and two pet still images');
});
test('failed portrait leaves recreated pets without href or a misleading view label',()=>{
 const {A,images}=setup(),c=petController(A);A.badge('claude',true);images[0].onerror();
 for(let i=0;i<3;i++){const p=c.create('claude');assert.equal(p.node.href,undefined);assert.doesNotMatch(p.node.getAttribute('aria-label'),/自画像を見る/);}
 assert.equal(images.length,4,'failed portrait must not create another Image; only three pet still nodes');
});
test('small empty buttons and shared guide avoid full per-column notice duplication',async()=>{
 const {O,doc}=setup();const d=O.guide();doc.ids['cli-guide']=d;
 const box=O.emptyState({agents:[{id:'claude',name:'Claude',ready:true}],onManual(){}});
 assert.equal(box.querySelectorAll('button')[0].className,'small');assert.equal(box.querySelectorAll('details').length,0);
 const link=box.querySelectorAll('a')[0];assert.equal(link.href,'#cli-guide');await link.fire('click');assert.equal(d.open,true);assert.equal(doc.activeElement,d.querySelector('summary'));
});
