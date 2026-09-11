import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const ctx=vm.createContext({document:{hidden:false,activeElement:null},requestAnimationFrame:()=>1,cancelAnimationFrame(){},URL,location:{href:'http://localhost/',origin:'http://localhost'}});
vm.runInContext(fs.readFileSync(new URL('../public/avatars.js',import.meta.url),'utf8'),ctx);
const A=ctx.U2AAvatar,plain=x=>JSON.parse(JSON.stringify(x));
const empty={width:600,height:400,rects:[]};
test('existing, new and invalid saved ranges default to home',()=>{
 for(const value of [undefined,null,'','moving','invalid','home'])assert.equal(A.normalizeRange(value),'home');
 assert.equal(A.normalizeRange('free'),'free');
});
test('idle eligibility excludes unavailable state, summary and every outcome phase',()=>{
 assert.equal(A.isIdle({phase:'idle',kind:null}),true);
 for(const s of [{phase:'idle',kind:'summary'},{phase:'idle',reason:'state-unavailable'},...['working','reviewing','waiting','halted','failed','off'].map(phase=>({phase}))])assert.equal(A.isIdle(s),false);
});
test('whole footprint and outline margin must fit; center alone is insufficient',()=>{
 assert.equal(A.fits({x:5,y:5},empty),true);
 assert.equal(A.fits({x:550,y:350},empty),false);
 assert.equal(A.fits({x:20,y:20},{...empty,rects:[{x:65,y:20,width:20,height:20}]}),false);
});
test('overlapping occlusion intervals merge; separate intervals do not add',()=>{
 const a={x:0,y:50},b={x:300,y:50},body={width:0,height:0,margin:0};
 assert.equal(A.hiddenTime(a,b,{rects:[{x:50,y:0,width:100,height:100},{x:100,y:0,width:100,height:100}]},body,50),3);
 assert.ok(Math.abs(A.hiddenTime(a,b,{rects:[{x:50,y:0,width:50,height:100},{x:200,y:0,width:50,height:100}]},body,50)-1)<1e-9);
 assert.deepEqual(plain(A.mergeIntervals([[.1,.3],[.2,.5],[.7,.8]])),[[.1,.5],[.7,.8]]);
});
test('horizontal, vertical and stationary segments handle parallel edges',()=>{
 const r={x:10,y:10,width:20,height:20};
 assert.equal(A.segmentInterval({x:0,y:0},{x:100,y:0},r),null);
 assert.deepEqual(plain(A.segmentInterval({x:20,y:0},{x:20,y:40},r)),[.25,.75]);
 assert.deepEqual(plain(A.segmentInterval({x:20,y:20},{x:20,y:20},r)),[0,1]);
});
test('routes exceeding three seconds of partial occlusion are rejected',()=>{
 const g={...empty,rects:[{x:100,y:0,width:200,height:300}]};
 assert.equal(A.routeAllowed({x:5,y:50},{x:400,y:50},g),false);
 assert.equal(A.routeAllowed({x:5,y:330},{x:400,y:330},g),true);
});
test('candidate search is bounded and falls back when the canvas is blocked',()=>{
 let calls=0;const random=()=>{calls++;return .5;};
 const g={...empty,rects:[{x:0,y:0,width:600,height:400}]};
 assert.equal(A.chooseDestination({x:1,y:1},g,random),null);assert.equal(calls,128);
});
test('grid reports components rather than pretending samples are areas',()=>{
 const g={width:300,height:200,rects:[{x:120,y:0,width:20,height:200}]};
 const r=A.analyzeSpace(g,[{agent:'codex',x:10,y:10}],8);
 assert.equal(r.regions,2);assert.ok(r.freeSamples>2);assert.equal(r.gridStep,8);assert.ok(r.reachability[0].tested<=512);
 assert.equal(r.estimatedTopLeftArea,r.freeSamples*64);
});
test('off-canvas rectangles do not corrupt grid rasterization; sampling is capped',()=>{
 const clean=A.analyzeSpace(empty),outside=A.analyzeSpace({...empty,rects:[{x:-500,y:0,width:20,height:30},{x:900,y:0,width:10,height:20}]});
 assert.equal(clean.freeSamples,outside.freeSamples);
 const huge=A.analyzeSpace({width:1000,height:100000,rects:[]},[],8,1000);
 assert.ok(huge.gridSamples<=1000);assert.ok(huge.gridStep>8);
 assert.throws(()=>A.analyzeSpace({width:NaN,height:100,rects:[]}));
});
test('zoom conversion yields invariant logical rectangles',()=>{
 for(const z of [.5,1,1.5])assert.deepEqual(plain(A.rectInCanvas({left:100+20*z,top:50+30*z,width:40*z,height:60*z},{left:100,top:50},z)),{x:20,y:30,width:40,height:60});
});
test('departure walks the band first, is inaccessible, and home restores the node',()=>{
 const attrs=new Map(),classes=new Set();let parent='home';
 const node={style:{},contains:()=>false,classList:{add:x=>classes.add(x),remove:x=>classes.delete(x)},setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k)};
 const p={node,homePoint:{x:10,y:20},homeBand:{append:n=>{assert.equal(n,node);parent='home';}},spriteNode:{style:{}},homeWidth:52,homeHeight:56,slot:0,slots:1,slotWidth:100,x:0};
 const c=Object.create(A.Controller.prototype);c.layer={append:n=>{assert.equal(n,node);parent='roam';}};
 assert.equal(c.depart(p,{exit:{x:-60,y:20},destination:{x:100,y:200}}),true);
 assert.equal(parent,'home','the band walk starts without reparenting');
 assert.equal(attrs.get('tabindex'),'-1');assert.equal(attrs.get('aria-hidden'),'true');assert.ok(classes.has('is-roaming'));
 assert.equal(p.exiting.targetX,-52,'left exit target clears the full body from the band');
 c.reparent(p);assert.equal(parent,'roam');assert.equal(p.roaming,true);assert.equal(p.rx,-60);assert.equal(p.ry,20);
 c.home(p);assert.equal(parent,'home');assert.equal(attrs.size,0);assert.equal(p.roaming,false);assert.equal(p.exiting,null);
 node.contains=()=>true;assert.equal(c.depart(p,{exit:{x:-60,y:20},destination:{x:100,y:200}}),false);
});
test('state changes and static/reduced-motion return even an offscreen pet immediately',()=>{
 for(const [phase,mode,motion,range] of [['working','moving',false,'free'],['failed','moving',false,'free'],['idle','static',false,'free'],['idle','moving',true,'free'],['idle','moving',false,'home']]){
   const c=Object.create(A.Controller.prototype),p={roaming:true,phase:{phase},visible:false};let homes=0;
   Object.assign(c,{pets:new Map([['a',p]]),range,mode,motion:{matches:motion},active:()=>false,loadSprite(){},paint(){},home(p){homes++;p.roaming=false;}});
   c.sync();assert.equal(homes,1);assert.equal(c.raf,0);
 }
});
test('idle departure waits five accumulated seconds, without resetting on paint',()=>{
 const g={...empty,rects:[{cardKey:'home',x:250,y:150,width:100,height:60}]};
 const c=Object.create(A.Controller.prototype),p={idleMs:4999,homeCardKey:'home',homePoint:{x:260,y:154},node:{contains:()=>false}};let attempts=0;
 Object.assign(c,{geometry:g,pets:new Map([['a',p]]),paint(){},depart(){attempts++;return false;}});
 c.tickFree(p,0);assert.equal(attempts,0);
 p.idleMs=5000;c.tickFree(p,0);assert.equal(attempts,1);
});
test('a pet whose home card is not in the geometry never departs',()=>{
 const c=Object.create(A.Controller.prototype),p={idleMs:9000,homeCardKey:'gone',homePoint:{x:5,y:5},node:{contains:()=>false}};let attempts=0;
 Object.assign(c,{geometry:empty,pets:new Map([['a',p]]),paint(){},depart(){attempts++;return true;}});
 c.tickFree(p,0);assert.equal(attempts,0);assert.equal(p.restMs,5000);
});
test('position updates cap at 30fps and never catch up a hidden-tab time gap',()=>{
 const c=Object.create(A.Controller.prototype),p={idleMs:0};let frames=[];
 Object.assign(c,{clock:100,range:'free',pets:new Map([['a',p]]),needsTick:()=>true,tickFree:(p,dt)=>frames.push(dt)});
 c.tick(116);assert.equal(frames.length,0);
 c.tick(134);assert.deepEqual(frames,[34]);
 c.tick(10000);assert.deepEqual(frames,[34,100],'a long gap advances one capped step, never the whole gap');assert.equal(p.idleMs,134);
});
test('no exemption exists: routes start visible at band exits beside the card',()=>{
 const home={x:10,y:10},target={x:500,y:10};
 const g={width:1000,height:500,rects:[{cardKey:'home',x:0,y:0,width:400,height:200}]};
 assert.equal(A.routeAllowed(home,target,g),false,'a route from deep inside home exceeds 3s hidden');
 const exits=A.exitPoints(g.rects[0],10);
 assert.ok(exits[0].x<0,'the left exit falls off this canvas');
 assert.equal(A.fits(exits[1],g),true,'the right exit clears the inflated home rectangle');
 assert.equal(A.routeAllowed(exits[1],target,g),true,'from the card edge the same target is reachable');
 assert.equal(A.hiddenTime(exits[1],target,g),0,'the exit route starts fully visible');
 const plan=A.chooseExit(g.rects[0],10,g,()=>0.9);
 assert.ok(plan && plan.exit.x>400,'chooseExit only proposes exits that fit');
 assert.equal(A.fits(plan.destination,g),true,'destinations never sit on a card');
 const blocked={...g,rects:[{cardKey:'home',x:0,y:0,width:1000,height:200}]};
 assert.equal(A.chooseExit(blocked.rects[0],10,blocked),null,'a full-width card leaves no exit');
});
test('after the band exit the home card consumes the ordinary budget',()=>{
 const g={width:1000,height:500,rects:[{cardKey:'home',x:0,y:0,width:400,height:200}]};
 const c=Object.create(A.Controller.prototype);let returned=0;
 const p={idleMs:5000,homePoint:{x:10,y:6},homeCardKey:'home',roaming:true,rx:500,ry:10,destination:{x:10,y:10},node:{contains:()=>false,style:{}},hiddenMs:0};
 Object.assign(c,{geometry:g,pets:new Map([['a',p]]),paint(){},home(){returned++;p.destination=null;p.roaming=false;}});
 let ticks=0;while(!returned && ticks++<400)c.tickFree(p,34);
 assert.equal(returned,1,'crossing back deep into the home card exceeds 3s and forces a return');
 assert.ok(p.rx>200,'the pet was sent home mid-crossing, not after finishing it');
});
test('home restores the saved band offset and clamps it only if the band shrank',()=>{
 for(const [limit,expected] of [[100,23],[7,7]]){
   const c=Object.create(A.Controller.prototype),node={style:{},contains:()=>false,classList:{add(){},remove(){}},setAttribute(){},removeAttribute(){}};
   const p={node,homePoint:{x:123,y:10},homeCardKey:'home',homeBand:{append(){}},spriteNode:{style:{}},homeWidth:52,homeHeight:56,slot:1,slots:2,slotWidth:100,x:23,limit:100};
   c.layer={append(){}};c.depart(p,{exit:{x:500,y:10},destination:{x:500,y:100}});c.reparent(p);p.limit=limit;c.home(p);
   assert.equal(p.x,expected);assert.equal(node.style.transform,`translateX(${expected}px)`);assert.equal(node.style.left,'100px');
 }
});
test('DOM geometry keeps card identity; reachability starts at band exits',()=>{
 const make=(isCard,left)=>({closest:()=>null,getClientRects:()=>[1],getBoundingClientRect:()=>({left,top:0,width:400,height:200}),matches:()=>isCard,dataset:{key:'home'}});
 const canvas={clientWidth:1000,clientHeight:500,getBoundingClientRect:()=>({left:0,top:0}),querySelectorAll:()=>[make(true,0),make(false,900)]};
 const g=A.snapshotFlow(canvas);assert.equal(g.rects[0].cardKey,'home');assert.equal(g.rects[1].cardKey,null);
 const base={...g,rects:[g.rects[0]]};
 const noKey=A.analyzeSpace(base,[{agent:'codex',x:10,y:10}]);
 const keyed=A.analyzeSpace(base,[{agent:'codex',homeCardKey:'home',x:10,y:10}]);
 assert.equal(keyed.reachability[0].exits,1,'only the right-hand exit fits beside a card on the canvas edge');
 assert.ok(keyed.reachability[0].reachable>noKey.reachability[0].reachable,'band exits reach more than a start deep inside the card');
 assert.equal(keyed.freeSamples,noKey.freeSamples,'free-space count still excludes the home card');
});
