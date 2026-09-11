import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Minimal event-capable DOM. Contract mocks exercise rendered controls and requests;
// this does not claim real-browser layout or server integration coverage.
class Element {
  constructor(tag) { this.tagName=tag; this.children=[]; this.attrs={}; this.events={}; this._text=''; this.value=''; this.checked=false; this.disabled=false; this.hidden=false; }
  set textContent(x) { this.replaceChildren(); this._text=String(x); }
  get textContent() { return this._text+this.children.map(x=>x.textContent).join(''); }
  setAttribute(k,v) { this.attrs[k]=v; if(k==='value')this.value=v; }
  append(...nodes) { for(const n of nodes) { n.parentElement=this; this.children.push(n); if(this.tagName==='select'&&this.children.length===1)this.value=n.value; } }
  replaceChildren(...nodes) { this._text=''; for(const n of this.children)n.parentElement=null; this.children=[]; this.append(...nodes); }
  addEventListener(k,f) { (this.events[k] ||= []).push(f); }
  fire(k) { for(const f of this.events[k] || []) f({target:this,preventDefault(){}}); }
  querySelectorAll(tag) { return this.children.flatMap(c=>[...(c.tagName===tag?[c]:[]),...c.querySelectorAll(tag)]); }
}
const plain=x=>JSON.parse(JSON.stringify(x));
const tick=()=>new Promise(r=>setImmediate(r));
const evaluation=()=>({applicable:true,itemId:'i',implDir:'topics/t/impl',projectKey:'default',policyVersion:1,
 manifest:{ok:true,errors:[]},subject:{current:'a'.repeat(64),declared:[],artifacts:[]},baseCommit:{value:'b'.repeat(40),status:'verified'},
 requirements:{sha256:'c'.repeat(64),items:[{id:'apply',targets:['u2a2a/public/index.html']},{id:'tests',targets:['u2a2a/test/example.test.mjs']}],pending:[],resolved:[]},
 checks:['apply','tests'].map(id=>({id,required:true,effective:'missing',latest:null,reasons:['check-missing']})),preview:[],log:{ok:true},
 aggregate:{status:'declared',label:'必須検証：申告で充足',complete:false,reasons:[{code:'check-missing',message:'server message',target:'tests'}]}});
function setup(fetcher=async()=>({ok:true,status:200,json:async()=>evaluation()})) {
 const ctx=vm.createContext({document:{createElement:tag=>new Element(tag)},URLSearchParams,Date,fetch:fetcher});
 vm.runInContext(fs.readFileSync(new URL('../public/verification-ui.js',import.meta.url),'utf8'),ctx);
 return {A:ctx.U2AVerification,c:new ctx.U2AVerification.Controller({fetcher})};
}
const find=(root,tag,label)=>root.querySelectorAll(tag).find(x=>x.textContent.includes(label));
const input=(root,label)=>find(root,'label',label).children.at(-1);
function selectApply(form) {
 input(form,'apply（必須）を記録').checked=true;
 const first=find(form,'label','apply（必須）').parentElement;
 input(first,'結果').value='passed'; input(first,'具体的な確認内容').value='宣言基点で適用確認を実施';
}

test('uses server label/status and only complete controls completion styling',async()=>{
 const {c}=setup();const panel=c.panel({id:'i',reviews:[{id:'r'}, {skipped:true}]});await tick();
 assert.match(panel.textContent,/レビュー：記録 1 件/);
 const badge=find(panel,'strong','申告で充足');assert.equal(badge.attrs['data-complete'],'false');
 assert.equal(badge.attrs['data-status'],'declared');assert.match(panel.textContent,/server message/);
 const v=evaluation();v.aggregate={status:'confirmed',label:'契約の確認ラベル',complete:true,reasons:[]};c.current.evaluation=v;c.render(c.current);
 assert.equal(find(panel,'strong','契約の確認ラベル').attrs['data-complete'],'true');
});
test('GET never imports or records checks; same-item rerender preserves draft DOM',async()=>{
 const calls=[];const {c}=setup(async(...args)=>{calls.push(args);return {ok:true,json:async()=>evaluation()};});
 const panel=c.panel({id:'i'});await tick(); const form=panel.querySelectorAll('form')[0];
 input(form,'実施者').value='my draft';form.fire('input');c.current.fetchedAt=0;
 assert.equal(c.panel({id:'i'}),panel);assert.equal(panel.querySelectorAll('form')[0],form);
 assert.equal(input(form,'実施者').value,'my draft');assert.equal(calls.length,1);assert.equal(calls[0][1].method,undefined);
});
test('confirmation starts unchecked; only explicitly selected item sent with displayed tokens',async()=>{
 const calls=[];const {c}=setup(async(url,options)=>{calls.push([url,options]);return {ok:true,status:options.method?201:200,json:async()=>options.method?{evaluation:evaluation()}:evaluation()};});
 const panel=c.panel({id:'i'});await tick();const form=panel.querySelectorAll('form')[0];
 form.fire('submit');await tick();assert.equal(calls.length,1);assert.match(panel.textContent,/項目を選択/);
 selectApply(form);form.fire('submit');await tick();
 const [url,options]=calls[1];assert.equal(url,'/api/pool/i/verification/confirm');
 const body=JSON.parse(options.body);assert.deepEqual(body.checks.map(x=>x.id),['apply']);
 assert.equal(body.subjectSha256,evaluation().subject.current);assert.equal(body.requirementsSha256,evaluation().requirements.sha256);
 assert.equal(body.policyVersion,1);assert.equal(body.checks[0].result,'passed');assert.equal(body.checks[0].evidence,null);
 assert.equal(body.source,undefined);assert.equal(body.checks[0].source,undefined);
});
test('selected item without explicit result cannot silently pass',async()=>{
 const {c}=setup();const panel=c.panel({id:'i'});await tick();const form=panel.querySelectorAll('form')[0];
 input(form,'apply（必須）を記録').checked=true;form.fire('submit');await tick();assert.match(panel.textContent,/結果を選択/);
});
test('409 conflict retains old snapshot, prevents retry until explicit reload',async()=>{
 let posts=0,gets=0;
 const {c}=setup(async(url,options)=>{if(options.method){posts++;return {ok:false,status:409,json:async()=>({code:'version-conflict',error:'changed',evaluation:{subject:{current:'NEW'}}})};}
 gets++;return {ok:true,json:async()=>evaluation()};});
 const panel=c.panel({id:'i'});await tick();const form=panel.querySelectorAll('form')[0];selectApply(form);form.fire('submit');await tick();
 assert.equal(c.current.conflict,true);assert.equal(c.current.evaluation.subject.current,'a'.repeat(64));assert.match(panel.textContent,/再読込して/);
 form.fire('submit');await tick();assert.equal(posts,1);
 find(panel,'button','再読込').fire('click');await tick();assert.equal(gets,2);assert.equal(c.current.conflict,false);
});
test('classify offers only allowedDecisions and sends no implicit test success',async()=>{
 const v=evaluation();v.requirements.pending=[{path:'u2a2a/test/old.test.mjs',code:'test-deleted',allowedDecisions:['deletion-accepted']}];
 const calls=[];const {c}=setup(async(url,options)=>{calls.push([url,options]);return {ok:true,json:async()=>options.method?{evaluation:v}:v};});
 const panel=c.panel({id:'i'});await tick();const form=panel.querySelectorAll('form')[1];
 const choices=input(form,'分類');assert.deepEqual(choices.children.map(x=>x.value),['','deletion-accepted']);
 choices.value='deletion-accepted';input(form,'理由').value='統合テストへ移行';form.fire('submit');await tick();
 const body=JSON.parse(calls[1][1].body);assert.equal(calls[1][0],'/api/pool/i/verification/classify');
 assert.deepEqual(body,{subjectSha256:'a'.repeat(64),policyVersion:1,path:'u2a2a/test/old.test.mjs',decision:'deletion-accepted',reason:'統合テストへ移行',method:null});
});
test('binary pending cannot be released by a UI classification',async()=>{
 const v=evaluation();v.requirements.pending=[{path:'asset.bin',code:'diff-binary',allowedDecisions:[]}];
 const {c}=setup(async()=>({ok:true,json:async()=>v}));const panel=c.panel({id:'i'});await tick();
 const form=panel.querySelectorAll('form')[1];assert.equal(form.querySelectorAll('select').length,0);assert.equal(form.querySelectorAll('button').length,0);
 assert.match(form.textContent,/分類で解除できません/);
});
test('errors branch on code, never message; malicious text remains plain text',async()=>{
 const v=evaluation();v.aggregate.reasons=[{code:'diff-binary',message:'check-missing <img onerror=bad>'}];
 const {c}=setup(async()=>({ok:true,json:async()=>v}));const panel=c.panel({id:'i'});await tick();
 assert.match(panel.textContent,/分類操作では解除できません/);assert.equal(panel.querySelectorAll('img').length,0);
});
test('history supports nextAfterSeq, project and subject filters, and partial-log warning',async()=>{
 const urls=[];const {c}=setup(async(url)=>{urls.push(url);return {ok:true,json:async()=>url.includes('/history?')?{log:{ok:false},records:[],nextAfterSeq:urls.filter(x=>x.includes('/history?')).length===1?7:null}:evaluation()};});
 const panel=c.panel({id:'i'});await tick();const details=find(panel,'summary','受理履歴').parentElement;details.open=true;details.fire('toggle');await tick();
 assert.match(urls[1],/projectKey=default/);assert.match(urls[1],/subjectSha256=a{64}/);assert.match(panel.textContent,/完全な履歴ではありません/);
 find(details,'button','続きを').fire('click');await tick();assert.match(urls[2],/afterSeq=7/);
 const all=input(details,'過去版も');all.checked=true;all.fire('change');await tick();assert.doesNotMatch(urls[3],/subjectSha256/);
});
test('slow response from another item cannot replace selected item',async()=>{
 let release;const {c}=setup(url=>url.includes('/old/')?new Promise(r=>release=()=>r({ok:true,json:async()=>({...evaluation(),itemId:'old'})})):Promise.resolve({ok:true,json:async()=>evaluation()}));
 c.panel({id:'old'});const current=c.panel({id:'i'});await tick();release();await tick();assert.equal(c.current.root,current);assert.equal(c.current.evaluation.itemId,'i');
});
test('refresh error removes previously confirmed badge',async()=>{
 let fail=false;const v=evaluation();v.aggregate={status:'confirmed',label:'確認済み',complete:true,reasons:[]};
 const {c}=setup(async()=>{if(fail)throw new Error('offline');return {ok:true,json:async()=>v};});const panel=c.panel({id:'i'});await tick();fail=true;await c.load(c.current);
 assert.equal(panel.querySelectorAll('strong').length,0);assert.match(panel.textContent,/offline/);
});
test('confirmation payload helper preserves failed/not_run and excludes unchecked values',()=>{
 const {A}=setup();const b=A.confirmationBody(evaluation(),'user',[{selected:false,id:'tests',result:'passed'},{selected:true,id:'apply',result:'not_run',reason:'runtime missing'}]);
 assert.deepEqual(plain(b.checks),[{id:'apply',result:'not_run',reason:'runtime missing'}]);
 assert.throws(()=>A.classificationBody(evaluation(),{path:'x',allowedDecisions:[]},'not-test','x',null));
});
test('input begun during an automatic refresh is preserved and requires reload',async()=>{
 let pending=null;let hold=false;const {c}=setup(()=>hold?new Promise(r=>pending=r):Promise.resolve({ok:true,json:async()=>evaluation()}));
 const panel=c.panel({id:'i'});await tick();const form=panel.querySelectorAll('form')[0];hold=true;
 const refresh=c.load(c.current);input(form,'実施者').value='draft';form.fire('input');
 pending({ok:true,json:async()=>evaluation()});await refresh;
 assert.equal(panel.querySelectorAll('form')[0],form);assert.equal(input(form,'実施者').value,'draft');assert.equal(c.current.conflict,true);
 assert.equal(panel.querySelectorAll('strong')[0].attrs['data-complete'],'false');
});
test('503 preserves explicit inputs and shows server error without false completion',async()=>{
 const {c}=setup(async(url,opts)=>opts.method?{ok:false,status:503,json:async()=>({code:'log-unavailable',error:'log unavailable'})}:{ok:true,json:async()=>evaluation()});
 const panel=c.panel({id:'i'});await tick();const form=panel.querySelectorAll('form')[0];selectApply(form);form.fire('submit');await tick();
 assert.match(panel.textContent,/log-unavailable/);assert.equal(panel.querySelectorAll('form')[0],form);assert.equal(c.current.busy,false);
});

test('missing verification script keeps the host detail renderer callable',()=>{
 const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 const init=html.match(/const verificationUI = [\s\S]*?(?=\nfunction renderPoolDetail)/)[0];
 for(const value of [undefined,null,{}]) {
  const ctx=vm.createContext({U2AVerification:value,el:(tag,attrs,children)=>({tag,attrs,children})});
  const panel=vm.runInContext(init+'\nverificationUI.panel({id:"i"})',ctx);
  assert.equal(panel.attrs.role,'status');assert.match(panel.attrs.text,/検証UIを読み込めません/);
 }
 const ctx=vm.createContext({el:(tag,attrs,children)=>({tag,attrs,children})});
 assert.doesNotThrow(()=>vm.runInContext(init+'\nverificationUI.panel({id:"i"})',ctx));
});
test('submission status is left to the host header',async()=>{
 const {c}=setup();const panel=c.panel({id:'i',status:'rejected',reviews:[]});await tick();
 assert.doesNotMatch(panel.textContent,/提出：登録あり/);assert.match(panel.textContent,/レビュー：記録 0 件/);
});
test('explicit import posts an empty object, shows mixed counts, and avoids an immediate refresh',async()=>{
 const calls=[];const {c}=setup(async(url,options)=>{calls.push([url,options]);return {ok:true,json:async()=>options.method?{
  added:1,duplicates:2,rejected:[{id:'tests',code:'subject-mismatch',message:'old version'}],evaluation:evaluation()
 }:evaluation()};});
 const panel=c.panel({id:'item/with space'});await tick();c.current.fetchedAt=0;
 find(panel,'button','manifestの申告を取り込む').fire('click');await tick();
 assert.equal(calls.length,2);assert.equal(calls[1][0],'/api/pool/item%2Fwith%20space/verification/import');
 assert.equal(calls[1][1].method,'POST');assert.deepEqual(JSON.parse(calls[1][1].body),{});
 assert.match(panel.textContent,/受理 1 件／重複 2 件／拒否 1 件/);assert.match(panel.textContent,/tests \/ subject-mismatch: old version/);
 c.panel({id:'item/with space'});await tick();assert.equal(calls.length,2);
});
test('invalid argv and empty actor are rejected before sending; valid command is preserved',async()=>{
 const calls=[];const {c}=setup(async(url,options)=>{calls.push([url,options]);return {ok:true,json:async()=>options.method?{evaluation:evaluation()}:evaluation()};});
 const panel=c.panel({id:'i'});await tick();const form=panel.querySelectorAll('form')[0];selectApply(form);
 const row=find(form,'label','apply（必須）').parentElement;
 input(row,'確認方法').value='command';input(row,'確認方法').fire('change');
 assert.equal(input(row,'具体的な確認内容').parentElement.hidden,true);
 input(row,'証跡パス').value='result.txt';input(row,'証跡SHA').value='d'.repeat(64);
 for(const value of ['[]','[1]','"git"','[""]','{','null']) {
  input(row,'argv').value=value;form.fire('submit');await tick();assert.equal(calls.length,1);assert.match(panel.textContent,/argv/);
 }
 input(row,'argv').value='["git","apply","--check"]';input(form,'実施者').value='';
 form.fire('submit');await tick();assert.equal(calls.length,1);assert.match(panel.textContent,/実施者を1〜80文字/);
 input(form,'実施者').value='codex';form.fire('submit');await tick();assert.equal(calls.length,2);
 assert.deepEqual(JSON.parse(calls[1][1].body).checks[0].method,{type:'command',argv:['git','apply','--check'],cwd:'.'});
});
test('UTC input validates only selected executed checks and provides reason length guidance',async()=>{
 const calls=[];const {c}=setup(async(url,options)=>{calls.push([url,options]);return {ok:true,json:async()=>options.method?{evaluation:evaluation()}:evaluation()};});
 const panel=c.panel({id:'i'});await tick();let form=panel.querySelectorAll('form')[0];selectApply(form);
 let row=find(form,'label','apply（必須）').parentElement;
 assert.equal(input(row,'理由').attrs.maxlength,'2000');assert.match(input(row,'実施日時').attrs.placeholder,/Z$/);
 for(const value of ['2026-02-30T12:00:00Z','2026-09-11','2026-09-11T12:34:56+09:00','2026-09-11T12:34:56.1234Z']) {
  input(row,'実施日時').value=value;form.fire('submit');await tick();assert.equal(calls.length,1);assert.match(panel.textContent,/実在するUTC日時/);
 }
 input(row,'実施日時').value='2026-09-11T12:34:56.12Z';
 const unselected=find(form,'label','tests（必須）').parentElement;input(unselected,'実施日時').value='invalid';
 form.fire('submit');await tick();assert.equal(calls.length,2);assert.equal(JSON.parse(calls[1][1].body).checks[0].executedAt,'2026-09-11T12:34:56.12Z');
 form=panel.querySelectorAll('form')[0];selectApply(form);row=find(form,'label','apply（必須）').parentElement;
 input(row,'結果').value='not_run';input(row,'理由').value='未実行';input(row,'実施日時').value='invalid';
 form.fire('submit');await tick();assert.equal(calls.length,3);assert.equal(JSON.parse(calls[2][1].body).checks[0].executedAt,null);
});
test('stale dirty form shows reload guidance and conflict never refreshes automatically',async()=>{
 let gets=0;const {c}=setup(async()=>{gets++;return {ok:true,json:async()=>evaluation()};});
 const panel=c.panel({id:'i'});await tick();const form=panel.querySelectorAll('form')[0];form.fire('input');c.current.fetchedAt=0;
 c.panel({id:'i'});await tick();assert.equal(gets,1);assert.equal(panel.querySelectorAll('form')[0],form);
 assert.match(panel.textContent,/最新の検証情報を確認するには再読込/);assert.equal(panel.querySelectorAll('strong')[0].attrs['data-complete'],'false');
 c.current.dirty=false;c.current.conflict=true;c.panel({id:'i'});await tick();assert.equal(gets,1);
});
test('failed explicit reload clears discarded draft state and recovers after SSE rerender',async()=>{
 let fail=false,gets=0;const {c}=setup(async()=>{gets++;if(fail)throw new Error('offline');return {ok:true,json:async()=>evaluation()};});
 const panel=c.panel({id:'i'});await tick();const form=panel.querySelectorAll('form')[0],oldNotice=c.current.notice;
 input(form,'実施者').value='discard me';form.fire('input');c.current.conflict=true;fail=true;
 find(panel,'button','再読込').fire('click');await tick();
 assert.equal(c.current.dirty,false);assert.equal(c.current.conflict,false);assert.equal(c.current.evaluation,null);
 assert.equal(panel.querySelectorAll('form').length,0);assert.equal(panel.querySelectorAll('strong').length,0);
 assert.equal(oldNotice.parentElement,null);assert.notEqual(c.current.notice,oldNotice);assert.equal(c.current.notice.parentElement,c.current.content);
 assert.match(panel.textContent,/offline/);assert.match(panel.textContent,/通信を確認/);
 c.current.fetchedAt=Date.now()-16000;assert.doesNotThrow(()=>c.panel({id:'i'}));await tick();assert.equal(gets,3);
 assert.equal(c.current.loading,false);fail=false;find(panel,'button','再読込').fire('click');await tick();
 assert.equal(gets,4);assert.equal(input(panel.querySelectorAll('form')[0],'実施者').value,'user');
});
test('failed background refresh preserves newly entered draft and disables stale submission',async()=>{
 let reject,hold=false,posts=0;const v=evaluation();v.aggregate={status:'confirmed',label:'確認済み',complete:true,reasons:[]};
 const {c}=setup((url,opts)=>{if(opts.method)posts++;return hold?new Promise((resolve,r)=>{reject=r;}):Promise.resolve({ok:true,json:async()=>v});});
 const panel=c.panel({id:'i'});await tick();const form=panel.querySelectorAll('form')[0];hold=true;
 const refresh=c.load(c.current);selectApply(form);input(form,'実施者').value='keep me';form.fire('input');reject(new Error('offline'));await refresh;
 assert.equal(panel.querySelectorAll('form')[0],form);assert.equal(input(form,'実施者').value,'keep me');assert.equal(c.current.dirty,true);
 assert.equal(c.current.conflict,true);assert.equal(form.querySelectorAll('fieldset')[0].disabled,true);
 assert.equal(panel.querySelectorAll('strong')[0].attrs['data-complete'],'false');assert.match(panel.textContent,/offline.*入力を保持/);
 form.fire('submit');await tick();assert.equal(posts,0);hold=false;find(panel,'button','再読込').fire('click');await tick();
 assert.equal(c.current.dirty,false);assert.equal(c.current.conflict,false);
});
test('notice recreates a missing or detached node during dirty SSE rerender',async()=>{
 const {c}=setup();const panel=c.panel({id:'i'});await tick();
 const e=c.current;const oldNotice=e.notice;e.content.replaceChildren();e.dirty=true;e.fetchedAt=Date.now()-16000;
 assert.doesNotThrow(()=>c.panel({id:'i'}));assert.notEqual(e.notice,oldNotice);assert.equal(e.notice.parentElement,e.content);
 assert.match(panel.textContent,/入力を保持/);e.notice=null;assert.doesNotThrow(()=>c.notice(e,'visible notice'));assert.match(panel.textContent,/visible notice/);
});
test('initial fetch failure remains retryable and recreates a visible notice',async()=>{
 let fail=true;const {c}=setup(async()=>{if(fail)throw new Error('offline');return {ok:true,json:async()=>evaluation()};});
 const panel=c.panel({id:'i'});await tick();assert.equal(c.current.notice.parentElement,c.current.content);assert.equal(c.current.dirty,false);
 assert.match(panel.textContent,/offline/);fail=false;find(panel,'button','再読込').fire('click');await tick();
 assert.equal(panel.querySelectorAll('form').length,1);assert.equal(c.current.loading,false);
});
