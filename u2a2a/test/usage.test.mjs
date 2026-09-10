import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateUsage, measuredTokenUsage } from '../lib.mjs';
const meta=(n=1,mode='metered')=>({usage:{inTok:10*n,outTok:2*n,cacheTok:3*n},durationMs:100*n,billing:{mode,usd:0.1*n}});
const msg=(id,m=meta(),more={})=>({id,topicId:'a',author:'claude',meta:m,...more});
function freeze(v){if(v&&typeof v==='object'){Object.freeze(v);Object.values(v).forEach(freeze);}return v;}
test('usage: 四種の保存metaをトピック×エージェントと全体へ集計',()=>{
 const input=freeze({topics:[{id:'a',title:'A',summaryUsage:[{id:'s',agent:'claude',meta:meta(4)}]}],messages:[msg('m')],pool:[{topicId:'b',reviews:[{id:'r',reviewer:'grok',meta:meta(2)}],fixes:[{id:'f',agent:'codex',meta:meta(3,'plan')}]}]});
 const r=aggregateUsage(input);assert.equal(r.total.records,4);assert.equal(r.total.inTok.value,100);assert.equal(r.total.durationMs.value,1000);assert.equal(r.rows.length,3);assert.equal(r.total.billing.plan,1);assert.equal(r.total.usd.unknown,1);assert.ok(Math.abs(r.total.usd.value-0.7)<1e-9);
 assert.equal(r.topics.reduce((n,t)=>n+t.total.inTok.value,0),r.total.inTok.value);assert.equal(r.rows.reduce((n,t)=>n+t.records,0),r.total.records);
 assert.deepEqual(r.total.kinds,{message:1,review:1,fix:1,summary:1});
});
test('usage: メタ欠落は不明、明示の0は既知',()=>{const r=aggregateUsage({messages:[msg('old',null),msg('zero',meta(0))]});assert.equal(r.total.missingMeta,1);for(const key of ['inTok','outTok','cacheTok','durationMs','usd'])assert.deepEqual(r.total[key],{value:0,known:1,unknown:1});});
test('usage: 不正値・部分欠落を加算しない',()=>{const r=aggregateUsage({messages:[msg('bad',{usage:{inTok:-1,outTok:'20',cacheTok:Infinity},durationMs:NaN,billing:{mode:'metered',usd:-1}}),msg('partial',{usage:{inTok:8}})]});assert.deepEqual(r.total.inTok,{value:8,known:1,unknown:1});assert.equal(r.total.outTok.unknown,2);assert.equal(r.total.billing.unknown,2);});
test('usage: unknown・planのUSDは0や旧costUsdへ変換しない',()=>{const r=aggregateUsage({messages:[msg('u',{...meta(),billing:{mode:'unknown',usd:99},costUsd:88}),msg('p',meta(1,'plan'))]});assert.equal(r.total.usd.known,0);assert.equal(r.total.usd.unknown,2);assert.equal(r.total.billing.plan,1);assert.equal(r.total.billing.unknown,1);});
test('usage: 配送・分岐コピー・同じ記録IDを二重計上しない',()=>{const m=msg('root');const r=aggregateUsage({messages:[m,m,...['relay','qa-relay','handoff'].map((delivery,i)=>msg('c'+i,meta(),{provenance:{delivery}})),msg('branch',meta(),{copiedFromMessageId:'deleted'})]});assert.equal(r.total.records,1);assert.equal(r.excluded.delivery,3);assert.equal(r.excluded.branch,1);assert.equal(r.excluded.duplicate,1);});
test('usage: 著者・所属を現在トピックから推測しない',()=>{const r=aggregateUsage({pool:[{reviews:[{id:'r',meta:meta()}],fixes:[{id:'f',agent:'codex',meta:null}]}]});assert.equal(r.rows[0].topicId,null);assert.ok(r.rows.some(r=>r.agent===null));assert.equal(r.total.records,2);});
test('usage: ユーザー・未実施記録を除外し、失敗の実測値は保持',()=>{const r=aggregateUsage({messages:[msg('user',null,{author:'user'}),msg('blocked',null,{blocked:true}),msg('cancel',meta(),{cancelled:true})],pool:[{reviews:[{id:'skip',skipped:true}],fixes:[{id:'error',error:true}]}]});assert.equal(r.excluded.user,1);assert.equal(r.excluded.skipped,2);assert.equal(r.total.records,2);assert.equal(r.total.inTok.value,10);assert.equal(r.total.missingMeta,1);});
test('usage: 過去要約は件数不明として残し、累計USDを重ねて加算しない',()=>{const r=aggregateUsage({topics:[{id:'old',summaryTs:1,summaryCostUsd:99},{id:'partial',summaryUsageLegacyUnknown:true,summaryCostUsd:88,summaryUsage:[{id:'s',meta:meta()}]},{id:'new',summaryUsage:[],summaryUsageLegacyUnknown:false}]});assert.deepEqual(r.legacySummaryTopics,['old','partial']);assert.equal(r.total.records,1);assert.equal(r.total.usd.value,0.1);});
test('usage: 空入力と特殊IDで動き、cacheを入力tokenへ加えない',()=>{assert.equal(aggregateUsage().total.records,0);const r=aggregateUsage({messages:[msg('__proto__',meta(),{topicId:'__proto__',author:'constructor'})]});assert.equal(r.total.inTok.value,10);assert.equal(r.total.cacheTok.value,3);assert.equal(r.rows[0].agent,'constructor');});

test('usage: 履歴保存失敗は実行前のみ除外し、修正後の欠測は残す',()=>{
 const r=aggregateUsage({pool:[{reviews:[{id:'pre-review',historyError:'failed',error:true}],fixes:[
  {id:'cap',skipped:true,error:true},{id:'pre-fix',historyError:'failed',error:true},
  {id:'post-fix',beforeVersionId:'v1',historyError:'failed',error:true},
  {id:'measured',beforeVersionId:'v1',historyError:'failed',meta:meta()},{id:'cli-error',error:true}]}]});
 assert.equal(r.excluded.skipped,3);assert.equal(r.total.records,3);assert.equal(r.total.missingMeta,2);assert.equal(r.total.inTok.value,10);
});
test('usage: Claude/Grok取消の仮0は不明、取得済みusageは保持',()=>{
 const r=aggregateUsage({messages:[msg('claude',{...meta(0,'unknown'),status:'cancelled'}),
  msg('grok',{...meta(0,'unknown'),status:'cancelled'},{author:'grok'}),
  msg('grok-result',{...meta(3),status:'cancelled'},{author:'grok'}),
  msg('codex',{...meta(2,'plan'),status:'cancelled'},{author:'codex'})]});
 for(const key of ['inTok','outTok','cacheTok']) {assert.equal(r.total[key].known,2);assert.equal(r.total[key].unknown,2);}
 assert.equal(r.total.inTok.value,50);assert.equal(r.total.durationMs.known,4);
});
test('usage: トピックはstateのタブ順',()=>{
 const r=aggregateUsage({topics:[{id:'z'},{id:'a'}],messages:[msg('a'),msg('z',meta(),{topicId:'z'})]});
 assert.deepEqual(r.topics.map(t=>t.topicId),['z','a']);
});

test('usage: 上限通知・外部結果と、出所不明の旧発言を区別する',()=>{
 const r=aggregateUsage({messages:[msg('budget',null,{budget:true}),
  msg('task',null,{taskId:'t',provenance:{ingress:'ui'}}),
  msg('sync',null,{provenance:{ingress:'cli-sync'}}),msg('old',null),
  msg('loop',meta(),{provenance:{ingress:'agent-loop'}})]});
 assert.equal(r.excluded.skipped,1);assert.equal(r.excluded.external,2);
 assert.equal(r.total.records,2);assert.equal(r.total.missingMeta,1);
});
test('usage: 未知トピック同士もIDで安定して並ぶ',()=>{
 const r=aggregateUsage({messages:[msg('z',meta(),{topicId:'z'}),msg('a')]});
 assert.deepEqual(r.topics.map(t=>t.topicId),['a','z']);
});
test('usage: フッタと内訳で共有する取消トークンの正規化',()=>{
 for(const value of [null, {status:'cancelled',billing:{mode:'unknown'},usage:meta(0).usage}])
  assert.deepEqual(measuredTokenUsage(value),{});
 for(const mode of ['plan','metered']) {
  const value={...meta(2,mode),status:'cancelled'};
  assert.equal(measuredTokenUsage(value),value.usage);
 }
});
