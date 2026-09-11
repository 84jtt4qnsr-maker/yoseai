#!/usr/bin/env node
// Contract v2: shared module owns schema, hashes and filesystem validation.
/* Delivery / integration notes (API contract v2; policyVersion remains 1).
 * This is a full patch against fab20db32603ce0feed34a7131261118dae14ab4.
 * Run at that repository root:
 * git apply --check u2a2a/pool/topics/9a299f1bac1a09fb/impl-codex12/verification-ui.diff
 * git apply u2a2a/pool/topics/9a299f1bac1a09fb/impl-codex12/verification-ui.diff
 *
 * If v1 is already applied, rehearse in an isolated copy of the CURRENT tree:
 * git apply -R --check u2a2a/pool/.versions/c73af4b3d9e2d1dc/v1.diff
 * git apply -R u2a2a/pool/.versions/c73af4b3d9e2d1dc/v1.diff
 * Then run the two commands above. Stop on any failure; retain the original
 * tree until the entire upgrade succeeds and its diff is reviewed. Never
 * overwrite the host index.html with the old attachment or reset other work.
 * The shared verification.mjs and server API are separate prerequisites.
 *
 * This revision edits ONLY verification-ui.diff, as requested. Adjacent
 * manifest/APPLY/TAP/full-file attachments still describe v1 and must NOT be
 * used as evidence for this revision. Package acceptance remains unresolved.
 * A later authorized package update must hash the final diff bytes, derive
 * subject/requirements using verification.mjs, rerun checks, replace evidence,
 * and regenerate APPLY. Do not reuse v1 passed claims or placeholder argv.
 * Reproduce UI/CLI tests after applying the patch:
 * node --test u2a2a/test/verification-ui.test.mjs u2a2a/test/render-apply.test.mjs
 * Then check synchronized metadata using the real shared module:
 * node u2a2a/tools/render-apply.mjs u2a2a/pool/topics/9a299f1bac1a09fb/impl-codex12 --check
 * Real browser and server acceptance checks remain not_run for this revision.
 */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readImplFolder, computeSubjectSha256, normalizeCheck} from '../verification.mjs';

export const BLOCKS = ['artifacts', 'checks'];
export const marker = (name, edge) => `<!-- verification:${name}:${edge} -->`;
export function markdown(value) {
  return String(value ?? '—').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\r\n|\r|\n/g, '<br>').replace(/\|/g, '&#124;').replace(/`/g, '&#96;')
    .replace(/\\/g, '&#92;').replace(/\*/g, '&#42;').replace(/_/g, '&#95;')
    .replace(/\[/g, '&#91;').replace(/\]/g, '&#93;');
}
const table = (headers, rows) => [headers, headers.map(() => '---'), ...rows]
  .map(row => '| ' + row.map(markdown).join(' | ') + ' |').join('\n');
const methodText = m => m.type === 'command' ? `${JSON.stringify(m.argv)} (cwd: ${m.cwd})` : m.description;

export function buildBlocks(folder) {
  if (!folder.manifest.ok) throw new Error(folder.manifest.errors.map(e => `${e.pointer}: ${e.message}`).join('\n'));
  const problems = folder.artifacts.filter(a => a.status !== 'ok');
  if (problems.length) throw new Error(problems.map(a => `${a.path}: ${a.status}`).join('\n'));
  if (!folder.currentSubjectSha256) throw new Error('対象版を計算できません。');
  const m = folder.manifest.manifest;
  const actual = folder.artifacts.map(a => ({path: a.path, role: a.role, sha256: a.actualSha256}));
  const subject = computeSubjectSha256({baseCommit: m.baseCommit, artifacts: actual});
  const artifacts = [...actual].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return {
    artifacts: `基点コミット: ${markdown(m.baseCommit)}\n\n対象版 SHA-256: ${subject}\n\n` +
      table(['対象ファイル（impl相対）', '役割', 'SHA-256'], artifacts.map(a => [a.path, a.role, a.sha256])),
    checks: '以下は manifest の申告表です。受理履歴・現行の充足判定・UI経路の確認はサーバ表示を参照してください。\n\n' +
      table(['項目', '対象版 SHA-256', '必須集合 SHA-256 / policy', '実施者', '方法', '結果（申告）', '実施日時', '証跡 / SHA-256', '理由'],
        m.checks.map(normalizeCheck).map(c => [c.id, c.subjectSha256, `${c.requirementsSha256} / ${c.policyVersion}`, c.actor,
          methodText(c.method), c.result, c.executedAt, c.evidence ? `${c.evidence.path} / ${c.evidence.sha256}` : null, c.reason])),
  };
}
export function updateApply(original, blocks) {
  // Reject duplicate, missing or overlapping markers before changing any bytes.
  const tokens = [...original.matchAll(/<!-- verification:(artifacts|checks):(start|end) -->/g)];
  const counts = new Map(); let open = null;
  for (const [, name, edge] of tokens) {
    const key = `${name}:${edge}`; counts.set(key, (counts.get(key) || 0) + 1);
    if (counts.get(key) !== 1) throw new Error(`マーカーが重複しています: ${key}`);
    if (edge === 'start') { if (open) throw new Error('生成ブロックが重なっています。'); open = name; }
    else { if (open !== name) throw new Error('マーカーの対応・順序が不正です。'); open = null; }
  }
  if (open) throw new Error('終了マーカーがありません。');
  let result = original;
  for (const name of BLOCKS) {
    const start = marker(name, 'start'), end = marker(name, 'end');
    const replacement = `${start}\n${blocks[name]}\n${end}`;
    const a = result.indexOf(start), b = result.indexOf(end);
    if (a === -1 && b === -1) result += `${result.length && !result.endsWith('\n') ? '\n' : ''}\n${replacement}\n`;
    else if (a === -1 || b === -1 || b < a) throw new Error(`マーカーが不完全です: ${name}`);
    else result = result.slice(0, a) + replacement + result.slice(b + end.length);
  }
  return result;
}
export function renderApply(implDir, {check = false} = {}) {
  const dir = fs.realpathSync(implDir), target = path.join(dir, 'APPLY.md');
  if (fs.existsSync(target) && (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink())) throw new Error('APPLY.md は通常ファイルである必要があります。');
  // Also reject dangling symlinks (existsSync follows links).
  try { if (fs.lstatSync(target).isSymbolicLink()) throw new Error('APPLY.md のシンボリックリンクは使用できません。'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const original = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  const generated = updateApply(original, buildBlocks(readImplFolder(dir)));
  const changed = original !== generated;
  if (!check && changed) fs.writeFileSync(target, generated, 'utf8');
  return {changed, target};
}
export function main(args = process.argv.slice(2)) {
  const check = args.includes('--check');
  const paths = args.filter(a => a !== '--check');
  if (paths.length !== 1 || paths[0].startsWith('--') || args.filter(a => a === '--check').length > 1) {
    console.error('Usage: node u2a2a/tools/render-apply.mjs <impl-folder> [--check]'); return 2;
  }
  try {
    const result = renderApply(paths[0], {check});
    console.log(check ? result.changed ? 'APPLY生成表が現在のmanifestと一致しません。' : 'APPLY生成表は一致しています。' : result.changed ? 'APPLY生成表を更新しました。' : '変更はありません。');
    return check && result.changed ? 1 : 0;
  } catch (error) { console.error(error.message); return 2; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
