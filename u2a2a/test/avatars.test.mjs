import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const code = fs.readFileSync(new URL('../public/avatars.js', import.meta.url), 'utf8');
const ctx = vm.createContext({document:{hidden:false}, URL, location:{href:'http://localhost/',origin:'http://localhost'}, requestAnimationFrame:()=>1,cancelAnimationFrame:()=>{}});
vm.runInContext(code,ctx);
const A=ctx.U2AAvatar;
const plain=x=>JSON.parse(JSON.stringify(x));
test('resolved byTopic wins; raw runs and outcomes are not reinterpreted',()=>{
 const entry={global:{phase:'waiting',reason:'unauthed'},byTopic:{one:{phase:'halted',reason:'stopped-unknown',source:'outcome'},two:{phase:'working',kind:'thread',source:'run'}},runs:[{topicId:null,phase:'reviewing'},{topicId:'three',phase:'working'}],outcomes:[{topicId:'three',phase:'failed'}]};
 assert.equal(A.selectState(entry,'one').reason,'stopped-unknown');
 assert.equal(A.selectState(entry,'two').kind,'thread');
 assert.equal(A.selectState(entry,'three').reason,'unauthed');
 assert.equal(A.selectState(entry,'three').source,'global');
 assert.equal(A.selectState(null,'one').reason,'state-unavailable');
});
test('server-selected run or global priority is preserved including hidden outcome',()=>{
 const view={phase:'working',kind:'thread',source:'run',outcomeId:'o1',runCount:2};
 const entry={global:{phase:'off'},byTopic:{a:view,b:{phase:'off',source:'global',outcomeId:'o2'}}};
 assert.equal(A.selectState(entry,'a'),view);
 assert.equal(A.selectState(entry,'b').phase,'off');
 assert.equal(A.selectState(entry,'b').outcomeId,'o2');
 assert.equal(A.selectState(entry,'unknown').outcomeId,null);
});
test('all semantic phases and summary choose the agreed row',()=>{
 for(const [phase,row] of Object.entries({idle:'idle',working:'running',reviewing:'review',waiting:'waiting',halted:'waiting',failed:'failed',off:'idle'}))assert.equal(A.stateRow({phase}),row);
 assert.equal(A.stateRow({phase:'working',kind:'summary'}),'idle');
});
test('look direction wraps clockwise with neutral deadzone',()=>{
 assert.equal(A.direction(1,1),null);
 for(const [x,y,row,col] of [[0,-100,9,0],[100,0,9,4],[0,100,10,0],[-100,0,10,4],[-1,-100,9,0]])assert.deepEqual(plain(A.direction(x,y)),{row,col});
});
test('nonuniform keyframes keep the final frame through the loop boundary',()=>{
 const css=A.keyframes('idle',{row:0,durations:[280,110,110,140,140,320]});
 assert.match(css,/25\.454545454545453%\{background-position:-192px/);
 assert.match(css,/70\.9090909090909%\{background-position:-960px/);
 assert.match(css,/100%\{background-position:0px 0px\}/);
 assert.doesNotMatch(css,/-1152px/,'neutral column 6 must not animate');
});
test('latest home never migrates to an older visible message',()=>{
 const homes=A.latestHomes([{id:'old',author:'grok',topicId:'a',ts:1},{id:'new',author:'grok',topicId:'a',ts:2},{id:'other',author:'grok',topicId:'b',ts:3}], 'a',{old:'old-card'});
 assert.equal(homes.has('grok'),true);assert.equal(homes.get('grok'),undefined);
});
test('invalid atlas metadata and durations are rejected',()=>{
 assert.throws(()=>A.validateFormat({spriteVersionNumber:1}));
 const names=['idle','running-right','running-left','waving','jumping','failed','waiting','running','review'];
 const f={spriteVersionNumber:2,atlas:{width:1536,height:2288,columns:8,rows:11,cellWidth:192,cellHeight:208},animations:names.map((name,row)=>({name,row,frames:[6,8,8,4,5,8,6,6,6][row],durationsMs:Array([6,8,8,4,5,8,6,6,6][row]).fill(120)})),look:{rows:[9,10],framesPerRow:8,stepDeg:22.5,zeroDeg:'up',clockwise:true}};
 assert.equal(A.validateFormat(f).animations.idle.row,0);f.animations[0].durationsMs[0]=0;assert.throws(()=>A.validateFormat(f));
 f.animations[0].durationsMs[0]=120;f.look.zeroDeg='right';assert.throws(()=>A.validateFormat(f));
});
test('pause gate covers view, setting, reduced motion and viewport',()=>{
 // document.hidden は見ない契約（埋め込みブラウザは表示中でも hidden を報告する。省エネは rAF 節流と IntersectionObserver）
 const c=Object.create(A.Controller.prototype);c.context={view:'flow'};c.mode='moving';c.motion={matches:false};
 const p={visible:true,node:{isConnected:true},phase:{phase:'idle'}};
 assert.equal(c.active(p),true);
 const before=ctx.document.hidden;ctx.document.hidden=true;assert.equal(c.active(p),true,'hidden でも active（埋め込みペイン対応）');ctx.document.hidden=before;
 for(const [obj,key,value] of [[c.context,'view','columns'],[c,'mode','static'],[c,'mode','hidden'],[c.motion,'matches',true],[p,'visible',false],[p.node,'isConnected',false],[p.phase,'phase','off']]){const b2=obj[key];obj[key]=value;assert.equal(c.active(p),false,key);obj[key]=b2;}
});
test('hidden and static rendering uses placeholder and pauses CSS',()=>{
 const c=Object.create(A.Controller.prototype);c.context={view:'flow'};c.mode='static';c.motion={matches:false};
 const p={phase:{phase:'working'},visible:true,loaded:true,node:{isConnected:true,classList:{toggle(){}}},spriteNode:{style:{}},still:{style:{}},fallback:{style:{}}};
 c.paint(p);assert.equal(p.spriteNode.hidden,true);assert.equal(p.spriteNode.style.animationPlayState,'paused');assert.equal(p.still.style.visibility,'');
});
test('state poses exclude gaze; idle gaze excludes CSS loop',()=>{
 const c=Object.create(A.Controller.prototype);c.context={view:'flow'};c.mode='moving';c.motion={matches:false};c.format={animations:{running:{row:7,durations:[120,220]},idle:{row:0,durations:[280,320]}}};
 const p={phase:{phase:'working'},visible:true,loaded:true,cell:{row:9,col:4},node:{isConnected:true,classList:{toggle(){}}},spriteNode:{style:{}},still:{style:{}},fallback:{style:{}}};
 c.paint(p);assert.match(p.spriteNode.style.animation,/u2pet-running/);
 p.phase={phase:'idle'};c.paint(p);assert.equal(p.spriteNode.style.animation,'none');assert.equal(p.spriteNode.style.backgroundPosition,'-768px -1872px');
});
test('three pets share a narrow band without overlapping; scale is proportional',()=>{
 const c=Object.create(A.Controller.prototype);c.context={};c.pets=new Map();
 const band={clientWidth:90};
 for(let i=0;i<3;i++)c.pets.set(String(i),{slot:i,slots:3,x:999,node:{parentElement:band,style:{}},spriteNode:{style:{}}});
 c.measure();
 for(const p of c.pets.values()){
   const width=parseFloat(p.node.style.width),height=parseFloat(p.node.style.height);
   assert.ok(width<=30);assert.ok(p.x<=p.limit);assert.ok(Math.abs(width/height-192/208)<1e-9);
   assert.equal(parseFloat(p.node.style.left),p.slot*30);
 }
});
test('static or unavailable format does not request a spritesheet',()=>{
 const c=Object.create(A.Controller.prototype);c.context={view:'flow'};c.motion={matches:false};c.mode='static';c.format={};
 const p={phase:{phase:'idle'},visible:true,node:{isConnected:true},sprite:'http://localhost/sprite'};
 // Image is deliberately absent in this VM: construction would fail the test.
 c.loadSprite(p);c.mode='moving';c.format=null;c.loadSprite(p);
});
test('formal manifest endpoint embeds format; no extra format request',async()=>{
 const names=['idle','running-right','running-left','waving','jumping','failed','waiting','running','review'];
 const format={spriteVersionNumber:2,atlas:{width:1536,height:2288,columns:8,rows:11,cellWidth:192,cellHeight:208},animations:names.map((name,row)=>({name,row,frames:[6,8,8,4,5,8,6,6,6][row],durationsMs:Array([6,8,8,4,5,8,6,6,6][row]).fill(120)})),look:{rows:[9,10],framesPerRow:8,stepDeg:22.5,zeroDeg:'up',clockwise:true}};
 const calls=[];ctx.fetch=async(url,options)=>{calls.push([url,options.cache]);return {ok:true,json:async()=>({version:1,format,agents:{}})};};
 ctx.document.createElement=()=>({textContent:''});ctx.document.head={append(){}};
 const c=Object.create(A.Controller.prototype);Object.assign(c,{loading:null,retryAt:0,pets:new Map(),sync(){}});
 await c.load();assert.deepEqual(calls,[['/api/avatars','no-cache']]);assert.equal(c.format.animations.review.row,8);assert.ok(c.sheet.textContent.includes('u2pet-running-right'));
});
test('stale image triggers manifest refresh only once per failed URL',()=>{
 const c=Object.create(A.Controller.prototype);let requests=0;c.staleURLs=new Set();c.load=()=>requests++;
 c.refreshStale('/old.webp');c.refreshStale('/old.webp');c.refreshStale('/new.webp');assert.equal(requests,2);
});
