/* ProjectCG2 — procedural first-person weapon rigs and weapon-specific reload motions.
   © 2026 Nitarii. All rights reserved. No external asset dependency. */
(function(root){'use strict';
const clamp=(x,a=0,b=1)=>Math.min(b,Math.max(a,x));
const smooth=x=>{x=clamp(x);return x*x*(3-2*x);};
const key=(t,tilt=0,side=0,drop=0,bolt=0,hand=0,shell=0)=>({t,tilt,side,drop,bolt,hand,shell});
// Timelines differ for every weapon: removal, manipulation, feeding and chambering
// follow that weapon's layout. This is an animated procedural prototype, not mocap.
const CONFIG={
  pistol:{length:45,body:20,barrel:21,stock:0,mag:23,magSide:0,color:'#242a28',keys:[key(0),key(.13,-.12,1,0,0,-10),key(.30,-.22,5,1,0,-26),key(.48,-.12,4,1,0,-33),key(.69,-.12,1,.08,0,-15),key(.82,-.12,0,0,1,-8),key(.94,0,0,0,0,0),key(1)]},
  smg:{length:64,body:27,barrel:27,stock:22,mag:30,magSide:0,color:'#252e31',keys:[key(0),key(.18,.08,0,.3,0,-12),key(.31,.18,4,1,0,-28),key(.49,.12,5,1,0,-27),key(.69,.05,1,0,0,-12),key(.83,.08,0,0,1,-9),key(1)]},
  mp5:{length:71,body:32,barrel:32,stock:28,mag:32,magSide:0,color:'#242526',keys:[key(0),key(.14,.05,-3,0,0,-5),key(.25,.19,3,.8,0,-24),key(.44,.20,5,1,0,-23),key(.64,.10,1,0,0,-10),key(.80,.14,-2,0,1,-20),key(.92,-.04,0,0,0,13),key(1)]},
  carbine:{length:83,body:35,barrel:49,stock:34,mag:29,magSide:0,color:'#323b3a',keys:[key(0),key(.15,-.08,1,.35,0,-8),key(.36,-.24,5,1,0,-24),key(.56,-.18,4,.6,0,-28),key(.75,-.08,0,0,1,-8),key(.91,-.02,0,0,0,0),key(1)]},
  rifle:{length:94,body:40,barrel:55,stock:35,mag:32,magSide:0,color:'#272c28',keys:[key(0),key(.20,-.08,2,.25,0,-6),key(.37,-.18,4,1,0,-26),key(.55,-.20,3,.65,0,-27),key(.73,-.1,0,0,1,-10),key(.90,.02,0,0,.2,8),key(1)]},
  akm:{length:99,body:43,barrel:54,stock:42,mag:37,magSide:-2,color:'#38372e',keys:[key(0),key(.18,.05,2,.2,0,-4),key(.31,.22,8,.95,0,-23),key(.47,.27,9,1,0,-34),key(.65,.18,2,0,0,-13),key(.79,.20,1,0,1,-12),key(.94,.03,0,0,0,4),key(1)]},
  shotgun:{length:109,body:41,barrel:67,stock:37,mag:0,magSide:0,color:'#403a30',shellFeed:true,keys:[key(0),key(.12,-.05,0,0,0,-8),key(.27,-.11,0,0,0,-24,.45),key(.48,-.16,0,0,0,-34,1),key(.67,-.10,0,0,0,-24,.10),key(.88,-.05,0,0,0,0),key(1)]},
  vector:{length:63,body:29,barrel:25,stock:25,mag:37,magSide:5,color:'#292e31',keys:[key(0),key(.16,.06,-3,.3,0,-11),key(.34,.19,-7,1,0,-28),key(.52,.13,-6,.9,0,-27),key(.70,.08,-3,0,0,-17),key(.86,.16,1,0,1,-9),key(1)]},
  semi556:{length:95,body:42,barrel:57,stock:40,mag:26,magSide:1,color:'#343b35',keys:[key(0),key(.15,-.12,0,.2,0,-9),key(.33,-.24,5,1,0,-21),key(.56,-.22,3,.5,0,-31),key(.77,-.13,0,0,1,-15),key(.92,0,0,0,0,0),key(1)]},
  semi762:{length:106,body:46,barrel:63,stock:49,mag:31,magSide:0,color:'#3f3b35',keys:[key(0),key(.17,-.07,2,.25,0,-9),key(.38,-.30,6,1,0,-27),key(.59,-.28,5,.5,0,-33),key(.82,-.16,0,0,1,-20),key(.95,0,0,0,0,0),key(1)]},
  dmr:{length:121,body:49,barrel:69,stock:57,mag:32,magSide:0,color:'#343933',keys:[key(0),key(.18,.10,1,.2,0,-10),key(.38,.22,5,1,0,-30),key(.58,.19,3,.55,0,-34),key(.81,.12,-1,0,1,-19),key(.94,-.05,0,0,0,0),key(1)]},
  bolt:{length:129,body:48,barrel:77,stock:59,mag:26,magSide:0,color:'#3e3a32',keys:[key(0),key(.18,-.08,2,0,0,-6),key(.33,-.16,6,1,0,-28),key(.55,-.15,6,.55,0,-24),key(.66,-.20,1,0,1,-15),key(.79,-.16,0,0,1,10),key(.91,.02,0,0,0,0),key(1)]},
  heavybolt:{length:143,body:54,barrel:84,stock:67,mag:44,magSide:-3,color:'#3b3f40',keys:[key(0),key(.19,-.10,3,.20,0,-11),key(.40,-.30,8,1,0,-32),key(.59,-.29,7,.65,0,-39),key(.79,-.18,1,0,1,-21),key(.90,-.12,0,0,1,16),key(1)]}
};
function pose(id, progress=0){
  const rig=CONFIG[id]||CONFIG.pistol;
  const t=clamp(progress);let a=rig.keys[0],b=rig.keys.at(-1);
  for(let i=1;i<rig.keys.length;i++)if(t<=rig.keys[i].t){a=rig.keys[i-1];b=rig.keys[i];break;}
  const k=smooth((t-a.t)/(b.t-a.t||1));const result={id,rig};
  for(const prop of ['tilt','side','drop','bolt','hand','shell'])result[prop]=a[prop]+(b[prop]-a[prop])*k;
  result.active=t>0&&t<1;
  return result;
}
root.ProjectCGWeaponRig={CONFIG,pose};
})(typeof window!=='undefined'?window:globalThis);
