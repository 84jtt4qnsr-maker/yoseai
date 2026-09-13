import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Event-capable DOM mock: verifies controls/API contract, not browser rendering.
class Element {
  constructor(tag,doc) {Object.assign(this,{tagName:tag,doc,children:[],attrs:{},events:{},_text:'',value:'',checked:false,disabled:false,hidden:false,open:false});}
  set textContent(v) {this.replaceChildren();this._text=String(v);}
  get textContent() {return this._text+this.children.map(c=>c.textContent).join('');}
  setAttribute(k,v) {this.attrs[k]=String(v);if(k==='value')this.value=String(v);if(k==='hidden')this.hidden=true;}
  getAttribute(k) {return this.attrs[k] ?? null;}
  append(...nodes) {for(const c of nodes){c.parentElement=this;this.children.push(c);}}
  replaceChildren(...nodes) {for(const c of this.children)c.parentElement=null;this.children=[];this._text='';this.append(...nodes);}
  addEventListener(k,f) {(this.events[k] ||= []).push(f);}
  fire(k) {for(const f of this.events[k] || [])f({target:this,preventDefault(){}});}
  querySelectorAll(tag) {return this.children.flatMap(c=>[...(c.tagName===tag?[c]:[]),...c.querySelectorAll(tag)]);}
  focus() {this.doc.activeElement=this;}
  showModal() {this.open=true;}
  close() {this.open=false;this.fire('close');}
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const hash='a'.repeat(64), id='req_0000000000000001', qid='req_0000000000000002';
const plain=x=>JSON.parse(JSON.stringify(x));
function proposal(overrides={}) {
 return {id,topicId:'t',kind:'start-task',status:'pending',title:'トレイを実装',proposer:'claude',proposerName:'Claude Code',
 ts:Date.now(),updatedTs:Date.now(),proposalSha256:hash,
 block:{v:1,kind:'start-task',to:'user',title:'トレイを実装',outcome:'ボタンで判断できる',scope:['サーバ','UI'],outOfScope:['自動適用'],
 tasks:[{key:'api',agent:'claude',title:'API契約',scope:['API']},{key:'ui',agent:'codex',title:'UI実装',scope:['画面'],after:['api']}],
 baseCommit:'b'.repeat(40),basis:{memo:'topics/t/memo.md'}},
 basis:{kind:'memo',path:'topics/t/memo.md',status:'ok',sha256:hash},details:[{path:'topics/t/spec.md',status:'ok',sha256:hash}],
 baseCommit:{value:'b'.repeat(40),status:'verified',headMatches:true},dependencies:{waiting:[],excluded:[],coverage:'ok'},
 blockers:[],actionable:{approve:true,answer:false,park:true,revision:true,reject:true},answer:null,decision:null,plan:null,
 replaces:null,supersededBy:null,...overrides};
}
function question(overrides={}) {
 const r=proposal({id:qid,kind:'question',title:'通知方法',...overrides});
 r.block={v:1,kind:'question',to:'user',title:'通知方法',continueAgent:'codex',questions:[
 {id:'notify',text:'通知はどれ',recommended:'badge',options:[{id:'badge',label:'バッジ',effect:'件数を表示'},{id:'toast',label:'通知',effect:'通知からトレイを開く'}]},
 {id:'sound',text:'音はどれ',options:[{id:'on',label:'あり',effect:'音を出す'},{id:'off',label:'なし',effect:'音を出さない'}]}]};
 r.actionable={approve:false,answer:true,park:true,revision:true,reject:true,...overrides.actionable};return r;
}
function view(...requests) {
 const topics={},index={};
 for(const r of requests) {
  index[r.id]=r;const t=topics[r.topicId] ||= {waiting:[],later:[],history:[],pendingSlotTaken:false};
  t[r.status==='pending'?'waiting':['parked','revision-requested'].includes(r.status)?'later':'history'].push(r.id);
  if(r.status==='pending')t.pendingSlotTaken=true;
 }
 return {version:1,topics,requests:index};
}
function setup(initial=view(proposal()), handler=null) {
 const calls=[],doc={activeElement:null};doc.createElement=tag=>new Element(tag,doc);doc.body=doc.createElement('body');
 let responseView=initial;
 const fetcher=async(url,options={})=>{
  calls.push({url,options});
  if(handler){const response=await handler(url,options);if(response)return response;}
  return {ok:true,status:200,json:async()=>options.method?{request:initial.requests[id]}:responseView};
 };
 const ctx=vm.createContext({document:doc,Date,fetch:fetcher});
 vm.runInContext(fs.readFileSync(new URL('../public/tray-ui.js',import.meta.url),'utf8'),ctx);
 const c=new ctx.U2ATray.Controller({fetcher,topicName:tid=>'Topic '+tid});
 c.update(initial);
 return {c,calls,doc,A:ctx.U2ATray,setView:v=>{responseView=v;}};
}
const find=(root,tag,label)=>root.querySelectorAll(tag).find(x=>x.textContent.includes(label));
const click=(root,label)=>{const el=find(root,'button',label);assert.ok(el,label);el.fire('click');return el;};
const result=(status,data)=>({ok:status<400,status,json:async()=>data});

test('three server-indexed sections, cross-topic grouping and always visible blocker',()=>{
 const r=proposal({blockers:[{code:'basis-changed',message:'根拠が変わりました',target:'memo'}],actionable:{approve:false}});
 const {c}=setup(view(r,question({topicId:'other',status:'parked'}),proposal({id:'old',status:'approved'})));
 assert.match(c.cards.textContent,/Topic t.*根拠が変わりました/);
 assert.equal(c.cards.querySelectorAll('details').length,0);
 click(c.nav,'あとで');assert.match(c.cards.textContent,/Topic other.*通知方法/);
 click(c.nav,'履歴');assert.match(c.cards.textContent,/承認済み/);
});
test('all eleven blocker messages preserved; permissions solely from actionable',()=>{
 const {c,A}=setup();const reasons=Object.keys(A.REASONS).map(code=>({code,message:'server:'+code,target:null}));
 c.update(view(proposal({blockers:reasons,actionable:{approve:true}})));
 c.select(id);assert.equal(reasons.length,11);
 for(const x of reasons)assert.ok(c.cards.textContent.includes(x.message));
 assert.equal(find(c.detail,'button','着手を承認').disabled,false);
 c.update(view(proposal({blockers:[],actionable:{approve:false}})));
 assert.equal(find(c.detail,'button','着手を承認').disabled,true);
});
test('notification never approves, no automatic dialog or focus theft',()=>{
 const {c,calls,doc}=setup();
 assert.equal(c.dialog.open,false);assert.equal(doc.activeElement,null);
 assert.equal(c.notification.querySelectorAll('button').some(x=>x.textContent.includes('承認')),false);
 click(c.notification,'トレイを開く');assert.equal(c.dialog.open,true);
 assert.equal(calls.filter(x=>x.options.method).length,0);
});
test('approval disclosure shows scope owner base dependencies exclusions and done semantics',()=>{
 const r=proposal({dependencies:{waiting:[{id:qid,title:'未回答の配色',status:'parked'}],excluded:[{id:'x',title:'音',status:'parked',reason:'音は今回扱わない'}]}});
 const {c}=setup(view(r,question()));c.select(id);
 for(const text of ['何ができるか','ボタンで判断','今回の範囲','Claude Code','Codex','b'.repeat(40),'待っている質問','未回答の配色','外した質問','音は今回扱わない','タスク2件','done','returned','追加']) {
  if(text!=='追加') assert.ok(c.detail.textContent.includes(text),text);
 }
});
test('question recommendations are not preselected; all questions require explicit answers',async()=>{
 const {c,calls}=setup(view(question()));c.select(qid);
 const selects=c.detail.querySelectorAll('select');assert.ok(selects.every(x=>x.value===''));
 c.detail.querySelectorAll('form')[0].fire('submit');await tick();assert.equal(calls.length,0);
 assert.match(c.detail.textContent,/すべての質問/);
 assert.ok(selects[0].textContent.includes('おすすめ'));
});
test('answer sends exact displayed hash and only explicit answers',async()=>{
 const {c,calls}=setup(view(question()));c.select(qid);
 const form=c.detail.querySelectorAll('form')[0], sels=form.querySelectorAll('select');
 sels[0].value='badge';sels[1].value='__defer';form.fire('submit');await tick();
 const post=calls.find(x=>x.options.method);assert.equal(post.url,'/api/tray/'+qid+'/answer');
 assert.deepEqual(JSON.parse(post.options.body),{answers:[{questionId:'notify',optionId:'badge'},{questionId:'sound',optionId:'__defer'}],proposalSha256:hash});
 assert.match(c.detail.textContent,/一部だけ.*回答済み/);
});
test('other requires text; defer has no text; no implicit answer on GET',async()=>{
 const {c,calls}=setup(view(question()));c.select(qid);
 const form=c.detail.querySelectorAll('form')[0], sels=form.querySelectorAll('select');
 sels[0].value='__other';sels[0].fire('change');sels[1].value='__defer';
 form.fire('submit');await tick();assert.equal(calls.length,0);
 form.querySelectorAll('textarea')[0].value='別案';form.fire('submit');await tick();
 const body=JSON.parse(calls.find(x=>x.options.method).options.body);
 assert.equal(body.answers[0].text,'別案');assert.equal(body.answers[1].text,undefined);
});
test('all deferred choices sent as answer payload; server decides parked',async()=>{
 const {c,calls}=setup(view(question()));c.select(qid);const form=c.detail.querySelectorAll('form')[0];
 form.querySelectorAll('select').forEach(x=>x.value='__defer');form.fire('submit');await tick();
 assert.ok(JSON.parse(calls[0].options.body).answers.every(a=>a.optionId==='__defer'));
 assert.equal(c.current.snapshot.status,'pending');
});
test('SSE with same version preserves form values and node identity',()=>{
 const {c}=setup(view(question()));c.select(qid);
 const form=c.detail.querySelectorAll('form')[0];form.querySelectorAll('select')[0].value='toast';
 c.update(view(question({updatedTs:Date.now()+10})));
 assert.equal(c.detail.querySelectorAll('form')[0],form);assert.equal(form.querySelectorAll('select')[0].value,'toast');
});
test('SSE new hash disables frozen form without replacing draft',()=>{
 const {c,calls}=setup(view(question()));c.select(qid);
 const form=c.detail.querySelectorAll('form')[0];form.querySelectorAll('select')[0].value='badge';
 c.update(view(question({proposalSha256:'c'.repeat(64)})));
 assert.equal(c.current.locked,true);assert.equal(form.querySelectorAll('fieldset')[0].disabled,true);
 form.fire('submit');assert.equal(calls.length,0);assert.equal(c.current.snapshot.proposalSha256,hash);
});
test('409 stale-proposal locks old form even if current response contains a new request',async()=>{
 const {c,calls,setView}=setup(view(proposal()),async(url,opt)=>opt.method?result(409,{code:'stale-proposal',error:'古い版',current:proposal({proposalSha256:'c'.repeat(64)})}):null);
 c.select(id);click(c.detail,'着手を承認');await tick();
 assert.equal(c.current.snapshot.proposalSha256,hash);assert.equal(c.current.locked,true);
 click(c.detail,'着手を承認');await tick();assert.equal(calls.filter(x=>x.options.method).length,1);
 setView(view(proposal({proposalSha256:'c'.repeat(64)})));
 click(c.detail,'最新の依頼を表示');await tick();
 assert.equal(c.current.snapshot.proposalSha256,'c'.repeat(64));assert.equal(c.current.locked,false);
});
test('repeated approval click during request yields one POST',async()=>{
 let finish;const {c,calls}=setup(view(proposal()),(url,opt)=>opt.method?new Promise(resolve=>finish=resolve):null);
 c.select(id);click(c.detail,'着手を承認');click(c.detail,'着手を承認');
 assert.equal(calls.length,1);finish(result(200,{request:proposal({status:'approved'})}));await tick();
 assert.equal(c.current.locked,true);
});
test('revision form targets + optional note, other requires note',async()=>{
 const {c,calls}=setup();c.select(id);
 const forms=c.detail.querySelectorAll('form'),form=forms[0];
 form.querySelectorAll('input')[3].checked=true;form.fire('submit');await tick();assert.equal(calls.length,0);
 form.querySelectorAll('input')[3].checked=false;form.querySelectorAll('input')[0].checked=true;
 form.fire('submit');await tick();
 assert.deepEqual(JSON.parse(calls[0].options.body),{targets:['scope'],note:'',mode:'proposer',proposalSha256:hash});
 assert.ok(calls[0].url.endsWith('/revision'));assert.equal(c.dialog.open,false);
});
test('reject preserves target choice inside contract note, never posts targets',async()=>{
 const {c,calls}=setup();c.select(id);const form=c.detail.querySelectorAll('form')[1];
 form.querySelectorAll('input')[1].checked=true;form.querySelectorAll('textarea')[0].value='今回は保留';
 form.fire('submit');await tick();const body=JSON.parse(calls[0].options.body);
 assert.deepEqual(body,{note:'対象：担当\n今回は保留',proposalSha256:hash});
 assert.ok(calls[0].url.endsWith('/reject'));
});
test('park action includes version and never answers',async()=>{
 const {c,calls}=setup();c.select(id);click(c.detail,'あとで答える');await tick();
 assert.ok(calls[0].url.endsWith('/park'));assert.deepEqual(JSON.parse(calls[0].options.body),{proposalSha256:hash});
});
test('unpark pending-conflict locks actions and provides reason',async()=>{
 const {c}=setup(view(proposal({status:'parked'})),(url,opt)=>opt.method?result(409,{code:'pending-conflict'}):null);
 c.select(id);click(c.detail,'判断待ちへ戻す');await tick();assert.equal(c.current.locked,true);assert.match(c.detail.textContent,/別の判断待ち/);
});
function planned() {
 return proposal({status:'approved',actionable:{},plan:{entries:[
 {key:'api',agent:'claude',taskId:'t1',after:[],send:'sent'},
 {key:'ui',agent:'codex',taskId:'t2',after:['api'],send:'waiting'},
 {key:'qa',agent:'grok',taskId:'t3',after:[],send:'failed',error:'送信失敗'},
 {key:'blocked',agent:'grok',taskId:null,after:[],send:'blocked'},
 {key:'ready',agent:'codex',taskId:'t4',after:[],send:'ready',error:'自動OFF'}]}});
}
test('waiting/blocked never have retry; failed/ready do; retry uses task key',async()=>{
 const {c,calls}=setup(view(planned()));c.select(id);
 const retry=c.detail.querySelectorAll('button').filter(x=>x.textContent.includes('再試行'));
 assert.equal(retry.length,2);assert.match(c.detail.textContent,/前提待ち/);
 retry[0].fire('click');await tick();assert.ok(calls[0].url.endsWith('/plan/retry'));
 assert.deepEqual(JSON.parse(calls[0].options.body),{taskKey:'qa',proposalSha256:hash});
});
test('plan SSE changes refresh status without confusing sent with task done',()=>{
 const r=planned(),{c}=setup(view(r));c.select(id);
 r.plan.entries[1].send='sent';c.update(view(r));
 assert.match(c.current.planRoot.textContent,/ui：着手指示を送信済み/);
 assert.equal(c.downstream('t1'),'');
});
test('task completion warning names downstream and all-preconditions rule',()=>{
 const {c}=setup(view(planned()));const s=c.downstream('t1');
 assert.match(s,/Codex/);assert.match(s,/全前提/);assert.match(s,/送信条件/);
});
test('network disconnect disables actions; reconnect does not silently revive old form',()=>{
 const {c}=setup();c.select(id);c.disconnect();assert.equal(find(c.detail,'button','着手を承認').disabled,true);
 c.update(view(proposal()));assert.equal(c.current.locked,true);
});
test('late GET cannot replace newer SSE state',async()=>{
 let finish;const {c}=setup(view(proposal()),(url,opt)=>!opt.method?new Promise(resolve=>finish=resolve):null);
 const loading=c.refresh();c.update(view(proposal({proposalSha256:'d'.repeat(64)})));
 finish(result(200,view(proposal())));await loading;assert.equal(c.view.requests[id].proposalSha256,'d'.repeat(64));
});
test('malicious text stays text and links only target local pool paths',()=>{
 const {c,A}=setup(view(proposal({title:'<img src=x onerror=alert(1)>'})));c.select(id);
 assert.equal(c.detail.querySelectorAll('img').length,0);
 assert.equal(A.safeFile('javascript:alert(1)'),null);assert.equal(A.safeFile('topics/../x'),null);
 assert.equal(A.safeFile('topics/t/a b.md'),'/api/pool/file/topics/t/a%20b.md');
});
test('explicit reload clears draft even when proposal hash is unchanged',async()=>{
 const {c}=setup(view(question()));c.select(qid);const old=c.current;
 c.detail.querySelectorAll('select')[0].value='toast';click(c.detail,'最新の依頼を表示');await tick();
 assert.notEqual(c.current,old);assert.equal(c.detail.querySelectorAll('select')[0].value,'');
});
test('terminal / removed request locks existing controls',()=>{
 const {c}=setup();c.select(id);c.update(view());assert.equal(c.current.locked,true);
});
test('revision-requested stays later, with no second revision or answer controls',()=>{
 const {c}=setup(view(proposal({status:'revision-requested',actionable:{}})));
 click(c.nav,'あとで');c.select(id);assert.match(c.cards.textContent,/修正待ち/);
 assert.equal(c.detail.querySelectorAll('form').length,0);
 assert.equal(find(c.detail,'button','着手を承認').disabled,true);
});
test('integration loads script, mounts launcher, syncs SSE and task-completion disclosure',()=>{
 const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 assert.match(html,/<script src="\/tray-ui.js"><\/script>/);
 assert.match(html,/trayUI.update\(state.tray\)/);
 // SSEは既存yoseaiOpenEvents＋LiveConnection。エラー時に切断表示が呼ばれることを見る
 assert.match(html,/onDisconnect: \(\) => \{\s*trayUI.disconnect\(\)/);
 assert.match(html,/trayUI.downstream\(t.id\)/);
 assert.match(html,/setViewMode\("columns"\)/);
 const inline=html.split('<script>')[1].split('</script>')[0];new vm.Script(inline);
});

const revisionForm=c=>c.detail.querySelectorAll('form')[0];
const target=(form,value)=>form.querySelectorAll('input').find(x=>x.getAttribute('type')==='checkbox' && x.value===value);
const modeInput=(form,value)=>form.querySelectorAll('input').find(x=>x.getAttribute('type')==='radio' && x.value===value);
const change=(input,checked)=>{input.checked=checked;input.fire('change');};
const modeGroup=form=>form.querySelectorAll('fieldset').find(x=>x.getAttribute('class')==='tray-revision-mode');
test('revision scope/assignee reveals two choices, proposer default, selection alone never sends',async()=>{
 const {c,calls}=setup();c.select(id);const form=revisionForm(c);assert.equal(modeGroup(form).hidden,true);
 change(target(form,'scope'),true);assert.equal(modeGroup(form).hidden,false);assert.equal(modeInput(form,'proposer').checked,true);assert.equal(calls.length,0);
 assert.ok(find(form,'button','修正を依頼して閉じる'));change(modeInput(form,'rediscuss'),true);
 assert.ok(find(form,'button','質疑を開始して閉じる'));assert.match(form.textContent,/旧合意は履歴に残/);assert.equal(calls.length,0);
});
test('explicit relay confirm posts selected mode and frozen hash once; closes on success only',async()=>{
 let finish;const {c,calls}=setup(view(proposal()),(url,opt)=>opt.method?new Promise(r=>finish=r):null);c.select(id);c.dialog.showModal();
 const form=revisionForm(c);change(target(form,'assignee'),true);change(modeInput(form,'rediscuss'),true);form.fire('submit');form.fire('submit');
 assert.equal(calls.length,1);assert.equal(c.dialog.open,true);assert.deepEqual(JSON.parse(calls[0].options.body),{targets:['assignee'],note:'',mode:'rediscuss',proposalSha256:hash});
 finish(result(200,{request:proposal({status:'revision-requested'})}));await tick();assert.equal(c.dialog.open,false);
});
test('removing all eligible targets resets hidden mode to proposer before confirmation',async()=>{
 const {c,calls}=setup();c.select(id);const form=revisionForm(c);change(target(form,'scope'),true);change(modeInput(form,'rediscuss'),true);change(target(form,'approach'),true);change(target(form,'scope'),false);
 assert.equal(modeGroup(form).hidden,true);assert.equal(modeInput(form,'proposer').checked,true);assert.ok(find(form,'button','修正を依頼して閉じる'));
 form.fire('submit');await tick();assert.equal(JSON.parse(calls[0].options.body).mode,'proposer');
});
test('same-version SSE preserves mode and targets; new version prevents sending',async()=>{
 const {c,calls}=setup();c.select(id);const form=revisionForm(c);change(target(form,'scope'),true);change(modeInput(form,'rediscuss'),true);
 c.update(view(proposal()));assert.equal(revisionForm(c),form);assert.equal(modeInput(form,'rediscuss').checked,true);
 c.update(view(proposal({proposalSha256:'c'.repeat(64)})));form.fire('submit');await tick();assert.equal(calls.length,0);assert.equal(c.current.locked,true);
});
test('stale revision and failed revision keep the dialog visible; no implicit relay retry',async()=>{
 for(const status of [409,400]){
  const {c,calls}=setup(view(proposal()),(url,opt)=>opt.method?result(status,{code:status===409?'stale-proposal':'invalid-request',error:'rejected'}):null);c.select(id);c.dialog.showModal();
  const form=revisionForm(c);change(target(form,'scope'),true);change(modeInput(form,'rediscuss'),true);form.fire('submit');await tick();
  assert.equal(c.dialog.open,true);assert.equal(calls.length,1);assert.equal(c.current.locked,status===409);
 }
});
test('other still requires note with relay mode, and reject never has mode choices',async()=>{
 const {c,calls}=setup();c.select(id);const form=revisionForm(c);change(target(form,'scope'),true);change(target(form,'other'),true);change(modeInput(form,'rediscuss'),true);
 form.fire('submit');await tick();assert.equal(calls.length,0);assert.match(c.detail.textContent,/その他の補足/);
 const reject=c.detail.querySelectorAll('form')[1];assert.equal(reject.querySelectorAll('input').filter(x=>x.getAttribute('type')==='radio').length,0);
});

test('replacement proposal retains old-request navigation and field differences',()=>{
 const old=proposal({id:'old',status:'revision-requested',actionable:{}}),next=proposal({replaces:'old'});next.block.scope=['修正した範囲'];
 const {c,calls}=setup(view(old,next));c.select(id);assert.match(c.detail.textContent,/以前の依頼との項目差分/);assert.match(c.detail.textContent,/修正した範囲/);
 click(c.detail,'以前の依頼を確認');assert.equal(c.current.snapshot.id,'old');assert.equal(calls.length,0);
});

test('rediscuss-unavailable keeps server reason visible, no fallback to proposer',async()=>{
 const {c,calls}=setup(view(proposal()),(url,opt)=>opt.method?result(409,{code:'rediscuss-unavailable',error:'このトピックでは質疑が進行中です。'}):null);
 c.select(id);c.dialog.showModal();const form=revisionForm(c);change(target(form,'scope'),true);change(modeInput(form,'rediscuss'),true);form.fire('submit');await tick();
 assert.equal(c.dialog.open,true);assert.match(c.detail.textContent,/質疑が進行中/);assert.equal(c.current.locked,true);assert.equal(calls.length,1);
});
test('explicit proposer confirmation closes after acceptance and never posts a QA start',async()=>{
 const {c,calls}=setup();c.select(id);c.dialog.showModal();const form=revisionForm(c);change(target(form,'approach'),true);form.fire('submit');await tick();
 assert.equal(c.dialog.open,false);assert.equal(JSON.parse(calls[0].options.body).mode,'proposer');assert.ok(calls[0].url.endsWith('/revision'));assert.equal(calls.some(x=>x.url.includes('/qa/')),false);
});
