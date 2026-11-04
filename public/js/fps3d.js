/* ProjectCG2 — first-person WebGL2 renderer. © 2026 Nitarii. All rights reserved.
 * No network or third-party runtime dependency. World positions are server authoritative. */
(function(root){'use strict';
const TAU=Math.PI*2, clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const VERT=`#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 iCenter;
layout(location=3) in vec3 iSize;
layout(location=4) in vec3 iColor;
layout(location=5) in float iYaw;
uniform mat4 uViewProj;
out vec3 vColor;
out vec3 vNormal;
out vec3 vPosition;
void main(){
  float c=cos(iYaw),s=sin(iYaw);
  vec3 p=aPos*iSize;
  vec3 n=aNormal;
  vec3 world=vec3(c*p.x-s*p.z,p.y,s*p.x+c*p.z)+iCenter;
  vNormal=vec3(c*n.x-s*n.z,n.y,s*n.x+c*n.z);
  vPosition=world;
  vColor=iColor;
  gl_Position=uViewProj*vec4(world,1.0);
}`;
const FRAG=`#version 300 es
precision highp float;
in vec3 vColor;
in vec3 vNormal;
in vec3 vPosition;
uniform vec3 uEye;
uniform float uFogDistance;
uniform float uFlash;
out vec4 color;
void main(){
  vec3 sun=normalize(vec3(-0.35,0.91,0.25));
  float daylight=0.68+0.32*max(0.0,dot(normalize(vNormal),sun));
  float grain=fract(sin(dot(floor(vPosition.xz/22.0),vec2(12.9898,78.233)))*43758.5453);
  vec3 rgb=vColor*daylight*(0.962+grain*0.075);
  float d=length(vPosition.xz-uEye.xz);
  float fog=smoothstep(uFogDistance*0.47,uFogDistance,d);
  rgb=mix(rgb,vec3(0.46,0.55,0.55),fog*0.95);
  color=vec4(rgb+vec3(uFlash),1.0);
}`;
function shader(gl,type,source){const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;}
function perspective(fovy,aspect,near,far){const f=1/Math.tan(fovy/2),nf=1/(near-far);return new Float32Array([f/aspect,0,0,0,0,f,0,0,0,0,(far+near)*nf,-1,0,0,2*far*near*nf,0]);}
function cross(a,b){return[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];}
function norm(a){const s=Math.hypot(...a)||1;return a.map(v=>v/s);}
function lookAt(eye,target,up){const z=norm(eye.map((x,i)=>x-target[i])),x=norm(cross(up,z)),y=cross(z,x);return new Float32Array([x[0],y[0],z[0],0,x[1],y[1],z[1],0,x[2],y[2],z[2],0,-x.reduce((s,a,i)=>s+a*eye[i],0),-y.reduce((s,a,i)=>s+a*eye[i],0),-z.reduce((s,a,i)=>s+a*eye[i],0),1]);}
function multiply(a,b){const r=new Float32Array(16);for(let c=0;c<4;c++)for(let row=0;row<4;row++)for(let k=0;k<4;k++)r[c*4+row]+=a[k*4+row]*b[c*4+k];return r;}
const hex=c=>{let v=Number.parseInt(String(c||'#83918c').replace('#',''),16);if(!Number.isFinite(v))v=0x83918c;return[(v>>16&255)/255,(v>>8&255)/255,(v&255)/255];};
const CUBE=(()=>{let v=[];const add=(n,p)=>{const t=[[p[0],p[1],p[2]],[p[3],p[4],p[5]],[p[6],p[7],p[8]],[p[9],p[10],p[11]]];for(let j of [0,1,2,0,2,3])v.push(...t[j],...n)};
  add([0,1,0],[-.5,.5,-.5,.5,.5,-.5,.5,.5,.5,-.5,.5,.5]);
  add([0,-1,0],[-.5,-.5,.5,.5,-.5,.5,.5,-.5,-.5,-.5,-.5,-.5]);
  add([0,0,1],[-.5,-.5,.5,-.5,.5,.5,.5,.5,.5,.5,-.5,.5]);
  add([0,0,-1],[.5,-.5,-.5,.5,.5,-.5,-.5,.5,-.5,-.5,-.5,-.5]);
  add([1,0,0],[.5,-.5,.5,.5,.5,.5,.5,.5,-.5,.5,-.5,-.5]);
  add([-1,0,0],[-.5,-.5,-.5,-.5,.5,-.5,-.5,.5,.5,-.5,-.5,.5]);return new Float32Array(v);})();
function create(canvas){
  let gl=canvas.getContext('webgl2',{alpha:false,antialias:false,powerPreference:'high-performance',depth:true});
  if(!gl)return null;
  let program=gl.createProgram();gl.attachShader(program,shader(gl,gl.VERTEX_SHADER,VERT));gl.attachShader(program,shader(gl,gl.FRAGMENT_SHADER,FRAG));gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);const uMatrix=gl.getUniformLocation(program,'uViewProj'),uEye=gl.getUniformLocation(program,'uEye'),uFog=gl.getUniformLocation(program,'uFogDistance'),uFlash=gl.getUniformLocation(program,'uFlash');
  const vao=gl.createVertexArray();gl.bindVertexArray(vao);
  const geom=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,geom);gl.bufferData(gl.ARRAY_BUFFER,CUBE,gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,3,gl.FLOAT,false,24,0);
  gl.enableVertexAttribArray(1);gl.vertexAttribPointer(1,3,gl.FLOAT,false,24,12);
  const instanceBuffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,instanceBuffer);
  for(const [loc,offset,size] of [[2,0,3],[3,12,3],[4,24,3],[5,36,1]]){gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,size,gl.FLOAT,false,40,offset);gl.vertexAttribDivisor(loc,1)}
  gl.bindVertexArray(null);gl.enable(gl.DEPTH_TEST);// Double-sided boxes keep the procedural mesh robust across browser drivers.
  let capacity=0,data=new Float32Array(0),count=0,eye=[0,50,0],view=null,projection=null;
  let width=0,height=0,deviceScale=0,contrast=1;
  function resize(scale=1){const w=Math.max(1,Math.floor(innerWidth*clamp(devicePixelRatio*scale,.65,1.6))),h=Math.max(1,Math.floor(innerHeight*clamp(devicePixelRatio*scale,.65,1.6)));if(w!==width||h!==height){canvas.width=width=w;canvas.height=height=h;gl.viewport(0,0,w,h);}canvas.style.width=innerWidth+'px';canvas.style.height=innerHeight+'px';}
  function push(x,y,z,w,h,d,color,rot=0){if(count>=capacity){capacity=Math.max(256,capacity*2);const next=new Float32Array(capacity*10);next.set(data);data=next;}const p=count++*10;const c=Array.isArray(color)?color:hex(color);data.set([x,y,z,Math.max(.5,w),Math.max(.5,h),Math.max(.5,d),c[0],c[1],c[2],rot],p);}
  function batch(){if(!count)return;gl.bindVertexArray(vao);gl.bindBuffer(gl.ARRAY_BUFFER,instanceBuffer);gl.bufferData(gl.ARRAY_BUFFER,data.subarray(0,count*10),gl.DYNAMIC_DRAW);gl.drawArraysInstanced(gl.TRIANGLES,0,CUBE.length/6,count);gl.bindVertexArray(null);count=0;}
  function draw(s){const me=s.me;if(!me||!s.map)return;resize(s.quality);
    const yaw=s.yaw,pitch=s.pitch,fx=Math.cos(yaw),fz=Math.sin(yaw),forward=[fx*Math.cos(pitch),Math.sin(pitch),fz*Math.cos(pitch)];
    eye=[me.rx??me.x,me.downed?23:me.vehicleId?80:54,me.ry??me.y];
    const target=eye.map((v,i)=>v+forward[i]*100);
    view=lookAt(eye,target,[0,1,0]);
    const w=s.weapons?.[me.weaponId]||{},isLong=['sniper','dmr'].includes(w.category),fov=s.aiming?(isLong?36:62):82;
    projection=perspective(fov*Math.PI/180,width/height,3,9300);
    gl.uniformMatrix4fv(uMatrix,false,multiply(projection,view));gl.uniform3fv(uEye,eye);gl.uniform1f(uFog,8500);gl.uniform1f(uFlash,0);
    gl.clearColor(.46,.56,.58,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    const distance=6800,ox=eye[0],oz=eye[2],inRange=(x,z)=>Math.abs(x-ox)<distance&&Math.abs(z-oz)<distance&&(x-ox)**2+(z-oz)**2<distance*distance;
    // Ground is one opaque chunk that follows the camera. No expensive terrain rebuilds.
    push(ox,-13,oz,15400,24,15400,[.31,.37,.29]);
    for(const o of s.obstacles(ox,oz,7500)){
      if(!inRange(o.x+o.w/2,o.y+o.h/2))continue;
      const base=o.kind==='crate'?[.39,.33,.23]:o.kind==='shed'?[.30,.37,.35]:o.kind==='wall'?[.35,.37,.35]:[.35,.38,.36];
      push(o.x+o.w/2,o.height/2,o.y+o.h/2,o.w,o.height,o.h,base);
      if(o.kind==='building'||o.kind==='shed'){
        push(o.x+o.w/2,o.height+3,o.y+o.h/2,o.w+12,6,o.h+12,[.20,.25,.25]);
        if(Math.min(o.w,o.h)>150){
          const x=o.x+o.w/2,z=o.y+o.h/2;
          push(x,o.height*.52,o.y-2,Math.min(75,o.w*.25),25,4,[.11,.17,.19]);
          push(x,o.height*.52,o.y+o.h+2,Math.min(75,o.w*.25),25,4,[.11,.17,.19]);
          push(o.x-2,o.height*.52,z,4,25,Math.min(75,o.h*.25),[.11,.17,.19]);
        }
      }
    }
    const colors={alpha:'#c86a5b',bravo:'#7098c8',charlie:'#ccaa66'};
    for(const p of s.players){if(!p||!p.alive||p.id===s.selfId||!inRange(p.rx??p.x,p.ry??p.y))continue;
      const x=p.rx??p.x,z=p.ry??p.y,a=(p.rangle??p.angle??0);
      const vest=hex(colors[p.teamId]||'#7f9b86'),dark=[.16,.20,.18],body=[.26,.31,.27];
      push(x,32,z,30,35,17,body,a);push(x,36,z,31,12,18,vest,a);
      push(x,58,z,16,17,15,[.51,.48,.39],a);
      push(x,69,z,21,7,20,dark,a);
      for(const side of [-1,1]){const lateral=side*9,ss=Math.sin(a),cs=Math.cos(a);
        push(x-ss*lateral,12,z+cs*lateral,10,24,11,dark,a);
        push(x-ss*side*20+cs*5,38,z+cs*side*20+ss*5,9,25,9,body,a);
      }
      push(x+Math.cos(a)*22,38,z+Math.sin(a)*22,45,7,9,[.12,.15,.14],a);
    }
    for(const v of s.vehicles){if(!v.alive||!inRange(v.rx??v.x,v.ry??v.y))continue;
      const x=v.rx??v.x,z=v.ry??v.y,a=v.rangle??v.angle,jeep=v.type==='jeep',col=hex(colors[v.teamId]||'#687a62');
      push(x,23,z,jeep?138:72,30,jeep?74:39,col,a);
      push(x-16,jeep?47:39,z,jeep?76:32,jeep?24:13,jeep?64:24,[.20,.24,.22],a);
      for(const side of [-1,1])for(const end of [-1,1]){
        const longitudinal=end*(jeep?47:24),lateral=side*(jeep?42:23),cs=Math.cos(a),sn=Math.sin(a);
        push(x+cs*longitudinal-sn*lateral,13,z+sn*longitudinal+cs*lateral,20,25,20,[.09,.10,.10],a);
      }
    }
    for(const c of s.crates){if(inRange(c.x,c.y))push(c.x,12,c.y,32,24,32,c.type==='ammo'?[.52,.41,.23]:[.25,.42,.30]);}
    for(const m of s.mines){if(inRange(m.x,m.y))push(m.x,3,m.y,19,6,19,[.15,.22,.15]);}
    for(const g of s.grenades){if(inRange(g.x,g.y))push(g.x,g.z||3,g.y,12,12,12,[.28,.35,.25]);}
    for(const r of s.rockets){if(inRange(r.x,r.y))push(r.x,r.z||25,r.y,21,7,7,[.28,.27,.23],r.angle||0);}
    // Capture point is legible from ground level; preserve the moving domination concept.
    const o=s.match?.objective;if(o&&inRange(o.x,o.y)){
      const c=hex(colors[o.owner]||'#c6cfbc');push(o.x,170,o.y,9,340,9,c);push(o.x,343,o.y,28,8,28,[.8,.8,.7]);
      const radius=o.radius||950;
      for(let k=0;k<48;k++){const a=(k+.5)*TAU/48;push(o.x+Math.cos(a)*radius,1,o.y+Math.sin(a)*radius,radius*TAU/48,3,5,c,a+Math.PI/2);}
    }
    // Tracers travel through world space; distant shots are not culled by weapon.range.
    const shotNow=Date.now();
    for(const shot of s.shots||[]){
      if(!shot.tracer||shotNow-shot.at>700||shotNow<shot.at||!inRange(shot.x,shot.y))continue;
      const t=(shotNow-shot.at)/1000,vel=Number(shot.muzzleVelocity)||7500;
      const d=Math.max(0,Math.min(shot.range||0,vel*Math.cos(shot.pitch||0)*t)),z=54+Math.tan(shot.pitch||0)*d-.5*327*t*t;
      if(z>0)push(shot.x+Math.cos(shot.angle)*d,z,shot.y+Math.sin(shot.angle)*d,32,3,3,[1,.67,.23],shot.angle);
    }
    batch();
    // Weapon foreground pass: always visible, unlike scene geometry, not used by hit detection.
    if(me.alive&&!me.vehicleId){gl.clear(gl.DEPTH_BUFFER_BIT);gl.uniform1f(uFog,100000);
      const aim=s.aiming,ax=aim?0:23,ay=aim?-13:-24;
      const right=[-Math.sin(yaw),0,Math.cos(yaw)],up=[-fx*Math.sin(pitch),Math.cos(pitch),-fz*Math.sin(pitch)];
      const place=(f,r,u)=>[eye[0]+forward[0]*f+right[0]*r+up[0]*u,eye[1]+forward[1]*f+right[1]*r+up[1]*u,eye[2]+forward[2]*f+right[2]*r+up[2]*u];
      const gunColor=[.13,.15,.14],metal=[.20,.22,.21];
      const unit=place(65,ax,ay);push(unit[0],unit[1],unit[2],72,10,13,gunColor,yaw);
      const stock=place(35,ax,ay-4);push(...stock,40,16,12,[.18,.20,.18],yaw);
      const barrel=place(109,ax,ay+1);push(...barrel,52,5,5,metal,yaw);
      const sight=place(76,ax,ay+9);push(...sight,9,6,7,[.09,.11,.10],yaw);
      batch();
    }
  }
  canvas.addEventListener('webglcontextlost',e=>e.preventDefault());
  return{draw,resize,canvas,available:true};
}
root.ProjectCG3D={create};
})(window);
