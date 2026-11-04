'use strict';
// Smoke-test the procedural 3D renderer without relying on a physical GPU.
const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../public/js/fps3d.js'),'utf8');
let draws=0,instances=0,uploads=0;
const fakeGl=new Proxy({
  createShader:()=>({}),createProgram:()=>({}),createVertexArray:()=>({}),
  createBuffer:()=>({}),getUniformLocation:()=>({}),
  getShaderParameter:()=>true,getProgramParameter:()=>true,
  getShaderInfoLog:()=>'',getProgramInfoLog:()=>'', 
  drawArraysInstanced:(mode,first,count,n)=>{assert.equal(count,36);assert(n>0);draws++;instances+=n;},
  bufferData:(type,array)=>{if(array?.byteLength!=null)uploads++;},
  COMPILE_STATUS:1,LINK_STATUS:1,VERTEX_SHADER:35633,FRAGMENT_SHADER:35632,
  ARRAY_BUFFER:34962,STATIC_DRAW:35044,DYNAMIC_DRAW:35048,FLOAT:5126,
  DEPTH_TEST:2929,TRIANGLES:4,COLOR_BUFFER_BIT:16384,DEPTH_BUFFER_BIT:256
},{get:(obj,k)=>k in obj?obj[k]:(typeof k==='string'?()=>{}:undefined)});
const canvas={width:0,height:0,style:{},getContext:type=>type==='webgl2'?fakeGl:null,addEventListener:()=>{}};
const ctx={window:{},innerWidth:1280,innerHeight:720,devicePixelRatio:1,Float32Array,Math,Number,String,Array,Error,Date};
vm.runInNewContext(source,ctx,{filename:'fps3d.js'});
assert.equal(typeof ctx.window.ProjectCG3D.create,'function');
const renderer=ctx.window.ProjectCG3D.create(canvas);
assert(renderer?.available,'WebGL2 renderer did not initialize');
const me={id:'self',alive:true,rx:2000,ry:2000,weaponId:'rifle',teamId:'alpha'};
const world={
  me,map:{width:60000,height:52000},selfId:'self',quality:1,yaw:0,pitch:0,aiming:true,
  obstacles:()=>[{x:2150,y:2200,w:190,h:110,height:85,kind:'building'},{x:2200,y:2500,w:90,h:90,height:60,kind:'crate'}],
  players:[me,{id:'bot',rx:2300,ry:2150,alive:true,angle:.2,teamId:'bravo'}],
  weapons:{rifle:{category:'assault'}},
  vehicles:[{x:2300,y:2400,alive:true,angle:1,teamId:'alpha',type:'jeep'}],
  crates:[{x:2100,y:2400,type:'ammo'}],mines:[],grenades:[],rockets:[],shots:[],
  match:{objective:{x:2200,y:2150,radius:900,owner:'alpha'}}
};
renderer.draw(world);
assert(draws>=2,'Expected independent world and first-person weapon passes');
assert(instances>=30,'Expected environment, capture ring, units and weapon geometry');
assert(uploads>=3,'Expected instanced mesh buffers');
assert.equal(canvas.width,1280);
assert.equal(ctx.window.ProjectCG3D.create({getContext:()=>null}),null,'Missing WebGL2 should use fallback');
console.log('ProjectCG2 WebGL2 smoke: OK ('+draws+' passes, '+instances+' instances, '+uploads+' uploads)');
