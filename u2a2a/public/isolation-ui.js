/* Credential isolation API contract v2; existing bootstrap owns authentication. The server owns protection assessment. */
(() => {
  'use strict';
  const HEX = /^[a-f0-9]{64}$/;
  // サーバは Host として 127.0.0.1 / localhost / [::1] を同値に許可する（server.mjs の ALLOWED_HOSTS）。
  // 資格の受理もそれに合わせる。これ以外のホストは従来どおり別サーバとして拒否する
  const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
  const UNVERIFIED = {cliCredentials:'CLIの資格', cliSessionStore:'CLIの履歴保存', controlSocket:'制御ソケット', mcp:'MCP', execFiles:'実行ファイル'};
  const n = (tag, text, attrs = {}) => {
    const e = document.createElement(tag);
    if (text != null) e.textContent = text;
    for (const [k,v] of Object.entries(attrs)) e.setAttribute(k,v);
    return e;
  };
  // The existing bootstrap owns credentials, storage, Authorization and SSE tickets.
  // This adapter only retrieves API-backed media using the already-authenticated fetch.
  class Media {
    constructor({fetcher=(...args)=>globalThis.fetch(...args), credential=()=>window.yoseaiCredential(),
      location=globalThis.location, onUnauthorized=()=>{}}={}) {
      Object.assign(this,{fetcher,credential,location,onUnauthorized});
      this.epoch=0;this.assets=new Map();this.urls=new Set();this.sources=new WeakMap();this.pending=new Map();
    }
    isApi(value) {
      try {const url=new URL(value,this.location.href);return url.origin===this.location.origin && url.pathname.startsWith('/api/');} catch {return false;}
    }
    clear() {
      this.epoch++;for(const url of this.urls)URL.revokeObjectURL(url);
      this.urls.clear();this.assets.clear();this.pending.clear();
    }
    async asset(value) {
      if(!this.isApi(value))return value;
      if(!this.credential()){this.onUnauthorized();throw new Error('資格が必要です。');}
      const key=new URL(value,this.location.href).href;
      if(!this.assets.has(key)) {
        const epoch=this.epoch;
        const pending=(async()=>{
          const response=await this.fetcher(key,{cache:'no-store',redirect:'error'});
          if(response.status===401)this.onUnauthorized();
          if(!response.ok)throw new Error('ファイルを取得できません（HTTP '+response.status+'）。');
          const blob=await response.blob();
          if(epoch!==this.epoch)throw new Error('接続状態が変わりました。');
          const url=URL.createObjectURL(blob);this.urls.add(url);return url;
        })();
        this.assets.set(key,pending);
        pending.catch(()=>{if(this.assets.get(key)===pending)this.assets.delete(key);});
      }
      return this.assets.get(key);
    }
    setSource(element,value) {
      this.sources.set(element,value);
      if(!this.isApi(value)){this.pending.delete(element);element.src=value;return;}
      if(!this.credential()){this.pending.set(element,value);return;}
      this.pending.delete(element);
      this.asset(value).then(url=>{if(this.sources.get(element)===value)element.src=url;})
        .catch(()=>{if(this.sources.get(element)===value)element.dispatchEvent(new Event('error'));});
    }
    resume() {for(const [element,value] of [...this.pending])this.setSource(element,value);}
  }
  class LiveConnection {
    constructor({credential=()=>window.yoseaiCredential(), fetcher=(...args)=>globalThis.fetch(...args),
      openEvents=()=>window.yoseaiOpenEvents(), onState, onUnauthorized=()=>{}, onDisconnect=()=>{},
      later=(...a)=>setTimeout(...a),cancel=(...a)=>clearTimeout(...a)}={}) { // 素の setTimeout/clearTimeout を this 付きで呼ぶと Illegal invocation
      Object.assign(this,{credential,fetcher,openEvents,onState,onUnauthorized,onDisconnect,later,cancel});
      this.generation=0;this.source=null;this.timer=null;this.retry=1000;
    }
    stop(){this.generation++;this.cancel(this.timer);this.timer=null;this.source?.close();this.source=null;}
    async start(){
      this.stop();const generation=this.generation;
      if(!this.credential()){this.onUnauthorized();return;}
      try {
        const response=await this.fetcher('/api/state',{cache:'no-store'});
        if(generation!==this.generation)return;
        if(response.status===401){this.onUnauthorized();return;}
        if(!response.ok)throw new Error('state');
        const state=await response.json();if(generation!==this.generation)return;
        this.onState(state);
        const source=await this.openEvents();
        if(generation!==this.generation){source.close();return;}
        this.source=source;
        source.onmessage=e=>{
          if(generation!==this.generation)return;
          try{const state=JSON.parse(e.data);this.retry=1000;this.onState(state);}catch{this.failed(generation);}
        };
        source.onerror=()=>this.failed(generation);
      }catch{this.failed(generation);}
    }
    failed(generation){
      if(generation!==this.generation)return;
      this.stop();this.onDisconnect();
      if(!this.credential()){this.onUnauthorized();return;}
      this.timer=this.later(()=>this.start(),this.retry);this.retry=Math.min(this.retry*2,15000);
    }
  }
  class Controller {
    constructor({client, mount=document.body, navigate=token=>{
      // Reload with a fragment so the original bootstrap alone consumes/persists it.
      history.replaceState(null,'',location.pathname+location.search+'#t='+token);
      location.reload();
    }} = {}) {
      this.client = client || new Media();this.navigate=navigate;this.busy=false;this.onLock=()=>{};
      this.client.onUnauthorized=()=>this.lock('資格が無効または失効しています。サーバを起動した端末の新しいURLを入力してください。');
      this.panel=n('section',null,{class:'isolation-panel','aria-label':'資格と隔離の状態'});
      this.status=n('strong','保護状態: 未取得',{role:'status','aria-live':'polite'});
      this.reason=n('span','');
      this.edit=n('button','資格を再入力',{type:'button',class:'small'});
      this.edit.addEventListener('click',()=>this.open());
      const details=n('details');details.append(n('summary','運用の変更と保護範囲'));
      details.append(n('p','ブックマークから開いて資格を求められたら、起動端末の #t= 付きURLを入力してください。再起動・資格の失効後は新しいURLで再入力が必要です。'));
      details.append(n('p','隔離を適用すると、Claude / Grok の書き込み先は作業中のトピックに限られます。pool 直下への保存はできません。成果物は指定されたトピック内へ保存してください。'));
      details.append(n('p','CLI自身の推論資格を、そのCLIが起動するコードから隠すことは初版の保護対象外です。'));
      details.append(n('p','成果物のリンクは認証付きで取得してダウンロードします。HTMLプレビューは別の隔離枠で開くため、相対ファイル参照やストレージを使う成果物は単体では動かない場合があります。'));
      this.meta=n('p');details.append(this.meta);
      this.panel.append(this.status,this.reason,this.edit,details);
      this.dialog=n('dialog',null,{class:'credential-dialog','aria-labelledby':'credential-title'});
      const form=n('form'); form.append(n('h2','Yoseaiの資格を入力',{id:'credential-title'}));
      this.message=n('p','サーバを起動した端末のURL、または #t= の後ろの64文字を入力してください。',{role:'status','aria-live':'polite'});
      const label=n('label','端末のURLまたは資格');
      this.input=n('input',null,{type:'password',autocomplete:'off',spellcheck:'false',required:'',maxlength:'2048','aria-label':'端末のURLまたは資格'});
      label.append(this.input);
      this.submit=n('button','資格を適用して再読込',{type:'submit'});
      const cancel=n('button','閉じる',{type:'button',class:'small'});cancel.addEventListener('click',()=>this.dialog.close());
      form.append(this.message,label,n('p','資格はこのタブのセッションに保持します。入力内容を会話や成果物へ貼り付けないでください。'),this.submit,cancel);
      form.addEventListener('submit',e=>{e.preventDefault();this.accept();});
      this.dialog.addEventListener('close',()=>{this.input.value='';});
      this.dialog.append(form);mount.append(this.dialog);
      this.update(null);
    }
    update(isolation) {
      const i=isolation;
      this.panel.dataset.mode=i?.mode || 'unknown';
      // Only style a verified server assessment as success; never derive verification from probes in the UI.
      this.panel.dataset.verified=String(i?.mode==='enforced' && i.verified===true);
      this.status.textContent=typeof i?.label==='string' && i.label ? i.label : '保護状態: 未取得';
      this.reason.textContent=i?.mode==='blocked' ? '隔離を初期化できないため実行しません。'+(i.reason || '') : (i?.reason || '');
      this.meta.textContent=i ? '実装: '+(i.runtime || '不明')+' / '+(i.version || '版不明')+
        ' ／ プロファイル: '+(i.profilesSha256 || '不明')+' ／ 検証日時: '+(i.verifiedAt || '未検証')+
        ' ／ 要確認: '+((i.unverified || []).map(k=>UNVERIFIED[k] || k).join('、') || 'なし') : 'サーバへ接続して状態を取得してください。';
    }
    open() {if (!this.dialog.open) this.dialog.showModal();this.input.focus();}
    lock(message) {this.update(null);this.onLock();this.message.textContent=message;this.input.value='';this.open();}
    parseCredential(value) {
      const text=String(value || '').trim();
      if(HEX.test(text))return text;
      try{const url=new URL(text);const token=new URLSearchParams(url.hash.slice(1)).get('t');
        if(this.sameServer(url) && HEX.test(token || ''))return token;
      }catch{}
      return null;
    }
    // 画面を 127.0.0.1 で開いていても、端末が案内した localhost 表記の URL を貼れるようにする。
    // 別ホスト・別ポート・別プロトコルは拒否（origin 完全一致だと同じサーバの別表記まで弾いていた）
    sameServer(url) {
      let here;
      try{ here=new URL(this.client.location.href || this.client.location.origin); }catch{ return false; }
      if(url.protocol!==here.protocol || url.port!==here.port) return false;
      return url.hostname===here.hostname || (LOOPBACK.has(url.hostname) && LOOPBACK.has(here.hostname));
    }
    async accept() {
      if(this.busy)return;
      const token=this.parseCredential(this.input.value);this.input.value='';
      if(!token){this.message.textContent='同じYoseaiの端末URL、または64桁の資格を入力してください。';return;}
      this.busy=true;this.submit.disabled=true;this.onLock();this.update(null);
      this.message.textContent='再読込して資格を確認します。';
      try{this.navigate(token);}catch{this.busy=false;this.submit.disabled=false;this.message.textContent='再読込できません。端末のURLでこの画面を開き直してください。';}
    }
    bindFiles(doc=document) {
      // Fetch API file links as downloads, never navigate executable artifacts into the credential origin.
      doc.addEventListener('click',async e=>{
        const a=e.target.closest?.('a[href]');
        if (!a || !this.client.isApi(a.href) || !new URL(a.href,this.client.location.href).pathname.startsWith('/api/pool/file/')) return;
        e.preventDefault();
        try {
          const url=await this.client.asset(a.href), link=n('a');
          link.href=url;link.download=decodeURIComponent(new URL(a.href,this.client.location.href).pathname.split('/api/pool/file/')[1]).split('/').pop() || 'artifact';
          doc.body.append(link);link.click();link.remove();
        } catch {this.reason.textContent='ファイルを取得できません。資格と接続状態を確認してください。';}
      });
      const hydrate=()=>{
        for (const e of doc.querySelectorAll('[data-yoseai-src]')) {
          const src=e.getAttribute('data-yoseai-src');e.removeAttribute('data-yoseai-src');this.client.setSource(e,src);
        }
      };
      this.observer=new MutationObserver(hydrate);this.observer.observe(doc.body,{childList:true,subtree:true});hydrate();
    }
  }
  globalThis.YoseaiIsolation={Media,LiveConnection,Controller};
})();
