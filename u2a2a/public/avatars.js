/* SPEC-アバター状態 v1 adapter. No server state inference. */
(() => {
  'use strict';
  const IDS = ['claude', 'codex', 'grok'];
  const LETTER = { claude: 'C', codex: 'X', grok: 'G' };
  const TITLE = { idle:'待機', working:'作業中', reviewing:'レビュー中', waiting:'入力待ち', halted:'停止中', failed:'エラー', off:'自動応答OFF' };
  const DISPLAY = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok' };
  const REASON = { budget:'上限による停止', 'stopped-unknown':'停止（理由未確認）', unauthed:'ログインが必要', 'state-unavailable':'状態情報未接続', 'auto-off':'自動応答オフ', cancelled:'キャンセル', error:'エラー', history:'履歴保存の失敗', 'project-blocked':'対象プロジェクト不可' };
  const FACES = {"claude": "data:image/webp;base64,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", "codex": "data:image/webp;base64,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", "grok": "data:image/webp;base64,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"};
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
  function badge(agent, portrait = false) {
    const node = document.createElement(portrait ? 'a' : 'span');
    node.className = 'agent-avatar ' + (portrait ? 'agent-avatar-face' : 'agent-avatar-letter');
    node.style.setProperty('--avatar-color', known(agent) ? `var(--${agent})` : 'var(--dim)');
    node.textContent = LETTER[agent] || String(agent || '?').slice(0,1);
    node.setAttribute('aria-label', DISPLAY[agent] || agent || 'エージェント');
    if (portrait && known(agent)) {
      node.href = ART + encodeURIComponent(PORTRAITS[agent][1]); node.target='_blank'; node.rel='noopener';
      node.title = `${DISPLAY[agent] || agent} の自画像を見る`; node.setAttribute('aria-label', node.title);
      const img = new Image(); img.alt=''; img.loading='lazy';
      img.src = FACES[agent];
      img.onerror = () => img.remove(); node.append(img);
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
  class Controller {
    constructor({zone, controls, changed}) {
      this.zone=zone; this.changed=changed; this.pets=new Map(); this.context=null; this.assets=null; this.format=null; this.loading=null; this.retryAt=0; this.refreshAt=0; this.staleURLs=new Set(); this.clock=0; this.raf=0;
      this.motion=matchMedia('(prefers-reduced-motion: reduce)');
      try { this.mode=localStorage.getItem('u2a2a-avatar-mode') || 'moving'; } catch { this.mode='moving'; }
      if (!['moving','static','hidden'].includes(this.mode)) this.mode='moving';
      const label=document.createElement('label'); label.className='avatar-setting'; label.append('ペット ');
      this.select=document.createElement('select'); this.select.setAttribute('aria-label','ペットの表示');
      for(const [value,text] of [['moving','動く'],['static','静止'],['hidden','非表示']]) {const o=document.createElement('option'); o.value=value;o.textContent=text;this.select.append(o);}
      this.select.value=this.mode; label.append(this.select); label.classList.add('pet-mode-setting'); controls.append(label);
      this.select.onchange=()=>{this.mode=this.select.value;try{localStorage.setItem('u2a2a-avatar-mode',this.mode);}catch{}this.sync();this.changed();};
      this.motion.addEventListener('change',()=>this.sync());
      document.addEventListener('visibilitychange',()=>this.sync());
      this.io=new IntersectionObserver(entries=>{for(const e of entries){const p=[...this.pets.values()].find(p=>p.node===e.target);if(p)p.visible=e.isIntersecting;}this.sync();},{root:zone});
      this.resize=new ResizeObserver(()=>this.measure());
      zone.addEventListener('scroll',()=>this.measure(),{passive:true});
      window.addEventListener('resize',()=>this.measure());
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
      if(placeholder && p.placeholder!==placeholder){p.placeholder=placeholder;p.still.src=placeholder;}
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
        p.loaded=true;p.spriteNode.style.backgroundImage=`url(${JSON.stringify(url)})`;this.sync();};
      img.onerror=()=>{if(p.sprite===url){p.failed=true;p.image=null;this.refreshStale(url);}};img.src=url;
    }
    create(agent) {
      const node=document.createElement('a');node.className='flow-pet';node.style.setProperty('--avatar-color',`var(--${agent})`);
      node.href=ART+encodeURIComponent(PORTRAITS[agent][1]);node.target='_blank';node.rel='noopener';
      const fallback=badge(agent);fallback.classList.add('pet-fallback');
      const still=new Image();still.alt='';still.hidden=true;still.className='pet-still';still.onload=()=>{still.hidden=false;fallback.hidden=true;};still.onerror=()=>{still.hidden=true;fallback.hidden=false;this.refreshStale(still.src);};
      const frame=document.createElement('span');frame.className='pet-frame';const spriteNode=document.createElement('span');spriteNode.className='pet-sprite';spriteNode.hidden=true;frame.append(spriteNode);
      node.append(fallback,still,frame);const p={agent,node,still,spriteNode,fallback,x:0,sign:1,visible:false,phase:{phase:'idle'},limit:0,cell:null};
      this.pets.set(agent,p);this.io.observe(node);this.setAsset(p);return p;
    }
    update(context) {
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
        if(p.node.parentNode!==band){band.append(p.node);p.x=0;}
        p.phase=selectState(context.agentState?.version===1 ? context.agentState.agents?.[agent] : null,context.topicId);
        p.node.title=`${DISPLAY[agent] || agent} · ${REASON[p.phase.reason] || TITLE[p.phase.phase] || '待機'}${p.phase.kind==='summary'?'（要約中）':''}${p.phase.outcomeId && p.phase.source!=='outcome'?' · 未確認の終了状態あり':''} — 自画像を見る`;
        p.node.setAttribute('aria-label',p.node.title);
      }
      // Remove abandoned bands before link geometry is measured.
      for(const band of this.zone.querySelectorAll('.avatar-band'))if(!assigned.has(band)){this.resize.unobserve(band);band.remove();}
      for(const [band,agents] of assigned)agents.forEach((agent,i)=>{const p=this.pets.get(agent);p.slot=i;p.slots=agents.length;});
      if(context.view==='flow' && this.mode!=='hidden' && this.pets.size && (!this.assets || Date.now()>this.refreshAt))this.load();
      this.measure();this.sync();
    }
    measure() {
      for(const p of this.pets.values()){
        const band=p.node.parentElement;if(!band)continue;
        const width=band.clientWidth/p.slots;
        // Shrink only when necessary to avoid overlap in a shared narrow band.
        const height=Math.min(56,Math.max(1,(width-4)*208/192));
        const bodyWidth=height*192/208;
        p.node.style.width=bodyWidth+'px';p.node.style.height=height+'px';p.node.style.left=(p.slot*width)+'px';
        p.spriteNode.style.transform=`scale(${height/208})`;
        p.limit=Math.max(0,width-bodyWidth-2);p.x=Math.min(p.x,p.limit);
        p.node.style.transform=`translateX(${p.x}px)`;
        const target=this.pets.get(this.context?.lookAgent);
        if(target && target!==p){const a=p.node.getBoundingClientRect(),b=target.node.getBoundingClientRect();const z=this.context.zoom||1;p.cell=direction((b.x+b.width/2-a.x-a.width/2)/z,(b.y+b.height/2-a.y-a.height/2)/z);}else p.cell=null;
      }
    }
    // document.hidden は見ない: 埋め込みブラウザ（Claude のペイン等）は表示中でも hidden を報告する。省エネは rAF の自動節流と IntersectionObserver が担う
    active(p){return this.context?.view==='flow' && this.mode==='moving' && !this.motion.matches && p.visible && p.node.isConnected && p.phase.phase!=='off' && p.phase.reason!=='state-unavailable';}
    paint(p,moving=false) {
      const animate=this.active(p) && p.loaded && !!this.format;
      p.spriteNode.hidden=!animate;p.still.style.visibility=animate?'hidden':'';p.fallback.style.visibility=animate?'hidden':'';
      p.node.classList.toggle('pet-off',p.phase.phase==='off');
      if(!animate){p.spriteNode.style.animationPlayState='paused';return;}
      let row=stateRow(p.phase);const look=p.phase.phase==='idle' && p.cell && !moving;
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
    needsTick(p){return this.active(p) && p.loaded && p.phase.phase==='idle' && !p.phase.kind && p.limit>4;}
    sync(){
      if(this.context && this.mode==='hidden' && this.pets.size){this.update(this.context);return;}
      for(const p of this.pets.values()){this.loadSprite(p);this.paint(p);}
      if([...this.pets.values()].some(p=>this.needsTick(p))){if(!this.raf){this.clock=0;this.raf=requestAnimationFrame(t=>this.tick(t));}}
      else{cancelAnimationFrame(this.raf);this.raf=0;this.clock=0;}
    }
    tick(t){
      this.raf=0;const dt=this.clock?Math.min(50,t-this.clock):0;this.clock=t;
      for(const p of this.pets.values()){
        if(!this.needsTick(p))continue;
        // Idle-only short stroll, with a stationary interval for gaze and breathing.
        const walking=p.loaded && p.phase.phase==='idle' && !p.phase.kind && p.limit>4 && t%10000<2500;
        if(walking){p.x+=p.sign*dt*0.012;if(p.x>=p.limit){p.x=p.limit;p.sign=-1;}if(p.x<=0){p.x=0;p.sign=1;}p.node.style.transform=`translateX(${p.x}px)`;}
        this.paint(p,walking);
      }
      if([...this.pets.values()].some(p=>this.needsTick(p)))this.raf=requestAnimationFrame(n=>this.tick(n));
    }
  }
  globalThis.U2AAvatar={Controller,badge,selectState,stateRow,direction,validateFormat,keyframes,latestHomes};
})();
