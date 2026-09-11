/* Contract v2: rendering and explicit UI records only; no local verification policy. */
(() => {
  'use strict';
  const node = (tag, text, attrs = {}) => {
    const n = document.createElement(tag);
    if (text !== null && text !== undefined) n.textContent = String(text);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  };
  const button = (text, fn) => {
    const b = node('button', text, {type: 'button', class: 'small'});
    b.addEventListener('click', fn); return b;
  };
  const field = (parent, title, tag = 'input', attrs = {}) => {
    const label = node('label', title); const input = node(tag, null, attrs);
    label.append(input); parent.append(label); return input;
  };
  const select = (parent, title, choices) => {
    const s = field(parent, title, 'select');
    for (const [value, label] of choices) s.append(node('option', label, {value}));
    return s;
  };
  const text = x => x == null ? '—' : String(x);
  const methodText = m => !m ? '—' : m.type === 'command' ? `${JSON.stringify(m.argv)} (cwd: ${m.cwd})` : m.description;
  const sourceText = s => ({manifest: '申告経路', ui: 'UI経路', server: 'サーバ観測'})[s] || text(s);
  const resultText = s => ({passed: '成功', failed: '失敗', not_run: '未実行', missing: '記録なし'})[s] || text(s);
  function reasonAction(code) {
    if (['check-missing', 'check-stale', 'check-failed', 'check-not-run'].includes(code)) return '対象版と項目を確認し、検証結果を記録してください。';
    if (['test-deleted', 'test-path-unrecognized', 'test-fixtures-only', 'test-candidate-unknown', 'test-config-changed'].includes(code)) return '下の分類操作で扱いを指定してください。';
    if (code === 'log-error') return '履歴の復旧後に再読込してください。';
    if (code === 'base-commit-unverified') return '基点とリポジトリの状態を確認してください。';
    if (['diff-unparsable', 'diff-binary'].includes(code)) return '差分を修正して再提出してください。分類操作では解除できません。';
    if (code.startsWith('evidence-')) return '証跡ファイルと記録した版を確認してください。';
    if (code.startsWith('artifact-') || code.startsWith('manifest-') || ['schema-unsupported', 'subject-unavailable'].includes(code)) return '対象ファイルとmanifestを確認してください。';
    return '詳細を確認して再読込してください。';
  }
  async function request(fetcher, url, body) {
    const response = await fetcher(url, body === undefined ? {cache: 'no-store'} : {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
    });
    let data;
    try { data = await response.json(); } catch { data = {error: '応答をJSONとして読めません。', code: 'invalid-response'}; }
    if (!response.ok || data.code === 'invalid-response') {
      const error = new Error(data.error || '通信に失敗しました。');
      error.status = response.status; error.code = data.code; error.data = data; throw error;
    }
    return data;
  }
  const snapshot = evaluation => ({subjectSha256: evaluation.subject.current,
    requirementsSha256: evaluation.requirements.sha256, policyVersion: evaluation.policyVersion});
  function confirmationBody(evaluation, actor, entries) {
    const checks = entries.filter(x => x.selected).map(({selected, ...check}) => check);
    if (!checks.length) throw new Error('確認する項目を選択してください。');
    if (checks.some(x => !x.result)) throw new Error('選択した項目の結果を指定してください。');
    if (typeof actor !== 'string' || !actor.trim() || actor.trim().length > 80) throw new Error('実施者を1〜80文字で入力してください。');
    return {...snapshot(evaluation), actor: actor.trim(), checks};
  }
  function classificationBody(evaluation, pending, decision, reason, method) {
    if (!pending.allowedDecisions.includes(decision)) throw new Error('許可された分類を選択してください。');
    if (!reason.trim()) throw new Error('分類の理由を入力してください。');
    if (decision === 'test' && !method) throw new Error('テストの確認方法を入力してください。');
    return {subjectSha256: evaluation.subject.current, policyVersion: evaluation.policyVersion,
      path: pending.path, decision, reason, method: decision === 'test' ? method : null};
  }
  class Controller {
    constructor({fetcher = (...args) => fetch(...args)} = {}) { this.fetcher = fetcher; this.current = null; }
    panel(item) {
      let e = this.current;
      if (!e || e.item.id !== item.id) {
        e = {item, root: node('section', null, {class: 'verification-panel', 'aria-label': '成果物の検証'}),
          identity: node('div', null, {class: 'verification-stages'}), content: node('div'), generation: 0,
          fetchedAt: 0, busy: false, dirty: false};
        e.root.append(e.identity, e.content); this.current = e; this.load(e);
      }
      e.item = item;
      const reviews = (item.reviews || []).filter(r => !r.skipped && !r.stopped);
      e.identity.replaceChildren(node('span', `レビュー：記録 ${reviews.length} 件（検証とは独立）`));
      // Keep this DOM node across SSE rerenders. Never discard a draft automatically.
      if (!e.loading && !e.busy && !e.conflict && Date.now() - e.fetchedAt > 15000) {
        if (!e.dirty) this.load(e);
        else {
          const badge = e.content.querySelectorAll('strong')[0];
          if (badge) { badge.textContent = '検証情報：再読込が必要'; badge.setAttribute('data-complete', 'false'); }
          this.notice(e, '入力を保持しています。最新の検証情報を確認するには再読込してください（入力は破棄されます）。');
        }
      }
      return e.root;
    }
    async load(e, discardDraft = false) {
      const generation = ++e.generation; e.loading = true; e.fetchedAt = Date.now();
      if (!e.evaluation) e.content.replaceChildren(node('p', '検証情報を読み込み中…', {'role': 'status'}));
      try {
        const data = await request(this.fetcher, `/api/pool/${encodeURIComponent(e.item.id)}/verification`);
        if (this.current !== e || generation !== e.generation) return;
        if (e.dirty && !discardDraft) {
          // A refresh started before the user began typing. Preserve the draft,
          // but invalidate its display instead of leaving a stale completion badge.
          e.conflict = true;
          const badge = e.content.querySelectorAll('strong')[0];
          if (badge) { badge.textContent = '検証情報：再読込が必要'; badge.setAttribute('data-complete', 'false'); }
          this.notice(e, '検証情報の更新があります。入力を保持しています。再読込して対象版を確認してください。');
          this.lock(e, false);
          return;
        }
        e.evaluation = data; e.conflict = false; e.dirty = false; this.render(e);
      } catch (error) {
        if (this.current !== e || generation !== e.generation) return;
        // A background refresh can fail after input starts. Keep that draft,
        // invalidate the completion display, and require an explicit reload.
        if (e.dirty && !discardDraft && e.evaluation) {
          e.conflict = true;
          const badge = e.content.querySelectorAll('strong')[0];
          if (badge) { badge.textContent = '検証情報：再読込が必要'; badge.setAttribute('data-complete', 'false'); }
          this.notice(e, `検証情報を取得できません：${error.message}。入力を保持しています。再読込して対象版を確認してください。`);
          this.lock(e, false);
          return;
        }
        // Explicit reload discards the draft even on failure. Never retain a
        // green badge or a dirty flag for a form that is no longer displayed.
        e.evaluation = null; e.dirty = false; e.conflict = false; e.notice = null;
        e.content.replaceChildren(node('p', `検証情報を取得できません：${error.message}`, {role: 'alert'}), button('再読込', () => this.load(e, true)));
        this.notice(e, '通信を確認して再読込してください。');
      } finally { if (generation === e.generation) e.loading = false; }
    }
    notice(e, message) {
      if (!e.notice || e.notice.parentElement !== e.content) {
        e.notice = node('p', '', {role: 'status', 'aria-live': 'polite', class: 'verification-notice'});
        e.content.append(e.notice);
      }
      e.notice.textContent = message;
    }
    lock(e, locked) {
      e.busy = locked;
      for (const b of e.content.querySelectorAll('button')) b.disabled = locked;
      for (const f of e.content.querySelectorAll('fieldset')) f.disabled = locked || e.conflict || !e.evaluation?.subject?.current || !e.evaluation?.requirements?.sha256 || !e.evaluation?.log?.ok;
    }
    async mutate(e, action, body) {
      if (e.busy || e.conflict || this.current !== e) return;
      ++e.generation; e.loading = false; this.lock(e, true);
      try {
        const data = await request(this.fetcher, `/api/pool/${encodeURIComponent(e.item.id)}/verification/${action}`, body);
        if (this.current !== e) return;
        e.evaluation = data.evaluation; e.fetchedAt = Date.now(); e.dirty = false; this.render(e);
        const rejected = data.rejected || [];
        const summary = action === 'import'
          ? `取込結果：受理 ${data.added} 件／重複 ${data.duplicates} 件／拒否 ${rejected.length} 件。`
          : '記録を受け付けました。表示対象の版で再評価しています。';
        this.notice(e, [summary, ...rejected.map(r => `${r.id || 'manifest'} / ${r.code}: ${r.message}`)].join('\n'));
      } catch (error) {
        if (this.current !== e) return;
        if (error.status === 409 && error.code === 'version-conflict') {
          e.conflict = true;
          // Leave the old displayed tokens and form intact; require an explicit reload.
          this.notice(e, '表示後に版または必須項目が変わりました。再読込して内容を確認し、改めて入力してください。');
        } else if (['not-classifiable', 'decision-not-allowed'].includes(error.code)) {
          e.conflict = true; this.notice(e, '分類の候補が変わりました。再読込してください。');
        } else {
          const details = (error.data?.errors || []).map(x => `${x.pointer}: ${x.message}`).join('\n');
          this.notice(e, `${text(error.code)}：${error.message}${details ? '\n' + details : ''}`);
        }
      } finally { if (this.current === e) this.lock(e, false); }
    }
    render(e) {
      const v = e.evaluation; e.content.replaceChildren(); e.notice = null;
      if (!v.applicable) { e.content.append(node('p', '検証：対象外（impl manifestなし）')); return; }
      const badge = node('strong', v.aggregate.label, {class: 'verification-aggregate',
        'data-status': v.aggregate.status, 'data-complete': String(v.aggregate.complete === true)});
      e.content.append(badge);
      e.content.append(node('p', `対象版：${text(v.subject.current)}\n必須項目集合：${text(v.requirements.sha256)}\n基点：${text(v.baseCommit.value)}`, {class: 'verification-hashes'}));
      e.notice = node('p', '', {role: 'status', 'aria-live': 'polite', class: 'verification-notice'});
      e.content.append(e.notice);
      const controls = node('div', null, {class: 'actions'});
      controls.append(button('再読込', () => { if (!e.busy) this.load(e, true); }), button('manifestの申告を取り込む', () => this.mutate(e, 'import', {})));
      e.content.append(controls);
      const reasons = node('ul');
      for (const r of v.aggregate.reasons || []) reasons.append(node('li', `${r.code}${r.target ? ' [' + r.target + ']' : ''}：${r.message}\n${reasonAction(r.code)}`));
      e.content.append(reasons);
      for (const error of v.manifest.errors || []) e.content.append(node('p', `${error.pointer}：${error.message}`));
      for (const c of v.checks) {
        const row = node('div', null, {class: 'verification-check'});
        row.append(node('strong', `${c.id}（${c.required ? '必須' : '任意'}）：${resultText(c.effective)}`));
        if (c.latest) row.append(node('p', `#${c.latest.seq} / ${sourceText(c.latest.source)} / ${c.latest.actor}\n${methodText(c.latest.method)}\n実施：${text(c.latest.executedAt)} / 受理：${c.latest.receivedAt}\n証跡：${text(c.latest.evidence?.path)} (${text(c.latest.evidenceStatus)})`));
        for (const code of c.reasons || []) row.append(node('p', `${code}：${reasonAction(code)}`));
        e.content.append(row);
      }
      if (v.preview.length) {
        const preview = node('details'); preview.append(node('summary', 'manifestの申告（取込状況）'));
        for (const p of v.preview) preview.append(node('p', `${p.index + 1}. ${p.id} / ${resultText(p.result)} / ${{accepted: '取込記録あり', acceptable: '未取込', rejected: '取込不可'}[p.status]}${p.code ? ' / ' + p.code : ''}`));
        e.content.append(preview);
      }
      const canWrite = !!(v.subject.current && v.requirements.sha256 && v.log.ok);
      this.confirmation(e, v, canWrite);
      this.classifications(e, v, canWrite);
      this.history(e, v);
    }
    methodFields(parent) {
      const mode = select(parent, '確認方法', [['manual', '手動確認の記録'], ['command', 'コマンド実行の記録']]);
      const manual = field(parent, '具体的な確認内容', 'textarea', {rows: 2});
      const command = node('div'); parent.append(command);
      const argv = field(command, 'argv（JSON配列。実行はしません）', 'textarea', {rows: 2});
      const cwd = field(command, '作業位置（リポジトリ相対）'); cwd.value = '.';
      const toggle = () => { command.hidden = mode.value !== 'command'; manual.parentElement.hidden = mode.value !== 'manual'; };
      mode.addEventListener('change', toggle); toggle();
      return () => {
        if (mode.value === 'manual') {
          if (!manual.value.trim()) throw new Error('具体的な確認内容を入力してください。');
          return {type: 'manual', description: manual.value.trim()};
        }
        let args; try { args = JSON.parse(argv.value); } catch { throw new Error('argvをJSON配列で入力してください。'); }
        if (!Array.isArray(args) || !args.length || args.some(a => typeof a !== 'string' || !a.length)) throw new Error('argvは空でない文字列を1つ以上含むJSON配列で入力してください。');
        // Input assistance only. The server remains authoritative for schema validation.
        return {type: 'command', argv: args, cwd: cwd.value};
      };
    }
    confirmation(e, v, canWrite) {
      const details = node('details'); details.append(node('summary', '項目の確認結果を記録する（UI経路）'));
      const form = node('form'); const group = node('fieldset'); group.disabled = !canWrite;
      const actor = field(group, '実施者（申告名）', 'input', {maxlength: 80}); actor.value = 'user';
      group.append(node('p', '選択した項目だけを記録します。成功・失敗・未実行を自動選択しません。'));
      const inputs = v.checks.map(c => {
        const row = node('div', null, {class: 'verification-check'}); group.append(row);
        const pick = field(row, `${c.id}（${c.required ? '必須' : '任意'}）を記録`, 'input', {type: 'checkbox'});
        const targets = v.requirements.items.find(x => x.id === c.id)?.targets || [];
        row.append(node('p', targets.join('\n')));
        const result = select(row, '結果', [['', '選択してください'], ['passed', '成功'], ['failed', '失敗'], ['not_run', '未実行']]);
        const getMethod = this.methodFields(row);
        const evidencePath = field(row, '証跡パス（impl相対。手動確認では任意）');
        const evidenceSha = field(row, '証跡SHA-256');
        const executedAt = field(row, '実施日時（UTC。空欄は受理日時、未実行は記録しません）', 'input', {placeholder: '2026-09-11T12:34:56Z'});
        const reason = field(row, '理由（未実行では必須）', 'textarea', {rows: 2, maxlength: 2000});
        return () => {
          if (!pick.checked) return {selected: false};
          if (!result.value) throw new Error(`${c.id} の結果を選択してください。`);
          if (result.value === 'not_run' && !reason.value.trim()) throw new Error(`${c.id} の未実行理由を入力してください。`);
          const timestamp = result.value === 'not_run' ? null : executedAt.value.trim() || null;
          if (timestamp !== null) {
            const date = new Date(timestamp);
            if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(timestamp) ||
                !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== timestamp.slice(0, 19)) throw new Error(`${c.id} の実施日時を実在するUTC日時で入力してください（例：2026-09-11T12:34:56Z）。`);
          }
          const method = getMethod();
          if (result.value !== 'not_run' && method.type === 'command' && (!evidencePath.value || !evidenceSha.value)) throw new Error(`${c.id} のコマンド実行には証跡が必要です。`);
          return {selected: true, id: c.id, result: result.value, method,
            executedAt: timestamp,
            evidence: evidencePath.value || evidenceSha.value ? {path: evidencePath.value, sha256: evidenceSha.value} : null,
            reason: reason.value.trim() || null};
        };
      });
      group.append(node('button', '選択した項目を記録', {type: 'submit', class: 'small'}));
      form.append(group); details.append(form); e.content.append(details);
      form.addEventListener('input', () => { e.dirty = true; });
      form.addEventListener('change', () => { e.dirty = true; });
      form.addEventListener('submit', event => {
        event.preventDefault(); if (!canWrite || e.conflict || e.busy) return;
        try { this.mutate(e, 'confirm', confirmationBody(v, actor.value, inputs.map(read => read()))); }
        catch (error) { this.notice(e, error.message); }
      });
    }
    classifications(e, v, canWrite) {
      if (!v.requirements.pending.length) return;
      const details = node('details'); details.append(node('summary', '保留項目を分類する'));
      for (const pending of v.requirements.pending) {
        const form = node('form'); const group = node('fieldset'); group.disabled = !canWrite;
        group.append(node('legend', pending.path), node('p', pending.code));
        if (!pending.allowedDecisions.length) {
          group.append(node('p', 'この項目は分類で解除できません。差分または環境を修正してください。'));
        } else {
          const labels = {test: 'テストとして扱う', 'not-test': 'テストではない', 'deletion-accepted': '削除を認める'};
          const decision = select(group, '分類', [['', '選択してください'], ...pending.allowedDecisions.map(d => [d, labels[d] || d])]);
          const reason = field(group, '理由', 'textarea', {maxlength: 2000});
          const methodBox = node('div'); group.append(methodBox); const readMethod = this.methodFields(methodBox);
          const toggle = () => { methodBox.hidden = decision.value !== 'test'; };
          decision.addEventListener('change', toggle); toggle();
          group.append(node('button', 'この分類を記録', {type: 'submit', class: 'small'}));
          form.addEventListener('submit', event => {
            event.preventDefault(); if (!canWrite || e.conflict || e.busy) return;
            try { this.mutate(e, 'classify', classificationBody(v, pending, decision.value, reason.value, decision.value === 'test' ? readMethod() : null)); }
            catch (error) { this.notice(e, error.message); }
          });
        }
        form.addEventListener('input', () => { e.dirty = true; });
        form.addEventListener('change', () => { e.dirty = true; });
        form.append(group); details.append(form);
      }
      e.content.append(details);
    }
    history(e, v) {
      const details = node('details'); details.append(node('summary', '検証・分類の受理履歴'));
      const all = field(details, '同じプロジェクトの過去版も表示', 'input', {type: 'checkbox'});
      const list = node('div'); details.append(list);
      let cursor = 0, generation = 0, loaded = false, busy = false;
      const more = button('続きを読み込む', () => load(false)); details.append(more); more.hidden = true;
      const load = async reset => {
        if (busy && !reset) return;
        if (reset) { cursor = 0; list.replaceChildren(); }
        const mine = ++generation; busy = true; more.disabled = true;
        const query = new URLSearchParams({projectKey: v.projectKey, afterSeq: String(cursor), limit: '100'});
        if (!all.checked && v.subject.current) query.set('subjectSha256', v.subject.current);
        try {
          const data = await request(this.fetcher, '/api/verification/history?' + query);
          if (mine !== generation || this.current !== e || e.evaluation !== v) return;
          if (!data.log.ok) list.append(node('p', '履歴の一部を読めません。完全な履歴ではありません。', {role: 'alert'}));
          if (!data.records.length && !cursor) list.append(node('p', '受理記録はありません。'));
          for (const record of data.records) {
            const r = node('details'); const p = record.payload;
            r.append(node('summary', `#${record.seq} ${sourceText(record.source)} / ${record.type === 'check' ? p.id + '：' + resultText(p.result) : p.path + '：' + p.decision}`));
            r.append(node('pre', JSON.stringify(record, null, 2))); list.append(r);
          }
          cursor = data.nextAfterSeq; more.hidden = cursor === null; loaded = true;
        } catch (error) {
          if (mine === generation && this.current === e && e.evaluation === v) {
            list.append(node('p', `履歴取得失敗：${error.message}`, {role: 'alert'})); more.hidden = false;
          }
        } finally { if (mine === generation) { busy = false; more.disabled = false; } }
      };
      all.addEventListener('change', () => load(true));
      details.addEventListener('toggle', () => { if (details.open && !loaded && !busy) load(true); });
      e.content.append(details);
    }
  }
  globalThis.U2AVerification = {Controller, confirmationBody, classificationBody, reasonAction, request};
})();
