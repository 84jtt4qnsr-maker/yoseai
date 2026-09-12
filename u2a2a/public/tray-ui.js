/* Judgment tray API contract v4: revision mode proposer/rediscuss. Render evaluated views; never derive permissions or hashes. */
(() => {
  'use strict';
  const STATUS = {pending:'判断待ち', parked:'あとで', 'revision-requested':'修正待ち',
    answered:'回答済み', approved:'承認済み', rejected:'見送り', superseded:'新版へ置換', cancelled:'無効'};
  const SECTIONS = {waiting:'判断待ち', later:'あとで', history:'履歴'};
  const TARGETS = {scope:'範囲', assignee:'担当', approach:'進め方', other:'その他'};
  const SEND = {waiting:'前提待ち', ready:'送信待ち', sent:'着手指示を送信済み', failed:'送信失敗', blocked:'送信不可'};
  // Presentation categories only. Buttons use actionable, not these codes.
  const REASONS = {
    'agent-auto-off':'送信保留', 'agent-unauthed':'送信保留', 'budget-halt':'送信保留',
    'assignee-not-participant':'着手不可', 'basis-changed':'着手不可', 'details-changed':'着手不可',
    'base-commit-unverified':'着手不可', 'dependency-unresolved':'依存待ち',
    'dependency-changed':'依存変更', 'dependency-coverage-changed':'依存変更', 'head-moved':'警告'
  };
  const n = (tag, text, attrs = {}) => {
    const e = document.createElement(tag);
    if (text != null) e.textContent = String(text);
    for (const [k,v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    return e;
  };
  const b = (text, action) => {
    const e=n('button',text,{type:'button',class:'small'}); e.addEventListener('click',action); return e;
  };
  const copy = value => JSON.parse(JSON.stringify(value));
  const list = (values, empty='なし') => {
    const e=n('ul'); for (const value of values || []) e.append(n('li',value));
    if (!e.children.length) e.append(n('li',empty)); return e;
  };
  const safeFile = value => {
    if (typeof value !== 'string' || !value.startsWith('topics/') || value.split('/').some(x=>!x || x==='.' || x==='..') || /[\\\x00-\x1f]/.test(value)) return null;
    return '/api/pool/file/' + value.split('/').map(encodeURIComponent).join('/');
  };
  const file = path => {
    const href=safeFile(path);
    return href ? n('a',path,{href,target:'_blank',rel:'noopener noreferrer'}) : n('span',path);
  };
  function blockers(values) {
    const root=n('div',null,{class:'tray-blockers'});
    for (const reason of values || []) root.append(n('p',
      (REASONS[reason.code] || '確認事項') + '：' + reason.message + (reason.target ? '（'+reason.target+'）' : ''),
      {'data-code':reason.code}));
    return root;
  }
  async function request(fetcher, path, body) {
    const response = await fetcher(path, body === undefined ? {cache:'no-store'} : {
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
    });
    let data;
    try { data=await response.json(); } catch { throw new Error('サーバの応答を読み取れません。再読込してください。'); }
    if (!response.ok) {
      const err=new Error(data.error || '操作を受け付けられませんでした。');
      Object.assign(err,{code:data.code,status:response.status,data}); throw err;
    }
    return data;
  }
  class Controller {
    constructor({fetcher=(...args)=>fetch(...args), mount=document.body, onTask=()=>{},
      topicName=id=>id, agentName=id=>({claude:'Claude Code',codex:'Codex',grok:'Grok'})[id] || id}={}) {
      Object.assign(this,{fetcher,onTask,topicName,agentName});
      this.view=null; this.epoch=0; this.loadId=0; this.connected=false; this.available=false;
      this.section='waiting'; this.current=null; this.pendingKeys=new Set(); this.inflight=new Set();
      this.launcher=b('判断トレイ',()=>this.open());
      this.launcher.setAttribute('aria-haspopup','dialog');
      this.launcher.setAttribute('aria-controls','judgment-tray');
      this.dialog=n('dialog',null,{id:'judgment-tray','aria-labelledby':'judgment-tray-title',class:'judgment-tray'});
      this.heading=n('h2','判断トレイ',{id:'judgment-tray-title',tabindex:'-1'});
      this.notice=n('p','', {role:'status','aria-live':'polite'});
      const top=n('div',null,{class:'tray-top'});
      top.append(this.heading,b('再読込',()=>this.refresh()),b('閉じる',()=>this.dialog.close()));
      this.nav=n('nav',null,{'aria-label':'依頼の区分'});
      this.tabs={};
      for(const [key,label] of Object.entries(SECTIONS)) {
        const tab=b(label,()=>{this.section=key;this.renderList();});
        this.tabs[key]=tab;this.nav.append(tab);
      }
      this.cards=n('div',null,{class:'tray-cards'});
      this.detail=n('section',null,{class:'tray-detail','aria-label':'選択した依頼',hidden:''});
      this.dialog.append(top,this.notice,this.nav,this.cards,this.detail);
      this.notification=n('aside',null,{class:'tray-notification',hidden:'','aria-label':'判断トレイの通知'});
      this.notification.append(n('span','判断待ちの依頼があります。',{role:'status'}),b('トレイを開く',()=>this.open()),b('通知を閉じる',()=>{this.notification.hidden=true;}));
      mount.append(this.dialog,this.notification);
      this.dialog.addEventListener('close',()=>{this.launcher.focus();});
    }
    update(view) {
      if (!view || view.version!==1 || !view.topics || !view.requests) { this.disconnect('判断トレイAPIを利用できません。');return; }
      const previous=this.pendingKeys;
      this.pendingKeys=new Set(Object.values(view.topics).flatMap(t=>t.waiting || []));
      this.view=copy(view); this.epoch++; this.connected=true; this.available=true;
      if ([...this.pendingKeys].some(id=>!previous.has(id)) && !this.dialog.open) this.notification.hidden=false;
      this.launcher.textContent='判断トレイ ('+this.pendingKeys.size+')';
      if (this.current) {
        const latest=this.view.requests[this.current.snapshot.id];
        if (!latest || latest.proposalSha256!==this.current.snapshot.proposalSha256 || latest.status!==this.current.snapshot.status) {
          this.lock('依頼の版または状態が変わりました。入力を確認し、最新の依頼を表示してください。');
        } else {
          this.current.latest=latest;
          this.current.reasons.replaceChildren(blockers(latest.blockers));
          this.renderPlan(this.current);
          this.syncControls();
        }
      }
      this.renderList();
    }
    disconnect(message='接続を確認できません。再読込後に操作してください。') {
      this.connected=false; this.epoch++; this.notice.textContent=message;
      if(this.current) this.lock(message);
    }
    async refresh({discard=false}={}) {
      const epoch=this.epoch, load=++this.loadId;
      this.notice.textContent='読み込み中…';
      try {
        const view=await request(this.fetcher,'/api/tray');
        if(load!==this.loadId) return;
        if(epoch!==this.epoch) { this.notice.textContent='受信済みの最新情報を表示しています。'; return; }
        this.update(view);
        if(!this.available || !this.connected) return;
        if(discard && this.current && !this.current.busy) { const id=this.current.snapshot.id; this.current=null; this.select(id); }
        this.notice.textContent='最新の判断トレイを表示しています。';
      } catch(e) { if(load===this.loadId && epoch===this.epoch) this.disconnect(e.message); }
    }
    open() {
      this.notification.hidden=true;
      if(!this.dialog.open) this.dialog.showModal();
      this.heading.focus(); this.renderList(); this.refresh();
    }
    counts(key) { return Object.values(this.view?.topics || {}).reduce((sum,t)=>sum+(t[key]?.length || 0),0); }
    renderList() {
      for(const [key,tab] of Object.entries(this.tabs)) {
        tab.textContent=SECTIONS[key]+' ('+this.counts(key)+')';
        tab.setAttribute('aria-current',String(this.section===key));
      }
      // Detail controls remain mounted while SSE updates the list.
      const focusKey=document.activeElement?.getAttribute?.('data-tray-focus');
      this.cards.replaceChildren();
      if(!this.view) { this.cards.append(n('p','依頼を読み込むと、ここに表示されます。'));return; }
      for(const [topicId,groups] of Object.entries(this.view.topics)) {
        const ids=groups[this.section] || []; if(!ids.length) continue;
        const group=n('section',null,{'aria-label':this.topicName(topicId)});
        group.append(n('h3',this.topicName(topicId)));
        for(const id of ids) {
          const r=this.view.requests[id]; if(!r) continue;
          const card=n('article',null,{class:'tray-card','data-request-id':id});
          card.append(n('h4',r.title),n('p',r.proposerName+' · '+(STATUS[r.status] || r.status)+' · '+this.age(r.ts)));
          if(r.block.outcome) card.append(n('p',r.block.outcome));
          card.append(blockers(r.blockers)); // Always visible, never hidden in details or title.
          const open=b('内容を確認',()=>this.select(id));open.setAttribute('data-tray-focus',id);card.append(open);
          if(r.plan) for(const e of r.plan.entries || []) card.append(n('p',this.agentName(e.agent)+'：'+(SEND[e.send] || e.send)+(e.error ? ' — '+e.error:'')));
          group.append(card);
        }
        this.cards.append(group);
      }
      if(!this.cards.children.length) this.cards.append(n('p',SECTIONS[this.section]+'の依頼はありません。'));
      if(focusKey) for(const e of this.cards.querySelectorAll('button')) if(e.getAttribute('data-tray-focus')===focusKey) e.focus();
    }
    age(ts) {
      const minutes=Math.max(0,Math.floor((Date.now()-ts)/60000));
      return minutes<60 ? minutes+'分前' : minutes<1440 ? Math.floor(minutes/60)+'時間前' : Math.floor(minutes/1440)+'日前';
    }
    select(id) {
      const r=this.view?.requests[id];
      if(!r) {this.notice.textContent='この依頼は取得できません。再読込してください。';return;}
      if(this.current?.busy) {this.notice.textContent='送信中です。結果が戻ってから切り替えてください。';return;}
      if(this.current?.snapshot.id===id && !this.current.locked) {this.current.heading.focus();return;}
      const e={snapshot:copy(r),latest:r,controls:[],locked:false,busy:false};
      this.current=e; this.detail.hidden=false; this.detail.replaceChildren();
      e.heading=n('h3',r.title,{tabindex:'-1'});
      e.notice=n('p','',{role:'status','aria-live':'polite'});
      e.reasons=n('div'); e.reasons.append(blockers(r.blockers));
      this.detail.append(e.heading,n('p',this.topicName(r.topicId)+' · 提案者：'+r.proposerName+' · '+(STATUS[r.status] || r.status)),
        e.reasons,e.notice);
      this.detail.append(b('最新の依頼を表示（入力を破棄）',()=>this.refresh({discard:true})));
      this.detail.append(n('p','依頼ID：'+r.id,{class:'tray-version'}),n('p','表示した版：'+r.proposalSha256,{class:'tray-version'}));
      this.renderDependencies(e);
      if(r.kind==='start-task') this.renderProposal(e);
      if(r.kind==='question') this.renderQuestion(e);
      this.renderRelations(e);
      e.planRoot=n('section'); this.detail.append(e.planRoot);
      this.renderPlan(e);
      if(r.answer) this.record('回答記録',r.answer);
      if(r.decision) this.record('判断記録',r.decision);
      this.renderActions(e); this.syncControls(); e.heading.focus();
    }
    record(title,value) {
      const d=n('details');d.append(n('summary',title),n('pre',JSON.stringify(value,null,2)));this.detail.append(d);
    }
    renderDependencies(e) {
      const deps=e.snapshot.dependencies || {};
      for(const [key,title] of [['waiting','待っている質問'],['excluded','外した質問（理由）']]) {
        const section=n('section'); section.append(n('h4',title));
        if(!deps[key]?.length) section.append(n('p','なし'));
        for(const d of deps[key] || []) {
          const line=n('p',d.title+' · '+(STATUS[d.status] || d.status)+(d.reason ? ' — '+d.reason:''));
          if(this.view.requests[d.id]) line.append(b('質問を確認',()=>this.select(d.id)));
          else line.append(n('span','（'+d.id+'）'));
          section.append(line);
        }
        this.detail.append(section);
      }
    }
    renderProposal(e) {
      const r=e.snapshot, block=r.block;
      this.detail.append(n('h4','何ができるか'),n('p',block.outcome),n('h4','今回の範囲'),list(block.scope));
      if(block.outOfScope?.length) this.detail.append(n('h4','今回含めないこと'),list(block.outOfScope));
      this.detail.append(n('h4','基点コミット'),n('p',r.baseCommit?.value || block.baseCommit,{class:'tray-version'}));
      if(r.basis) {
        const p=n('p','合意の根拠：');
        if(r.basis.kind==='memo') p.append(file(r.basis.path));
        else p.append(n('span','質疑記録 '+(r.basis.relayId || block.basis?.relayId || '')));
        this.detail.append(p);
      }
      for(const d of r.details || []) {
        const p=n('p','仕様：');p.append(file(d.path),n('span',' ('+d.status+')'));this.detail.append(p);
      }
      this.detail.append(n('h4','承認で起きること'),n('p','タスク'+block.tasks.length+'件を登録し、各担当へ着手指示を送ります。差分の適用は行いません。'));
      const ul=n('ul');
      for(const t of block.tasks) {
        const prereq=(t.after || []).map(key=>block.tasks.find(x=>x.key===key)?.title || key);
        const when=prereq.length ? '前提「'+prereq.join('」「')+'」がすべて完了（done）した後' : '承認後';
        const li=n('li',this.agentName(t.agent)+'：'+t.title+' — '+when+'に着手指示を送ります。');
        li.append(list(t.scope));ul.append(li);
      }
      this.detail.append(ul,n('p','自動応答・認証・予算の条件で送信が保留される場合があります。結果の到着（returned）では前提完了になりません。後続の指示送信は今回の承認に含まれます。'));
      this.control(e,'この内容で着手を承認','approve',()=>this.perform(e,'approve'));
    }
    renderQuestion(e) {
      const form=n('form');const fields=n('fieldset');
      fields.append(n('legend','回答する選択肢を選んでください'));
      const inputs=[];
      for(const q of e.snapshot.block.questions) {
        const label=n('label',q.text), s=n('select',null,{'aria-label':q.text});
        s.append(n('option','選択してください',{value:''}));
        for(const o of q.options) s.append(n('option',o.label+(q.recommended===o.id ? '（おすすめ）':''),{value:o.id}));
        s.append(n('option','その他（自由記述）',{value:'__other'}),n('option','あとで答える',{value:'__defer'}));
        const explain=list(q.options.map(o=>o.label+'：'+o.effect));
        const otherLabel=n('label','その他の回答'), other=n('textarea',null,{maxlength:'2000','aria-label':q.text+'：その他の回答'});
        otherLabel.append(other);otherLabel.hidden=true;
        s.addEventListener('change',()=>{otherLabel.hidden=s.value!=='__other';});
        label.append(s);fields.append(label,explain,otherLabel);inputs.push({q,s,other});
      }
      fields.append(n('p','一部だけ「あとで答える」を選ぶと、その問は保留として記録され、この依頼は回答済みになります。全問を保留にすると「あ とで」へ退避します。'.replace('あ とで','あとで')));
      const submit=n('button','回答を送る',{type:'submit'});fields.append(submit);form.append(fields);
      form.addEventListener('submit',event=>{
        event.preventDefault(); if(!this.can(e,'answer')) return;
        const answers=[];
        for(const {q,s,other} of inputs) {
          if(!s.value) {e.notice.textContent='すべての質問で選択肢を選んでください。';return;}
          const a={questionId:q.id,optionId:s.value};
          if(s.value==='__other') {
            if(!other.value.trim()) {e.notice.textContent='その他の回答を入力してください。';return;}
            a.text=other.value.trim();
          }
          answers.push(a);
        }
        this.perform(e,'answer',{answers});
      });
      e.controls.push({element:fields,action:'answer'});this.detail.append(form);
    }
    renderRelations(e) {
      const r=e.snapshot;
      if(r.supersededBy) this.detail.append(b('置換先を確認',()=>this.select(r.supersededBy)));
      if(!r.replaces) return;
      this.detail.append(b('以前の依頼を確認',()=>this.select(r.replaces)));
      const old=this.view.requests[r.replaces];
      if(!old) {this.detail.append(n('p','以前の依頼を取得できないため、項目差分を表示できません。'));return;}
      const d=n('details');d.append(n('summary','以前の依頼との項目差分'));
      const labels={title:'件名',outcome:'できること',scope:'範囲',outOfScope:'範囲外',tasks:'担当と順序',baseCommit:'基点',questions:'質問',basis:'合意の根拠',details:'仕様',dependsOn:'依存',exclude:'除外'};
      for(const [key,label] of Object.entries(labels)) if(JSON.stringify(old.block[key])!==JSON.stringify(r.block[key])) {
        d.append(n('h4',label),n('pre','以前：'+JSON.stringify(old.block[key] ?? null,null,2)+'\n今回：'+JSON.stringify(r.block[key] ?? null,null,2)));
      }
      this.detail.append(d);
    }
    renderPlan(e) {
      if(!e.planRoot) return;
      e.planRoot.replaceChildren();
      e.controls=e.controls.filter(c=>c.action!=='retry');
      const entries=e.latest.plan?.entries; if(!entries) return;
      e.planRoot.append(n('h4','承認済み計画の送信状況'));
      for(const entry of entries) {
        const line=n('section',null,{class:'tray-plan-entry'});
        line.append(n('p',this.agentName(entry.agent)+' · '+entry.key+'：'+(SEND[entry.send] || entry.send)));
        if(entry.taskId) line.append(b('タスクを表示',()=>{this.dialog.close();this.onTask(entry.taskId);}));
        else line.append(n('p','タスク未作成'));
        if(entry.error) line.append(n('p',entry.error));
        if(entry.after?.length) {
          line.append(n('p','前提：'));
          for(const key of entry.after) {
            const parent=entries.find(p=>p.key===key);
            line.append(parent?.taskId ? b(key,()=>{this.dialog.close();this.onTask(parent.taskId);}) : n('span',key));
          }
        }
        if(['failed','ready'].includes(entry.send)) this.control(e,'未送信分を再試行：'+entry.key,'retry',()=>this.perform(e,'plan/retry',{taskKey:entry.key}),line,entry.key);
        e.planRoot.append(line);
      }
    }
    renderActions(e) {
      const r=e.snapshot;
      if(r.status==='pending') this.control(e,'あとで答える','park',()=>this.perform(e,'park'));
      if(r.status==='parked') this.control(e,'判断待ちへ戻す','unpark',()=>this.perform(e,'unpark'));
      for(const [action,title] of [['revision','修正してほしい'],['reject','見送る']]) {
        if(!r.actionable?.[action]) continue;
        const form=n('form'), fields=n('fieldset');fields.append(n('legend',title));
        const options=[];
        for(const [value,label] of Object.entries(TARGETS)) {
          const row=n('label'), input=n('input',null,{type:'checkbox',value});
          row.append(input,n('span',label));fields.append(row);options.push({input,value});
        }
        const label=n('label','補足（その他を選ぶ場合は必須）'),note=n('textarea',null,{maxlength:'2000'});
        label.append(note); fields.append(label);
        const effect=n('p',null,{'aria-live':'polite'});
        const submit=n('button',action==='revision'?'修正を依頼して閉じる':title+'を送る',{type:'submit',class:'small'});
        let selectedMode='proposer';
        const eligible=()=>options.some(x=>x.input.checked && ['scope','assignee'].includes(x.value));
        if(action==='revision') {
          const modes=n('fieldset',null,{class:'tray-revision-mode'});
          modes.append(n('legend','修正の進め方'));
          const choices=[];
          for(const [value,text] of [['proposer','提案者に修正を依頼'],['rediscuss','3人で再検討を開始']]) {
            const row=n('label'),input=n('input',null,{type:'radio',name:'revision-mode-'+r.id,value});
            input.checked=value==='proposer'; row.append(input,n('span',text));modes.append(row);choices.push({input,value});
            input.addEventListener('change',()=>{if(input.checked){selectedMode=value;updateMode();}});
          }
          const updateMode=()=>{
            const available=eligible();modes.hidden=!available;
            if(!available)selectedMode='proposer';
            for(const c of choices){c.input.checked=c.value===selectedMode;c.input.disabled=!available;}
            submit.textContent=selectedMode==='rediscuss'?'質疑を開始して閉じる':'修正を依頼して閉じる';
            effect.textContent=selectedMode==='rediscuss'
              ? '修正内容を全員へ共有し、このトピックの参加者全員で新しい質疑を1本開始します。先手は提案者です。旧合意は履歴に残ります。'
              : '参加者全員へ共有し、提案者へ修正を依頼します。新しい質疑は開始しません。';
          };
          for(const o of options)o.input.addEventListener('change',updateMode);
          updateMode();fields.append(modes);
        } else effect.textContent='参加者全員へ共有します。継続は依頼しません。';
        fields.append(effect,submit);form.append(fields);
        form.addEventListener('submit',event=>{
          event.preventDefault();if(!this.can(e,action)) return;
          const targets=options.filter(x=>x.input.checked).map(x=>x.value),text=note.value.trim();
          if(!targets.length) {e.notice.textContent='対象項目を選択してください。';return;}
          if(targets.includes('other') && !text) {e.notice.textContent='その他の補足を入力してください。';return;}
          // §9.5 accepts note only. Preserve the user's target choices in that note.
          const mode=eligible()?selectedMode:'proposer';
          const body=action==='revision' ? {targets,note:text,mode} : {note:'対象：'+targets.map(t=>TARGETS[t]).join('・')+(text ? '\n'+text:'')};
          if(body.note.length>2000) {e.notice.textContent='対象項目を含めて2000文字以内にしてください。';return;}
          this.perform(e,action,body,{closeOnSuccess:action==='revision'});
        });
        e.controls.push({element:fields,action});this.detail.append(form);
      }
    }
    control(e,title,action,fn,parent=this.detail,taskKey=null) {
      const btn=b(title,()=>{if(this.can(e,action,taskKey)) fn();});
      e.controls.push({element:btn,action,taskKey});parent.append(btn);return btn;
    }
    can(e,action,taskKey=null) {
      if(this.current!==e || e.locked || e.busy || !this.connected || this.inflight.has(e.snapshot.id)) return false;
      const latest=this.view?.requests[e.snapshot.id];
      if(!latest || latest.proposalSha256!==e.snapshot.proposalSha256 || latest.status!==e.snapshot.status) return false;
      if(action==='unpark') return latest.status==='parked'; // v1 supplies no actionable.unpark; server checks the slot.
      if(action==='retry') return latest.plan?.entries.some(x=>x.key===taskKey && ['failed','ready'].includes(x.send)) || false;
      return latest.actionable?.[action]===true;
    }
    syncControls() {
      const e=this.current;if(!e) return;
      for(const c of e.controls) c.element.disabled=!this.can(e,c.action,c.taskKey);
    }
    lock(message) {
      const e=this.current;if(!e) return;
      e.locked=true;e.notice.textContent=message;this.syncControls();
    }
    async perform(e,action,body={},{closeOnSuccess=false}={}) {
      const permission=action==='plan/retry' ? 'retry' : action;
      if(!this.can(e,permission,body.taskKey)) return;
      const id=e.snapshot.id,hash=e.snapshot.proposalSha256;
      e.busy=true;this.inflight.add(id);this.syncControls();e.notice.textContent='送信中…';
      try {
        await request(this.fetcher,'/api/tray/'+encodeURIComponent(id)+'/'+action,{...body,proposalSha256:hash});
        if(this.current!==e) return;
        this.lock('受け付けました。最新の状態を読み込んでいます。');
        if(closeOnSuccess) this.dialog.close();
        await this.refresh();
        // A fresh view is required before offering any further operation.
        if(this.current===e && this.connected) {
          e.notice.textContent='受け付けました。最新の依頼を表示して結果を確認してください。';
        }
      } catch(err) {
        if(this.current!==e) return;
        if(err.code==='stale-proposal') {
          this.lock('表示した版は古くなりました。旧フォームは送信できません。「最新の依頼を表示」で内容を確認し直してください。');
        } else if(err.status===409) {
          this.lock((err.code==='pending-conflict' ? 'このトピックには別の判断待ちがあります。' : err.message)+' 最新の依頼を表示してください。');
          if(err.data?.blockers) e.reasons.replaceChildren(blockers(err.data.blockers));
        } else if(!err.status) {
          this.lock('送信結果を確認できません。再読込して受付状況を確認してください。'+err.message);
        } else {
          e.notice.textContent=err.message;
          for(const problem of err.data?.errors || []) e.notice.append(n('p',problem.message));
        }
      } finally {
        e.busy=false;this.inflight.delete(id);if(this.current===e) this.syncControls();
      }
    }
    downstream(taskId) {
      const result=[];
      for(const r of Object.values(this.view?.requests || {})) {
        const entries=r.plan?.entries || [], parent=entries.find(x=>x.taskId===taskId);
        if(!parent) continue;
        for(const child of entries) if(child.after?.includes(parent.key) && child.send!=='sent') result.push(this.agentName(child.agent)+'「'+child.key+'」');
      }
      return result.length ? '完了にすると、後続 '+result.join('、')+' の前提が一つ揃います。全前提が完了し、送信条件が整うと着手指示を送ります。' : '';
    }
  }
  globalThis.U2ATray={Controller,REASONS,STATUS,SECTIONS,safeFile,request};
})();
