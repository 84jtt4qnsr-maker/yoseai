import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Contract v2 boundary mock. We deliberately do not reimplement the shared schema,
// hashing or filesystem checks. The real shared module is integrated separately.
const dependencySource = `import fs from 'node:fs'; import path from 'node:path';
export const calls=[];
export function readImplFolder(dir){calls.push(['read',dir]);return JSON.parse(fs.readFileSync(path.join(dir,'folder-fixture.json'),'utf8'));}
export function computeSubjectSha256(x){calls.push(['subject',x]);return 'd'.repeat(64);}
export function normalizeCheck(x){calls.push(['normalize',x]);return {...x,reason:x.reason??null};}`;
const depUrl='data:text/javascript;base64,'+Buffer.from(dependencySource).toString('base64');
const src=fs.readFileSync(new URL('../tools/render-apply.mjs',import.meta.url),'utf8');
assert.match(src,/from '\.\.\/verification\.mjs'/);
const cli=await import('data:text/javascript;base64,'+Buffer.from(src.replace("'../verification.mjs'",JSON.stringify(depUrl))).toString('base64'));
const dependency=await import(depUrl);
const fixture=()=>({manifest:{ok:true,manifest:{baseCommit:'a'.repeat(40),artifacts:[{path:'change.diff',role:'patch',sha256:'b'.repeat(64)}],checks:[{
 id:'apply',subjectSha256:'d'.repeat(64),requirementsSha256:'e'.repeat(64),policyVersion:1,actor:'codex',
 method:{type:'manual',description:'literal <script> | `code`\nnext'},result:'not_run',executedAt:null,evidence:null,reason:'shared module pending'}]}},
 artifacts:[{path:'change.diff',role:'patch',actualSha256:'b'.repeat(64),declaredSha256:'b'.repeat(64),status:'ok'}],currentSubjectSha256:'d'.repeat(64)});
const makeDir=t=>{const dir=fs.mkdtempSync(path.join(process.env.U2A2A_TEST_TMPDIR || os.tmpdir(),'render-apply-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};

test('generation delegates schema IO and hashes to contract imports using actual bytes hashes',()=>{
 dependency.calls.length=0;const blocks=cli.buildBlocks(fixture());
 assert.equal(dependency.calls[0][0],'subject');assert.equal(dependency.calls[0][1].artifacts[0].sha256,'b'.repeat(64));
 assert.equal(dependency.calls[1][0],'normalize');assert.match(blocks.artifacts,/d{64}/);assert.match(blocks.checks,/not&#95;run/);
 assert.match(blocks.checks,/申告表/);assert.doesNotMatch(blocks.checks,/検証完了/);
});
test('escapes markdown HTML pipes newlines links and command literals',()=>{
 const out=cli.buildBlocks(fixture()).checks;
 assert.match(out,/&lt;script&gt; &#124; &#96;code&#96;<br>next/);
 assert.equal(cli.markdown('[x](javascript:test)'), '&#91;x&#93;(javascript:test)');
});
test('two blocks are idempotent and preserve hand-written preface and suffix',()=>{
 const blocks=cli.buildBlocks(fixture());
 const before='# Description\nDo not change this.\n'+cli.marker('artifacts','start')+'\nold\n'+cli.marker('artifacts','end')+'\nMiddle prose\n'+cli.marker('checks','start')+'\nold\n'+cli.marker('checks','end')+'\nEND without newline';
 const after=cli.updateApply(before,blocks);assert.equal(cli.updateApply(after,blocks),after);
 assert.ok(after.startsWith('# Description\nDo not change this.\n'));assert.ok(after.endsWith('\nEND without newline'));assert.match(after,/Middle prose/);
});
test('appends missing blocks once including empty original',()=>{
 for(const before of ['', '# Notes', '# Notes\n']){
 const out=cli.updateApply(before,{artifacts:'A',checks:'C'});assert.equal(cli.updateApply(out,{artifacts:'A',checks:'C'}),out);
 assert.equal(out.split(cli.marker('artifacts','start')).length,2);assert.equal(out.split(cli.marker('checks','end')).length,2);
 }
});
test('rejects duplicate partial reversed and overlapping markers',()=>{
 const a=cli.marker('artifacts','start'),b=cli.marker('artifacts','end'),c=cli.marker('checks','start'),d=cli.marker('checks','end');
 for(const before of [a,b,b+a,a+a+b,a+c+b+d])assert.throws(()=>cli.updateApply(before,{artifacts:'A',checks:'C'}));
});
test('--check is read-only; normal generation updates only tables',t=>{
 const dir=makeDir(t);fs.writeFileSync(path.join(dir,'folder-fixture.json'),JSON.stringify(fixture()));
 const target=path.join(dir,'APPLY.md');fs.writeFileSync(target,'Original notes');
 assert.equal(cli.renderApply(dir,{check:true}).changed,true);assert.equal(fs.readFileSync(target,'utf8'),'Original notes');
 assert.equal(cli.renderApply(dir).changed,true);assert.equal(cli.renderApply(dir,{check:true}).changed,false);
 assert.equal(cli.main([dir,'--check']),0);assert.equal(cli.main(['--unknown']),2);
});
test('CLI refuses invalid schema and artifact mismatch without touching APPLY',t=>{
 const dir=makeDir(t),target=path.join(dir,'APPLY.md');fs.writeFileSync(target,'keep');
 const f=fixture();f.artifacts[0].status='mismatch';fs.writeFileSync(path.join(dir,'folder-fixture.json'),JSON.stringify(f));
 assert.throws(()=>cli.renderApply(dir),/mismatch/);assert.equal(fs.readFileSync(target,'utf8'),'keep');
 f.manifest={ok:false,errors:[{pointer:'/checks',message:'bad'}]};fs.writeFileSync(path.join(dir,'folder-fixture.json'),JSON.stringify(f));
 assert.throws(()=>cli.renderApply(dir),/checks: bad/);assert.equal(fs.readFileSync(target,'utf8'),'keep');
});
test('CLI refuses APPLY symlink including dangling link',t=>{
 const dir=makeDir(t);fs.symlinkSync('missing-file',path.join(dir,'APPLY.md'));assert.throws(()=>cli.renderApply(dir),/リンク/);
});
