/* Public-release entry copy and controls; execution eligibility stays in the app. */
(function (root) {
  'use strict';
  const NOTICE = '自動応答をONにすると、会話や参照内容がCLI経由で外部サービスへ送信され、契約に応じた利用料金が発生します。';
  function authLabel(agent, authed) {
    if (agent !== 'grok') return '認証状態: 未確認';
    return authed === true ? '認証済み' : authed === false ? '未認証（grok login）' : '確認中';
  }
  function node(tag, text, className) {
    const n = document.createElement(tag);
    if (text) n.textContent = text;
    if (className) n.className = className;
    return n;
  }
  function guide() {
    const d = node('details', '', 'onboarding-guide');
    d.append(node('summary', 'CLIを使うには'));
    d.append(node('p', '手動貼り付けはClaude / CodexのCLIなしで始められます。自動応答には使うエージェントのCLI（claude / codex / grok）の導入とログインが必要です。'));
    d.append(node('p', 'Claude / Codexの認証はこの画面では確認しません。CLI側でログインを確認してから、自動応答をONにしてください。Grokは画面の再確認で状態を確認できます。'));
    d.append(node('p', NOTICE));
    return d;
  }
  function emptyState({agents, flow = false, onManual}) {
    const box = node('div', '', 'empty onboarding-empty');
    box.append(node('p', 'まだ発言がありません'));
    box.append(node('p', flow ? '手動入力欄は列にあるため、ボタンで列表示へ切り替えます。追加した発言はフローにも表示されます。' : '別の画面で得た回答を貼り付けて、会話を始められます。'));
    const buttons = node('div', '', 'onboarding-actions');
    for (const a of agents) {
      const b = node('button', (flow ? a.name + ' — ' : '') + '列で手動入力');
      b.type = 'button'; b.className = 'small'; b.disabled = !a.ready;
      b.setAttribute('aria-label', a.name + 'の列で手動入力');
      b.addEventListener('click', () => { if (!b.disabled) onManual(a.id); });
      buttons.append(b);
      if (!a.ready) buttons.append(node('span', a.name + ': ' + a.auth, 'onboarding-note'));
    }
    const help = node('a', 'CLIの案内', 'onboarding-help'); help.href='#cli-guide';
    help.addEventListener('click', () => {const d=document.getElementById('cli-guide');if(d){d.open=true;d.querySelector('summary')?.focus();}});
    box.append(buttons, help);
    return box;
  }
  root.U2AOnboarding = {NOTICE, authLabel, emptyState, guide};
})(globalThis);
