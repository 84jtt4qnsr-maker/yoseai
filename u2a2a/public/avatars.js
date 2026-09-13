/* SPEC-アバター状態 v1 adapter. No server state inference. */
(() => {
  'use strict';
  const source = (node, url) => globalThis.YoseaiAccess ? globalThis.YoseaiAccess.setSource(node,url) : (node.src=url);
  const IDS = ['claude', 'codex', 'grok'];
  const LETTER = { claude: 'C', codex: 'X', grok: 'G' };
  const TITLE = { idle:'待機', working:'作業中', reviewing:'レビュー中', waiting:'入力待ち', halted:'停止中', failed:'エラー', off:'自動応答OFF' };
  const DISPLAY = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok' };
  const REASON = { budget:'上限による停止', 'stopped-unknown':'停止（理由未確認）', unauthed:'ログインが必要', 'state-unavailable':'状態情報未接続', 'auto-off':'自動応答オフ', cancelled:'キャンセル', error:'エラー', history:'履歴保存の失敗', 'project-blocked':'対象プロジェクト不可' };
  const ART = '/api/pool/file/avatars/'; // 肖像・スプライトは avatars/<agent>/ 配下（トピック非依存）
  const PORTRAITS = { claude: ['claude/portrait.png','claude/portrait.png'], codex: ['codex/portrait.png','codex/portrait.png'], grok: ['grok/portrait.jpg','grok/portrait.jpg'] }; // avatars/<agent>/ 配下（トピック非依存）
  const known = agent => IDS.includes(agent);
  const safeURL = value => {
    if (typeof value !== 'string') return null;
    try { const u = new URL(value, location.href); return u.origin === location.origin && /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; }
  };
  // Server resolves run ordering, global priority and terminal outcomes.
  function selectState(entry, topicId) {
    if (!entry?.global) return { phase:'idle', reason:'state-unavailable' };
    return entry.byTopic?.[topicId] ?? { ...entry.global, source:'global', kind:null, runId:null, runCount:0, outcomeId:null };
  }
  function stateRow(s) {
    if (s.kind === 'summary') return 'idle';
    return ({working:'running',reviewing:'review',waiting:'waiting',halted:'waiting',failed:'failed'})[s.phase] || 'idle';
  }
  function direction(dx, dy) {
    if (Math.hypot(dx,dy) < 8) return null;
    const n = Math.round((Math.atan2(dx,-dy) * 180 / Math.PI + 360) % 360 / 22.5) % 16;
    return {row:9 + Math.floor(n/8), col:n%8};
  }
  function validateFormat(f) {
    const atlas=f?.atlas;
    if (!f || f.spriteVersionNumber !== 2 || atlas?.width!==1536 || atlas?.height!==2288 || atlas?.columns!==8 || atlas?.rows!==11 || atlas?.cellWidth!==192 || atlas?.cellHeight!==208) throw Error('Unsupported avatar format');
    const names = ['idle','running-right','running-left','waving','jumping','failed','waiting','running','review'];
    const counts = [6,8,8,4,5,8,6,6,6];
    if(!Array.isArray(f.animations) || f.animations.length!==9)throw Error('Invalid animations');
    const animations={};
    names.forEach((name, row) => {
      const a=f.animations.find(a=>a.name===name);
      if(a?.row!==row || a.frames!==counts[row] || a.durationsMs?.length!==counts[row] || !a.durationsMs.every(d=>Number.isFinite(d) && d>0))throw Error('Invalid animation: '+name);
      animations[name]={row,durations:a.durationsMs};
    });
    const look=f.look;
    if(look?.rows?.length!==2 || look.rows[0]!==9 || look.rows[1]!==10 || look.framesPerRow!==8 || look.stepDeg!==22.5 || look.zeroDeg!=='up' || look.clockwise!==true)throw Error('Invalid look directions');
    return {atlas,animations,look};
  }
  function keyframes(name, a) {
    const total = a.durations.reduce((x,y)=>x+y,0); let elapsed=0;
    const stops = a.durations.map((duration,col)=> {
      const text = `${elapsed / total * 100}%{background-position:${-col*192}px ${-a.row*208}px}`;
      elapsed += duration; return text;
    });
    return `@keyframes u2pet-${name}{${stops.join('')}100%{background-position:0px ${-a.row*208}px}}`;
  }
  // One probe per agent per page. A failed probe is sticky until reload, so
  // repeated flow renders and pet recreation cannot issue more missing-image requests.
  const portraitCache = new Map();
  function loadPortrait(agent, ready) {
    let entry = portraitCache.get(agent);
    if (entry) {
      if (entry.status === 'loading') entry.waiters.push(ready);
      else ready(entry);
      return;
    }
    entry = {status:'loading', image:null, waiters:[ready]};
    portraitCache.set(agent, entry);
    const img = new Image(); entry.image=img; img.alt='';
    const settle = status => {
      if (entry.status !== 'loading') return;
      entry.status=status;
      const waiters=entry.waiters; entry.waiters=[];
      for (const notify of waiters) notify(entry);
      if (status === 'failed') entry.image=null;
    };
    img.onload=()=>settle('loaded'); img.onerror=()=>settle('failed');
    source(img,ART+encodeURIComponent(PORTRAITS[agent][0]));
  }
  function enablePortraitLink(node, agent) {
    node.href=ART+encodeURIComponent(PORTRAITS[agent][1]);
    node.target='_blank'; node.rel='noopener';
  }
  function petTitle(p) {
    const phase=p.phase;
    p.node.title=(DISPLAY[p.agent] || p.agent)+' · '+(REASON[phase.reason] || TITLE[phase.phase] || '待機')+
      (phase.kind==='summary'?'（要約中）':'')+
      (phase.outcomeId && phase.source!=='outcome'?' · 未確認の終了状態あり':'')+
      (p.portraitLoaded?' — 自画像を見る':'');
    p.node.setAttribute('aria-label',p.node.title);
  }
  function badge(agent, portrait = false) {
    const node = document.createElement(portrait ? 'a' : 'span');
    node.className = 'agent-avatar ' + (portrait ? 'agent-avatar-face' : 'agent-avatar-letter');
    node.style.setProperty('--avatar-color', known(agent) ? `var(--${agent})` : 'var(--dim)');
    node.textContent = LETTER[agent] || String(agent || '?').slice(0,1);
    node.setAttribute('aria-label', DISPLAY[agent] || agent || 'エージェント');
    if (portrait && known(agent)) {
      loadPortrait(agent, entry => {
        if (entry.status !== 'loaded') {
          node.setAttribute('aria-label',(DISPLAY[agent] || agent)+'（画像なし）');
          return;
        }
        const img=entry.image.cloneNode(false); img.alt='';
        node.append(img); enablePortraitLink(node,agent);
        node.title=(DISPLAY[agent] || agent)+' の自画像を見る'; node.setAttribute('aria-label',node.title);
      });
    }
    return node;
  }
  function latestHomes(messages, topicId, membership) {
    const result = new Map();
    for (const m of messages || []) {
      const pv = m.provenance || {};
      const isCopy = !!pv.source || pv.delivery === 'qa-relay' || pv.delivery === 'relay' || pv.delivery === 'handoff';
      if (m.topicId !== topicId || !known(m.author) || isCopy) continue; // 配送コピーは flow 側の isRelayCopy と同条件で除外
      // Native messages win ties against delivery copies; retain the original membership key.
      const old = result.get(m.author);
      if (!old || m.ts > old.ts || (m.ts === old.ts && m.thread === m.author)) result.set(m.author,m);
    }
    return new Map([...result].map(([agent,m])=>[agent,membership[m.id]]));
  }
  // All geometry uses logical canvas pixels; points denote sprite top-left.
  const ROAM = Object.freeze({width:56*192/208,height:56,margin:2,speed:50,hiddenSeconds:3,idleMs:5000,maxCandidates:64});
  const PROTECTED = '.flow-card, .flow-detail, .flow-episode-toggle, .flow-branch, #flow-warnings, #flow-empty';
  function inflated(rect, body=ROAM) {
    const m=body.margin??2;
    return {x:rect.x-body.width-m,y:rect.y-body.height-m,width:rect.width+body.width+2*m,height:rect.height+body.height+2*m};
  }
  function inside(p,r){return p.x>=r.x && p.y>=r.y && p.x<=r.x+r.width && p.y<=r.y+r.height;}
  function withinCanvas(p,g,body=ROAM){const m=body.margin??2;return p.x>=m && p.y>=m && p.x+body.width+m<=g.width && p.y+body.height+m<=g.height;}
  function fits(p,g,body=ROAM){return withinCanvas(p,g,body) && !g.rects.some(r=>inside(p,inflated(r,body)));}
  // Slab intersection of a segment and an expanded rectangle, including endpoints.
  function segmentInterval(a,b,r){
    let lo=0,hi=1;
    for(const [axis,size] of [['x','width'],['y','height']]){
      const d=b[axis]-a[axis],min=r[axis],max=min+r[size];
      if(Math.abs(d)<1e-10){if(a[axis]<min || a[axis]>max)return null;continue;}
      let t0=(min-a[axis])/d,t1=(max-a[axis])/d;if(t0>t1)[t0,t1]=[t1,t0];
      lo=Math.max(lo,t0);hi=Math.min(hi,t1);if(lo>hi)return null;
    }
    return [lo,hi];
  }
  function mergeIntervals(intervals){
    const out=[];
    for(const pair of intervals.filter(Boolean).sort((a,b)=>a[0]-b[0])){
      const last=out[out.length-1];if(last && pair[0]<=last[1]+1e-9)last[1]=Math.max(last[1],pair[1]);else out.push([...pair]);
    }
    return out;
  }
  // The budget has no exemptions: the home card counts like any other card.
  // Departure avoids it by walking the band to the card edge before entering
  // the roam layer, so routes never start deep inside a protected rectangle.
  function hiddenTime(a,b,g,body=ROAM,speed=ROAM.speed){
    if(!(speed>0))return Infinity;
    const duration=Math.hypot(b.x-a.x,b.y-a.y)/speed;
    return mergeIntervals(g.rects.map(r=>segmentInterval(a,b,inflated(r,body)))).reduce((max,[lo,hi])=>Math.max(max,(hi-lo)*duration),0);
  }
  function routeAllowed(a,b,g,body=ROAM){return fits(b,g,body) && hiddenTime(a,b,g,body)<=ROAM.hiddenSeconds+1e-9;}
  function chooseDestination(a,g,random=Math.random,occupied=[]){
    const m=ROAM.margin,w=g.width-ROAM.width-2*m,h=g.height-ROAM.height-2*m;
    if(w<=0 || h<=0)return null;
    for(let i=0;i<ROAM.maxCandidates;i++){
      const p=i%2 ? {x:m+random()*w,y:m+random()*h} : {x:Math.max(m,Math.min(m+w,a.x+(random()-.5)*600)),y:Math.max(m,Math.min(m+h,a.y+(random()-.5)*600))};
      if(Math.hypot(p.x-a.x,p.y-a.y)<24 || occupied.some(q=>Math.abs(p.x-q.x)<ROAM.width+4 && Math.abs(p.y-q.y)<ROAM.height+4))continue;
      if(routeAllowed(a,p,g))return p;
    }
    return null;
  }
  // Exit candidates sit just outside the inflated home rectangle, level with
  // the band (grok 代替案B). A neighbouring card may overlap an exit; the
  // ordinary 3s budget then bounds that crossing via routeAllowed.
  function exitPoints(rect,y,body=ROAM){
    const gap=(body.margin??2)+1;
    return [{x:rect.x-body.width-gap,y},{x:rect.x+rect.width+gap,y}];
  }
  function chooseExit(rect,y,g,random=Math.random,occupied=[]){
    const exits=exitPoints(rect,y).filter(p=>withinCanvas(p,g));
    if(exits.length>1 && random()<0.5)exits.reverse();
    for(const exit of exits){
      const destination=chooseDestination(exit,g,random,occupied);
      if(destination)return {exit,destination};
    }
    return null;
  }
  function isIdle(s){return s?.phase==='idle' && !s.kind && s.reason!=='state-unavailable';}
  function normalizeRange(value){return value==='free'?'free':'home';}
  function rectInCanvas(rect,canvasRect,zoom){return {x:(rect.left-canvasRect.left)/zoom,y:(rect.top-canvasRect.top)/zoom,width:rect.width/zoom,height:rect.height/zoom};}
  function snapshotFlow(canvas, zoom=1){
    const origin=canvas.getBoundingClientRect();
    const rects=[...canvas.querySelectorAll(PROTECTED)].filter(n=>!n.closest('[hidden]') && n.getClientRects().length).map(n=>({...rectInCanvas(n.getBoundingClientRect(),origin,zoom),cardKey:n.matches('.flow-card') ? n.dataset.key : null})).filter(r=>r.width>0 && r.height>0);
    return {width:canvas.clientWidth,height:canvas.clientHeight,zoom,rects};
  }
  // Offline/report-only raster analysis. Production motion does not build this grid.
  function analyzeSpace(g,homes=[],requestedStep=8,maxCells=50000){
    if(!Number.isFinite(g.width)||!Number.isFinite(g.height)||g.width<=0||g.height<=0||!Array.isArray(g.rects)||g.rects.some(r=>!['x','y','width','height'].every(k=>Number.isFinite(r[k]))||r.width<0||r.height<0))throw Error('Invalid geometry');
    maxCells=Math.max(1,Math.floor(Number(maxCells)||50000));
    let step=Number.isFinite(requestedStep)&&requestedStep>0?requestedStep:8,cols=0,rows=0;
    const dims=()=>{cols=Math.max(0,Math.floor((g.width-ROAM.width-2*ROAM.margin)/step)+1);rows=Math.max(0,Math.floor((g.height-ROAM.height-2*ROAM.margin)/step)+1);};
    dims();while(cols*rows>maxCells){step*=2;dims();}
    const free=new Uint8Array(cols*rows);free.fill(1);
    // Rasterize rectangles once, instead of checking every sample against every card.
    for(const source of g.rects){const r=inflated(source),m=ROAM.margin;
      const x0=Math.max(0,Math.ceil((r.x-m)/step)),x1=Math.min(cols-1,Math.floor((r.x+r.width-m)/step));
      const y0=Math.max(0,Math.ceil((r.y-m)/step)),y1=Math.min(rows-1,Math.floor((r.y+r.height-m)/step));
      if(x0>x1||y0>y1)continue;
      for(let y=y0;y<=y1;y++)free.fill(0,y*cols+x0,y*cols+x1+1);
    }
    const point=i=>({x:ROAM.margin+(i%cols)*step,y:ROAM.margin+Math.floor(i/cols)*step});
    const seen=new Uint8Array(free.length),regions=[];let samples=0;
    for(let i=0;i<free.length;i++)if(free[i])samples++;
    for(let i=0;i<free.length;i++)if(free[i]&&!seen[i]){
      const queue=[i];seen[i]=1;let count=0;
      for(let q=0;q<queue.length;q++){const n=queue[q];count++;
        for(const k of [n%cols?n-1:-1,n%cols<cols-1?n+1:-1,n-cols,n+cols])if(k>=0&&k<free.length&&free[k]&&!seen[k]){seen[k]=1;queue.push(k);}
      }
      regions.push({samples:count,representative:point(i)});
    }
    // Reachability is bounded and explicitly reported as a sample, not a total.
    const candidates=[];const stride=Math.max(1,Math.ceil(samples/512));let ordinal=0;
    for(let i=0;i<free.length;i++)if(free[i] && ordinal++%stride===0)candidates.push(point(i));
    const reachability=homes.map(home=>{
      const rect=g.rects.find(r=>r.cardKey && r.cardKey===home.homeCardKey);
      const starts=rect ? exitPoints(rect,home.y).filter(p=>withinCanvas(p,g)) : [home];
      return {agent:home.agent,tested:candidates.length,exits:rect?starts.length:null,reachable:candidates.filter(p=>starts.some(s=>routeAllowed(s,p,g))).length};
    });
    return {width:g.width,height:g.height,zoom:g.zoom??1,footprint:{width:ROAM.width,height:ROAM.height,margin:ROAM.margin},gridStep:step,gridSamples:free.length,freeSamples:samples,regions:regions.length,regionSizes:regions.map(r=>r.samples),estimatedTopLeftArea:samples*step*step,reachability,speed:ROAM.speed,maxHiddenSeconds:ROAM.hiddenSeconds,notes:'4-neighbour grid components; area estimates sprite-top-left placement space, not floor area. Reachability starts from band-exit points beside the home card and samples at most 512 destinations per home; zero is not proof of impossibility.'};
  }

  class Controller {
    constructor({zone, controls, changed}) {
      this.zone=zone; this.changed=changed; this.pets=new Map(); this.context=null; this.assets=null; this.format=null; this.loading=null; this.retryAt=0; this.refreshAt=0; this.staleURLs=new Set(); this.clock=0; this.raf=0;
      this.canvas=zone.querySelector('#flow-canvas');this.layer=this.canvas.querySelector('#flow-roam');this.layoutNodes=new Set();this.geometry=null;this.measureRaf=0;
      this.motion=matchMedia('(prefers-reduced-motion: reduce)');
      try { this.mode=localStorage.getItem('u2a2a-avatar-mode') || 'moving'; } catch { this.mode='moving'; }
      if (!['moving','static','hidden'].includes(this.mode)) this.mode='moving';
      const label=document.createElement('label'); label.className='avatar-setting'; label.append('ペット ');
      this.select=document.createElement('select'); this.select.setAttribute('aria-label','ペットの表示');
      for(const [value,text] of [['moving','動く'],['static','静止'],['hidden','非表示']]) {const o=document.createElement('option'); o.value=value;o.textContent=text;this.select.append(o);}
      this.select.value=this.mode; label.append(this.select); label.classList.add('pet-mode-setting'); controls.append(label);
      this.select.onchange=()=>{this.mode=this.select.value;try{localStorage.setItem('u2a2a-avatar-mode',this.mode);}catch{}this.sync();this.changed();};
      try{this.range=normalizeRange(localStorage.getItem('u2a2a-avatar-range'));}catch{this.range='home';}
      const rangeLabel=document.createElement('label');rangeLabel.className='avatar-setting pet-mode-setting';rangeLabel.append('歩行範囲 ');
      this.rangeSelect=document.createElement('select');this.rangeSelect.setAttribute('aria-label','ペットの歩行範囲');
      for(const [value,text] of [['home','ホーム'],['free','自由']]){const o=document.createElement('option');o.value=value;o.textContent=text;this.rangeSelect.append(o);}
      this.rangeSelect.value=this.range;rangeLabel.append(this.rangeSelect);controls.append(rangeLabel);
      this.rangeSelect.onchange=()=>{this.range=normalizeRange(this.rangeSelect.value);try{localStorage.setItem('u2a2a-avatar-range',this.range);}catch{}for(const p of this.pets.values()){this.home(p);p.idleMs=0;p.restMs=0;}this.changed();};
      const measure=document.createElement('button');measure.type='button';measure.className='small pet-mode-setting';measure.textContent='空きを計測';measure.title='現在のフローの配置可能領域をJSONで保存';
      measure.onclick=()=>{const report=this.report(),url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='avatar-space-'+this.context.topicId+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};controls.append(measure);
      this.motion.addEventListener('change',()=>this.sync());
      document.addEventListener('visibilitychange',()=>this.sync());
      this.io=new IntersectionObserver(entries=>{for(const e of entries){const p=[...this.pets.values()].find(p=>p.node===e.target);if(p)p.visible=e.isIntersecting;}this.sync();},{root:zone});
      this.resize=new ResizeObserver(()=>this.scheduleMeasure());this.resize.observe(this.canvas);
      zone.addEventListener('scroll',()=>this.scheduleMeasure(),{passive:true});
      window.addEventListener('resize',()=>this.scheduleMeasure());
    }
    async load() {
      if(this.loading || Date.now()<this.retryAt) return;
      this.loading=(async()=>{
        // Manifest contains the shared v2 format and versioned image URLs.
        const response=await fetch('/api/avatars',{cache:'no-cache'});
        if(!response.ok)throw Error('avatar manifest unavailable');
        const manifest=await response.json();if(manifest.version!==1)throw Error('Unsupported manifest version');
        this.format=null;this.assets=manifest.agents || {};for(const p of this.pets.values())this.setAsset(p);
        this.format=validateFormat(manifest.format);this.assets=manifest.agents || {};this.refreshAt=Date.now()+60000;
        this.sheet?.remove(); this.sheet=document.createElement('style');
        this.sheet.textContent=['idle','running-right','running-left','waving','jumping','failed','waiting','running','review'].map(name=>keyframes(name,this.format.animations[name])).join('\n');document.head.append(this.sheet);
        for(const p of this.pets.values())this.setAsset(p);
      })().catch(()=>{this.retryAt=Date.now()+30000;}).finally(()=>{this.loading=null;this.sync();});
      return this.loading;
    }
    setAsset(p) {
      const asset=this.assets?.[p.agent];
      if(!asset){p.sprite=null;p.loaded=false;p.failed=false;p.image=null;p.placeholder=null;p.still.removeAttribute('src');p.still.hidden=true;p.fallback.hidden=false;return;}
      const placeholder=safeURL(asset.still?.url), sprite=asset.spriteVersionNumber===2 ? safeURL(asset.sprite?.url) : null;
      if(!placeholder){p.placeholder=null;p.still.removeAttribute('src');p.still.hidden=true;p.fallback.hidden=false;}
      if(placeholder && p.placeholder!==placeholder){p.placeholder=placeholder;source(p.still,placeholder);}
      if(sprite!==p.sprite){p.sprite=sprite;p.loaded=false;p.failed=false;p.image=null;p.spriteNode.hidden=true;}
      this.loadSprite(p);
    }
    refreshStale(url) {
      if(!url || this.staleURLs.has(url))return;
      this.staleURLs.add(url);if(this.staleURLs.size>30)this.staleURLs.delete(this.staleURLs.values().next().value);
      this.load();
    }
    loadSprite(p) {
      if(!this.format || !this.active(p) || !p.sprite || p.loaded || p.image || p.failed)return;
      const url=p.sprite,img=new Image();p.image=img;
      img.onload=async()=>{try {await img.decode();}catch{} if(p.sprite!==url)return;
        if(img.naturalWidth!==1536 || img.naturalHeight!==2288){p.failed=true;return;}
        p.loaded=true;p.spriteNode.style.backgroundImage=`url(${JSON.stringify(img.src)})`;this.sync();};
      img.onerror=()=>{if(p.sprite===url){p.failed=true;p.image=null;this.refreshStale(url);}};source(img,url);
    }
    create(agent) {
      const node=document.createElement('a');node.className='flow-pet';node.style.setProperty('--avatar-color',`var(--${agent})`);
      const fallback=badge(agent);fallback.classList.add('pet-fallback');
      const still=new Image();still.alt='';still.hidden=true;still.className='pet-still';still.onload=()=>{still.hidden=false;fallback.hidden=true;};still.onerror=()=>{still.hidden=true;fallback.hidden=false;this.refreshStale(still.src);};
      const frame=document.createElement('span');frame.className='pet-frame';const spriteNode=document.createElement('span');spriteNode.className='pet-sprite';spriteNode.hidden=true;frame.append(spriteNode);
      node.append(fallback,still,frame);const p={agent,node,still,spriteNode,fallback,x:0,sign:1,visible:false,phase:{phase:'idle'},limit:0,cell:null};
      petTitle(p);
      loadPortrait(agent, entry=>{p.portraitLoaded=entry.status==='loaded';if(p.portraitLoaded)enablePortraitLink(node,agent);petTitle(p);});
      p.node.dataset.agent=agent;p.idleMs=0;p.restMs=0;p.roaming=false;this.pets.set(agent,p);this.io.observe(node);this.setAsset(p);return p;
    }
    update(context) {
      const switched=this.context?.topicId!==context.topicId;
      if(switched)for(const p of this.pets.values()){this.home(p);p.idleMs=0;p.restMs=0;}
      this.context=context;
      const homes=latestHomes(context.messages,context.topicId,context.graph?.membership || {});
      const assigned=new Map();
      for(const agent of IDS){
        const card=context.cards.get(context.resolve(homes.get(agent)));
        const usable=(!context.participants || context.participants.includes(agent)) && context.view==='flow' && this.mode!=='hidden' && card?.isConnected && card.getClientRects().length>0 && !card.closest('[hidden]');
        if(!usable){const p=this.pets.get(agent);if(p){this.io.unobserve(p.node);p.node.remove();this.pets.delete(agent);}continue;}
        let band=card.querySelector(':scope > .avatar-band');if(!band){band=document.createElement('div');band.className='avatar-band';card.prepend(band);this.resize.observe(band);}
        if(!assigned.has(band))assigned.set(band,[]);assigned.get(band).push(agent);
        const p=this.pets.get(agent)||this.create(agent);
        if(p.homeBand!==band){this.home(p);p.homeBand=band;band.append(p.node);p.x=0;p.idleMs=0;p.restMs=0;}
        p.homeCardKey=card.dataset.key;
        const oldPhase=p.phase;
        p.phase=selectState(context.agentState?.version===1 ? context.agentState.agents?.[agent] : null,context.topicId);
        if(!isIdle(p.phase)||!isIdle(oldPhase)){p.idleMs=0;p.restMs=0;this.home(p);}
        petTitle(p);
      }
      // Remove abandoned bands before link geometry is measured.
      for(const band of this.zone.querySelectorAll('.avatar-band'))if(!assigned.has(band)){this.resize.unobserve(band);band.remove();}
      for(const [band,agents] of assigned)agents.forEach((agent,i)=>{const p=this.pets.get(agent);p.slot=i;p.slots=agents.length;});
      if(context.view==='flow' && this.mode!=='hidden' && this.pets.size && (!this.assets || Date.now()>this.refreshAt))this.load();
      this.measure();this.sync();
    }
    home(p) {
      if(!p.roaming && !p.exiting)return;
      const wasRoaming=p.roaming;
      p.roaming=false;p.exiting=null;p.destination=null;p.hiddenMs=0;
      p.x=Math.max(0,Math.min(p.savedHomeX??p.x??0,p.limit??Infinity));
      if(wasRoaming)p.homeBand.append(p.node);
      p.node.classList.remove('is-roaming');
      p.node.removeAttribute('tabindex');p.node.removeAttribute('aria-hidden');
      this.sizeAtHome(p);
    }
    sizeAtHome(p) {
      p.node.style.width=p.homeWidth+'px';p.node.style.height=p.homeHeight+'px';
      p.node.style.left=(p.slot*p.slotWidth)+'px';p.node.style.top='4px';
      p.spriteNode.style.transform=`scale(${p.homeHeight/208})`;
      p.node.style.transform=`translateX(${p.x}px)`;
    }
    // 代替案B: leave by walking the band (front layer, above the card) to the
    // card edge; only there does the pet drop into the roam layer.
    depart(p,plan) {
      if(!p.homePoint || !plan || p.node.contains(document.activeElement))return false;
      p.savedHomeX=p.x;
      const left=plan.exit.x<p.homePoint.x;
      p.exiting={exit:plan.exit,destination:plan.destination,targetX:left ? -p.slot*p.slotWidth-p.homeWidth : (p.slots-p.slot)*p.slotWidth};
      p.sign=left?-1:1;p.hiddenMs=0;
      p.node.classList.add('is-roaming');
      p.node.setAttribute('tabindex','-1');p.node.setAttribute('aria-hidden','true');
      return true;
    }
    reparent(p) {
      const {exit,destination}=p.exiting;
      p.exiting=null;p.rx=exit.x;p.ry=exit.y;p.destination=destination;p.roaming=true;p.hiddenMs=0;
      this.layer.append(p.node);
      p.node.style.left='0px';p.node.style.top='0px';p.node.style.width=ROAM.width+'px';p.node.style.height=ROAM.height+'px';
      p.spriteNode.style.transform=`scale(${ROAM.height/208})`;
      p.node.style.transform=`translate(${p.rx}px,${p.ry}px)`;
    }
    measure() {
      if(this.canvas && this.context?.view==='flow'){
        const g=snapshotFlow(this.canvas,this.context.zoom||1),signature=JSON.stringify(g);
        if(signature!==this.geometrySignature){
          this.geometry=g;this.geometrySignature=signature;
          for(const p of this.pets.values()){
            if(p.exiting){
              // Layout moved while walking the band: restart from home.
              if(!withinCanvas(p.exiting.exit,g) || !routeAllowed(p.exiting.exit,p.exiting.destination,g))this.home(p);
              continue;
            }
            if(!p.roaming)continue;
            const here={x:p.rx,y:p.ry};
            // Remeasurements can invalidate even a previously visible resting place.
            if(!withinCanvas(here,g) || (!p.destination ? !fits(here,g) : !routeAllowed(here,p.destination,g)||p.hiddenMs/1000+hiddenTime(here,p.destination,g)>ROAM.hiddenSeconds))this.home(p);
          }
        }
        const nodes=new Set(this.canvas.querySelectorAll(PROTECTED));
        for(const node of this.layoutNodes)if(!nodes.has(node))this.resize.unobserve(node);
        for(const node of nodes)if(!this.layoutNodes.has(node))this.resize.observe(node);
        this.layoutNodes=nodes;
      }
      for(const p of this.pets.values()){
        const band=p.homeBand||p.node.parentElement;if(!band)continue;
        const width=band.clientWidth/p.slots,height=Math.min(56,Math.max(1,(width-4)*208/192));
        p.homeWidth=height*192/208;p.homeHeight=height;p.slotWidth=width;
        p.limit=Math.max(0,width-p.homeWidth-2);if(!p.exiting)p.x=Math.min(p.x,p.limit);
        if(!p.roaming)this.sizeAtHome(p);
        if(this.canvas){const box=rectInCanvas(band.getBoundingClientRect(),this.canvas.getBoundingClientRect(),this.context.zoom||1);p.homePoint={x:box.x+p.slot*width+p.x,y:box.y+4};}
        const target=this.pets.get(this.context?.lookAgent);
        if(!p.roaming && target && target!==p){const a=p.node.getBoundingClientRect(),b=(target.homeBand||target.node).getBoundingClientRect(),z=this.context.zoom||1;p.cell=direction((b.x+b.width/2-a.x-a.width/2)/z,(b.y+b.height/2-a.y-a.height/2)/z);}else p.cell=null;
      }
    }
    scheduleMeasure(){
      if(this.measureRaf)return;
      this.measureRaf=requestAnimationFrame(()=>{this.measureRaf=0;this.measure();this.sync();});
    }
    report(step=8){
      this.measure();
      if(!this.geometry)throw Error('フロー表示で計測してください');
      const homes=[...this.pets.values()].filter(p=>p.homePoint).map(p=>({agent:p.agent,homeCardKey:p.homeCardKey,...p.homePoint}));
      return {topicId:this.context.topicId,timestamp:new Date().toISOString(),viewport:{width:window.innerWidth,height:window.innerHeight,scrollTop:this.zone.scrollTop,scrollLeft:this.zone.scrollLeft},geometry:this.geometry,homes,analysis:analyzeSpace(this.geometry,homes,step)};
    }
    // Preserve HEAD: embedded panes may report document.hidden while visible.
    active(p){return this.context?.view==='flow' && this.mode==='moving' && !this.motion.matches && p.visible && p.node.isConnected && p.phase.phase!=='off' && p.phase.reason!=='state-unavailable';}
    paint(p,moving=false) {
      if(!p){this.sync();return;}
      const animate=this.active(p) && p.loaded && !!this.format;
      p.spriteNode.hidden=!animate;p.still.style.visibility=animate?'hidden':'';p.fallback.style.visibility=animate?'hidden':'';
      p.node.classList.toggle('pet-off',p.phase.phase==='off');
      if(!animate){p.spriteNode.style.animationPlayState='paused';return;}
      let row=stateRow(p.phase);const look=isIdle(p.phase) && p.cell && !moving && !p.roaming;
      if(moving)row=p.sign>0?'running-right':'running-left';
      const a=this.format?.animations[row];if(!a)return;
      const key=look?`look-${p.cell.row}-${p.cell.col}`:row;
      if(p.paintKey!==key){
        p.paintKey=key;
        if(look){p.spriteNode.style.animation='none';p.spriteNode.style.backgroundPosition=`${-p.cell.col*192}px ${-p.cell.row*208}px`;}
        else{p.spriteNode.style.backgroundPosition='';p.spriteNode.style.animation=`u2pet-${row} ${a.durations.reduce((x,y)=>x+y,0)}ms steps(1,end) infinite`;}
      }
      p.spriteNode.style.animationPlayState=p.phase.phase==='off'?'paused':'running';
    }
    needsTick(p){return this.active(p) && p.loaded && isIdle(p.phase) && (this.range==='free' || p.limit>4);}
    sync(){
      if(this.context && this.mode==='hidden' && this.pets.size){this.update(this.context);return;}
      for(const p of this.pets.values()){
        if((p.roaming || p.exiting) && (this.range!=='free' || this.mode!=='moving' || this.motion.matches || !isIdle(p.phase)))this.home(p);
        if(!this.active(p))p.hiddenMs=0; // tab/viewport pauses do not consume the occlusion budget
        this.loadSprite(p);this.paint(p,!!p.destination||!!p.exiting);
      }
      if([...this.pets.values()].some(p=>this.needsTick(p))){if(!this.raf){this.clock=0;this.raf=requestAnimationFrame(t=>this.tick(t));}}
      else{cancelAnimationFrame(this.raf);this.raf=0;this.clock=0;}
    }
    tick(t){
      this.raf=0;
      const elapsed=this.clock?t-this.clock:0;
      if(this.clock && elapsed<1000/30){this.raf=requestAnimationFrame(n=>this.tick(n));return;}
      // Cap, never zero: throttled embedded panes deliver ~1s frames while
      // visible. A 100ms cap forbids catch-up teleports but keeps motion.
      const dt=Math.min(100,elapsed);this.clock=t;
      for(const p of this.pets.values()){
        if(!this.needsTick(p))continue;
        p.idleMs=(p.idleMs||0)+dt;
        if(this.range==='free'){
          this.tickFree(p,dt);continue;
        }
        const walking=p.idleMs>=ROAM.idleMs && p.idleMs%10000<2500 && !p.node.contains(document.activeElement);
        if(walking){p.x+=p.sign*dt*0.012;if(p.x>=p.limit){p.x=p.limit;p.sign=-1;}if(p.x<=0){p.x=0;p.sign=1;}p.node.style.transform=`translateX(${p.x}px)`;}
        this.paint(p,walking);
      }
      if([...this.pets.values()].some(p=>this.needsTick(p)))this.raf=requestAnimationFrame(n=>this.tick(n));
    }
    tickFree(p,dt){
      if(!this.geometry || !p.homePoint || p.idleMs<ROAM.idleMs || p.node.contains(document.activeElement)){this.paint(p,!!p.exiting);return;}
      p.restMs=Math.max(0,(p.restMs||0)-dt);
      if(p.exiting){this.tickExit(p,dt);return;}
      if(!p.destination && !p.restMs){
        const occupied=[...this.pets.values()].filter(q=>q!==p&&(q.roaming||q.exiting)).map(q=>q.destination||q.exiting?.destination||{x:q.rx,y:q.ry});
        if(!p.roaming){
          const homeRect=this.geometry.rects.find(r=>r.cardKey && r.cardKey===p.homeCardKey);
          const plan=homeRect ? chooseExit(homeRect,Math.max(ROAM.margin,p.homePoint.y),this.geometry,Math.random,occupied) : null;
          if(!plan || !this.depart(p,plan)){p.restMs=5000;this.paint(p);return;}
          this.tickExit(p,dt);return;
        }
        const destination=chooseDestination({x:p.rx,y:p.ry},this.geometry,Math.random,occupied);
        if(!destination){this.home(p);p.restMs=5000;this.paint(p);return;}
        p.destination=destination;
      }
      let moved=false;
      if(p.destination){
        const dx=p.destination.x-p.rx,dy=p.destination.y-p.ry,distance=Math.hypot(dx,dy),step=Math.min(distance,ROAM.speed*dt/1000);
        if(distance>0){p.rx+=dx/distance*step;p.ry+=dy/distance*step;if(Math.abs(dx)>0.01)p.sign=dx>0?1:-1;moved=step>0;}
        p.node.style.transform=`translate(${p.rx}px,${p.ry}px)`;
        const here={x:p.rx,y:p.ry};
        // No exemption anywhere: the home card hides the pet like any other.
        const hidden=this.geometry.rects.some(r=>inside(here,inflated(r)));
        p.hiddenMs=hidden?(p.hiddenMs||0)+dt:0;
        if(p.hiddenMs>ROAM.hiddenSeconds*1000){this.home(p);p.restMs=5000;this.paint(p);return;}
        if(step>=distance){p.destination=null;p.restMs=2500+Math.random()*2500;}
      }
      this.paint(p,moved);
    }
    // Band walk toward the card edge; the pet is clipped by the band while the
    // matching outside position stays empty, so the hand-off is seamless.
    tickExit(p,dt){
      const target=p.exiting.targetX,dir=target>p.x?1:-1;
      p.sign=dir;p.x+=dir*ROAM.speed*dt/1000;
      if((dir>0 && p.x>=target)||(dir<0 && p.x<=target))this.reparent(p);
      else p.node.style.transform=`translateX(${p.x}px)`;
      this.paint(p,true);
    }

  }
  globalThis.U2AAvatar={Controller,badge,selectState,stateRow,direction,validateFormat,keyframes,latestHomes,ROAM,normalizeRange,isIdle,rectInCanvas,snapshotFlow,analyzeSpace,segmentInterval,mergeIntervals,hiddenTime,withinCanvas,fits,routeAllowed,chooseDestination,exitPoints,chooseExit};
})();
