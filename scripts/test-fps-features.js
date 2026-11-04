'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const vm=require('node:vm');
const {MAP}=require('../src/server/config/map');
const {WEAPONS}=require('../src/server/config/catalog');
const rigSource=fs.readFileSync(path.join(__dirname,'../public/js/fps-weapons.js'),'utf8');
const sandbox={window:{},Math};vm.runInNewContext(rigSource,sandbox);
const rigs=sandbox.window.ProjectCGWeaponRig;
assert.equal(Object.keys(rigs.CONFIG).length,Object.keys(WEAPONS).length,'missing unique weapon rig');
for(const weapon of Object.values(WEAPONS)){
 const r=rigs.CONFIG[weapon.id];assert(r,weapon.id+' has no animation');
 assert.equal(r.keys[0].t,0);assert.equal(r.keys.at(-1).t,1);
 assert(r.keys.length>=7,'too few weapon-specific reload keyframes');
 assert(r.keys.every((v,i)=>!i||v.t>r.keys[i-1].t),'out-of-order keyframes '+weapon.id);
 assert(weapon.reloadMs>600&&weapon.reloadMs<5000,'invalid server reload timing');
 const poses=[0.25,0.4,0.7,0.82].map(x=>rigs.pose(weapon.id,x));
 assert(poses.some(p=>Math.abs(p.tilt)>0.02),'weapon never moves: '+weapon.id);
 assert(poses.some(p=>Math.abs(p.hand)>1),'hand never animates: '+weapon.id);
 if(weapon.id==='shotgun')assert(r.shellFeed&&weapon.reloadMode==='shell');
 else assert(!r.shellFeed&&weapon.reloadMode==='magazine');
}
assert(MAP.structures.length>=280,'missing new building complexes');
assert(MAP.structures.filter(x=>x.levels===2).length>=45,'missing multi-storeys');
assert(MAP.obstacles.filter(x=>x.kind==='tree').length>=800,'missing physically authoritative trees');
for(const b of MAP.structures){
 const px=b.x+b.w/2,py=b.y+11;
 const blocking=MAP.obstacles.filter(o=>o.structureId===b.id&&px>=o.x&&px<=o.x+o.w&&py>=o.y&&py<=o.y+o.h);
 assert.equal(blocking.length,0,'front door closed '+b.id);
 if(b.levels===2){assert(b.stair,'missing stair '+b.id);assert(b.stair.x>b.x&&b.stair.x+b.stair.w<b.x+b.w,'invalid stair footprint');}
}
console.log(`FPS v3.1 features: OK (${MAP.structures.length} interiors, ${MAP.structures.filter(x=>x.levels===2).length} two-storey, ${MAP.obstacles.filter(x=>x.kind==='tree').length} trees, ${Object.keys(WEAPONS).length} reload rigs)`);
