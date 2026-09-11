#!/usr/bin/env node
// Reanalyze an actual DOM snapshot exported by the flow's 「空きを計測」 button.
// No browser, server, network, messages or production writes are involved.
import fs from 'node:fs';
import vm from 'node:vm';
if(!process.argv[2]){
  console.error('Usage: node u2a2a/tools/measure-avatar-space.mjs snapshot.json [grid-step=8] > report.json');
  process.exitCode=1;
}else{
  const snapshot=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  const context=vm.createContext({});
  vm.runInContext(fs.readFileSync(new URL('../public/avatars.js',import.meta.url),'utf8'),context);
  const homes=snapshot.homes||[];
  if(!Array.isArray(homes)||homes.length>3||homes.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)))throw Error('Expected up to three finite home coordinates');
  const analysis=context.U2AAvatar.analyzeSpace(snapshot.geometry,homes,Number(process.argv[3]||8));
  console.log(JSON.stringify({topicId:snapshot.topicId??null,capturedAt:snapshot.timestamp??null,viewport:snapshot.viewport??null,analysis},null,2));
}
