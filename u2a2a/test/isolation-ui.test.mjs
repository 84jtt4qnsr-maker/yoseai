import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const token='a'.repeat(64), next='b'.repeat(64);
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const source=fs.readFileSync(new URL('../public/isolation-ui.js',import.meta.url),'utf8');
const bootstrap=html.match(/<script>\s*\(function \(\) \{[\s\S]*?<\/script>/)[0].replace(/^<script>|<\/script>$/g,'');
const response=(status,data)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
function mockDocument() {
 const doc={activeElement:null};
 class Node {
  constructor(tag){this.tagName=tag;this.children=[];this.attrs={};this.events={};this.dataset={};this._text='';this.value='';this.disabled=false;this.open=false;}
  set textContent(v){this.children=[];this._text=String(v);}
  get textContent(){return this._text+this.children.map(e=>e.textContent).join('');}
  setAttribute(k,v){this.attrs[k]=v;}
  append(...nodes){this.children.push(...nodes);}
  addEventListener(k,f){(this.events[k]||=[]).push(f);}
  fire(k){for(const f of this.events[k]||[])f({preventDefault(){}});}
  showModal(){this.open=true;}
  close(){this.open=false;this.fire('close');}
  focus(){doc.activeElement=this;}
 }
 doc.createElement=tag=>new Node(tag);doc.body=doc.createElement('body');return doc;
}
function setup({hash='',saved='',fetcher=async()=>response(200,{})}={}) {
 const storage=new Map(saved?[['yoseai.credential',saved]]:[]), replacements=[],calls=[],events=[];
 const location={href:'http://127.0.0.1:4797/'+hash,origin:'http://127.0.0.1:4797',pathname:'/',search:'',hash,reload(){this.reloaded=true;}};
 const doc=mockDocument();
 const ctx=vm.createContext({URL,URLSearchParams,Request,Response,Headers,Event,setTimeout,clearTimeout,document:doc,location,
  history:{replaceState:(_,__,url)=>{replacements.push(url);location.hash=new URL(url,location.href).hash;}},
  sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
  fetch:async(...args)=>{calls.push(args);return fetcher(...args);},
  EventSource:class {constructor(url){this.url=url;events.push(this);}close(){this.closed=true;}}});
 vm.runInContext('window=globalThis',ctx);vm.runInContext(bootstrap,ctx);vm.runInContext(source,ctx);
 const media=new ctx.YoseaiIsolation.Media();const c=new ctx.YoseaiIsolation.Controller({client:media});
 return {ctx,media,c,storage,calls,events,location,replacements,doc,A:ctx.YoseaiIsolation};
}
const isolation=(mode,verified,label,reason='')=>({mode,verified,label,reason,runtime:'sandbox-runtime',version:'mock-v2',verifiedAt:verified?'2026-09-13T00:00:00Z':null,profilesSha256:'c'.repeat(64),unverified:['mcp','custom-key']});
test('original bootstrap consumes fragment and remains the only storage/Authorization owner',()=>{
 const s=setup({hash:'#t='+token});assert.equal(s.ctx.yoseaiCredential(),token);assert.deepEqual(s.replacements,['/']);
 assert.equal(s.storage.get('yoseai.credential'),token);assert.equal(s.storage.size,1);
 assert.ok(!source.includes('sessionStorage'));assert.ok(!/headers\.set|new Headers|Bearer /.test(source)); // comments mention concept but no header implementation
 assert.equal(s.media.fetch,undefined);assert.equal(s.media.setCredential,undefined);
});
test('media uses bootstrap fetch and does not add credentials to URL',async()=>{
 const s=setup({saved:token,fetcher:async()=>new Response('image')});
 const a=await s.media.asset('/api/pool/file/a.png');
 assert.match(a,/^blob:/);assert.equal(s.calls[0][1].headers.get('Authorization'),'Bearer '+token);
 assert.ok(!s.calls[0][0].includes(token));assert.equal(s.calls[0][1].redirect,'error');s.media.clear();
});
test('isApi accepts only same-origin API paths; external media remains unchanged',async()=>{
 const s=setup({saved:token});assert.equal(s.media.isApi('http://evil.test/api/state'),false);assert.equal(s.media.isApi('/static.png'),false);
 assert.equal(await s.media.asset('https://example.test/a.png'),'https://example.test/a.png');assert.equal(s.calls.length,0);
});
test('shared media lookup fetches once; reset discards blobs',async()=>{
 const s=setup({saved:token,fetcher:async()=>new Response('image')});
 const [a,b]=await Promise.all([s.media.asset('/api/pool/file/a'),s.media.asset('/api/pool/file/a')]);
 assert.equal(a,b);assert.equal(s.calls.length,1);assert.equal(s.media.urls.size,1);s.media.clear();assert.equal(s.media.urls.size,0);
});
test('late media response cannot survive invalidation',async()=>{
 let finish;const s=setup({saved:token,fetcher:()=>new Promise(r=>finish=r)});
 const p=s.media.asset('/api/pool/file/a');s.media.clear();finish(new Response('x'));
 await assert.rejects(p,/接続状態/);assert.equal(s.media.urls.size,0);
});
test('media 401 opens re-entry, while 403 stays a file retrieval error',async()=>{
 for(const status of [401,403]) {
  const s=setup({saved:token,fetcher:async()=>response(status,{})});let locks=0;s.c.onLock=()=>locks++;
  await assert.rejects(s.media.asset('/api/pool/file/a'),/ファイルを取得/);
  assert.equal(locks,status===401?1:0);assert.equal(s.ctx.yoseaiCredential(),token); // bootstrap ownership preserved
 }
});
test('unauthenticated images wait without requests or sticky failed avatar probes',async()=>{
 const s=setup({fetcher:async()=>new Response('image')});let errors=0;const image={src:'',dispatchEvent(){errors++;}};
 s.media.setSource(image,'/api/pool/file/a');assert.equal(s.calls.length,0);assert.equal(errors,0);
 s.storage.set('yoseai.credential',token);s.media.resume();await new Promise(r=>setImmediate(r));
 assert.match(image.src,/^blob:/);assert.equal(errors,0);assert.equal(s.calls.length,1);s.media.clear();
});
test('changed image source wins out-of-order completion',async()=>{
 const s=setup({saved:token});const pending={};s.media.asset=u=>new Promise(r=>pending[u]=r);const image={src:'',dispatchEvent(){}};
 s.media.setSource(image,'/api/pool/file/old');s.media.setSource(image,'/api/pool/file/new');
 pending['/api/pool/file/new']('blob:new');await Promise.resolve();pending['/api/pool/file/old']('blob:old');await Promise.resolve();assert.equal(image.src,'blob:new');
});
test('server owns all protection labels; only enforced+verified gets success styling',()=>{
 const {c}=setup();
 for(const [mode,verified,label] of [['unprotected',false,'未保護（OS の隔離なし・資格のみ）'],['enforced',false,'隔離あり（未検証）'],['enforced',true,'保護成立（検証済み）※ CLI自身の資格は対象外'],['blocked',true,'実行停止']]){
  c.update(isolation(mode,verified,label));assert.equal(c.status.textContent,label);assert.equal(c.panel.dataset.verified,String(mode==='enforced'&&verified));
 }
});
test('blocked reason visible; unknown keys retained in operating details',()=>{
 const {c}=setup();c.update(isolation('blocked',false,'実行停止','プロファイル不正'));
 assert.match(c.reason.textContent,/実行しません。プロファイル不正/);assert.match(c.meta.textContent,/MCP、custom-key/);
 c.update(null);assert.equal(c.status.textContent,'保護状態: 未取得');assert.equal(c.panel.dataset.verified,'false');
});
test('operating guidance covers bookmark, restart, topic-only writes, excluded CLI credential',()=>{
 const {c}=setup();for(const value of ['ブックマーク','再起動','pool 直下','CLI自身の推論資格','初版の保護対象外','HTMLプレビュー'])assert.ok(c.panel.textContent.includes(value),value);
});
test('re-entry hands fragment to bootstrap via reload; does not write storage or call API',async()=>{
 const s=setup({saved:token});s.c.open();s.c.input.value='http://127.0.0.1:4797/#t='+next;assert.equal(s.calls.length,0);
 await s.c.accept();assert.equal(s.location.reloaded,true);assert.equal(s.location.hash,'#t='+next);
 assert.equal(s.storage.get('yoseai.credential'),token);assert.equal(s.c.input.value,'');assert.equal(s.calls.length,0);
 vm.runInContext(bootstrap,s.ctx);assert.equal(s.ctx.yoseaiCredential(),next);assert.equal(s.location.hash,'');
});
test('invalid input and foreign origin cannot reload or send requests',async()=>{
 for(const input of ['bad','https://evil.test/#t='+token]){
  const s=setup();s.c.input.value=input;await s.c.accept();assert.equal(s.location.reloaded,undefined);assert.equal(s.calls.length,0);assert.equal(s.c.input.value,'');
 }
});
// 端末の案内 URL は localhost 表記のことがある。サーバは Host を 3 表記とも許可するので、資格の受理も揃える
test('同じサーバのループバック別表記は受理し、別ホスト・別ポート・別プロトコルは拒否する',()=>{
 const s=setup(); // 画面は http://127.0.0.1:4797
 assert.equal(s.c.parseCredential('http://localhost:4797/#t='+token),token,'localhost 表記を受理');
 assert.equal(s.c.parseCredential('http://[::1]:4797/#t='+token),token,'[::1] 表記を受理');
 assert.equal(s.c.parseCredential('http://127.0.0.1:4797/#t='+token),token,'同一表記は従来どおり');
 assert.equal(s.c.parseCredential(token),token,'64 桁だけでも従来どおり');
 assert.equal(s.c.parseCredential('http://127.0.0.1:9999/#t='+token),null,'別ポートは拒否');
 assert.equal(s.c.parseCredential('https://localhost:4797/#t='+token),null,'別プロトコルは拒否');
 assert.equal(s.c.parseCredential('http://evil.test:4797/#t='+token),null,'外部ホストは拒否');
});
test('double submit creates only one handoff; closed dialog erases draft',async()=>{
 const s=setup();let navigations=0;s.c.navigate=()=>navigations++;s.c.input.value=token;await s.c.accept();await s.c.accept();assert.equal(navigations,1);
 s.c.input.value=next;s.c.dialog.close();assert.equal(s.c.input.value,'');
});
test('SSE uses original yoseaiOpenEvents; each reconnect gets a new single-use ticket',async()=>{
 let serial=0;const timers=[],states=[];
 const s=setup({saved:token,fetcher:async p=>p==='/api/state'?response(200,{}):response(201,{ticket:'ticket-'+(++serial),expiresAt:Date.now()+10000})});
 let helpers=0;const orig=s.ctx.yoseaiOpenEvents;s.ctx.yoseaiOpenEvents=()=>{helpers++;return orig();};
 const live=new s.A.LiveConnection({onState:x=>states.push(x),later:f=>{timers.push(f);return 1;},cancel(){}});
 await live.start();assert.equal(helpers,1);assert.equal(s.events[0].url,'/api/events?ticket=ticket-1');
 s.events[0].onerror();assert.equal(s.events[0].closed,true);await timers.shift()();assert.equal(helpers,2);assert.equal(s.events[1].url,'/api/events?ticket=ticket-2');live.stop();
});
test('no credential never invokes SSE helper or /api/state',async()=>{
 const s=setup();let locks=0;const live=new s.A.LiveConnection({onState(){},onUnauthorized:()=>locks++});
 await live.start();assert.equal(s.calls.length,0);assert.equal(s.events.length,0);assert.equal(locks,1);
});
test('401 stops polling and requests credential re-entry; 403 is a different failure',async()=>{
 for(const status of [401,403]){
  const s=setup({saved:token,fetcher:async()=>response(status,{})});let locks=0,disconnects=0;const timers=[];
  const live=new s.A.LiveConnection({onState(){},onUnauthorized:()=>locks++,onDisconnect:()=>disconnects++,later:f=>timers.push(f),cancel(){}});
  await live.start();assert.equal(locks,status===401?1:0);assert.equal(disconnects,status===403?1:0);assert.equal(s.events.length,0);assert.equal(timers.length,status===403?1:0);live.stop();
 }
});
test('late SSE open is closed after controller stop',async()=>{
 const s=setup({saved:token});let finish;const live=new s.A.LiveConnection({onState(){},openEvents:()=>new Promise(r=>finish=r)});
 const p=live.start();while(!finish)await new Promise(r=>setImmediate(r));live.stop();const es={close(){this.closed=true;}};finish(es);await p;assert.equal(es.closed,true);
});
test('index keeps bootstrap first, exposes shell before login and routes protected previews',()=>{
 const boot=html.indexOf('window.yoseaiCredential = token'),css=html.indexOf('href="/isolation-ui.css"'),script=html.indexOf('src="/isolation-ui.js"'),onboard=html.indexOf('src="/onboarding-ui.js"');
 assert.ok(boot<css&&css<script&&script<onboard);assert.equal((html.match(/window.fetch = function/g)||[]).length,1);
 assert.ok(!/YoseaiAccess\.fetch|YoseaiAccess\.credential/.test(html));
 assert.match(html,/render\(\); \/\/ Show the normal shell/);assert.ok(!/function render\(\) \{\s*if.*[Cc]redential/.test(html));
 assert.ok(!html.includes('sandbox: "allow-scripts allow-same-origin'));assert.match(html,/data-yoseai-src/);
 for(const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
});
