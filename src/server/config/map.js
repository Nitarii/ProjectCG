'use strict';

const BASE_SPAWNS = { alpha:[6000,5500], bravo:[54000,5500], charlie:[30000,49500] };
const TEAMS = {
  alpha: { id:'alpha', name:'ALPHA', color:'#d56559', spawn:BASE_SPAWNS.alpha },
  bravo: { id:'bravo', name:'BRAVO', color:'#6498e0', spawn:BASE_SPAWNS.bravo },
  charlie:{ id:'charlie', name:'CHARLIE', color:'#d4b34e', spawn:BASE_SPAWNS.charlie }
};
const TEAM_IDS = Object.keys(TEAMS);

function seededRandom(seed = 0x51f0a7) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}
function buildMapObstacles() {
  const out = [];
  const structures = [];
  const rnd = seededRandom(0x15F0A7);
  let buildingId = 0;
  function addOpenBuilding(x,y,w,h,kind,levels=1){
    // Each structure is physically hollow. Doors are genuine gaps in server colliders.
    const id=++buildingId,thickness=20,door=Math.min(112,Math.max(88,w*.30));
    const left=(w-door)/2,front=y,back=y+h,wallHeight=levels===2?246:kind==='shed'?100:133;
    const wall=(ox,oy,ow,oh)=>out.push({x:Math.round(ox),y:Math.round(oy),w:Math.round(ow),h:Math.round(oh),height:wallHeight,kind:'structure_wall',structureId:id});
    wall(x,y,left,thickness);wall(x+left+door,y,left,thickness);wall(x,back-thickness,w,thickness);
    wall(x,y,thickness,h);wall(x+w-thickness,y,thickness,h);
    // Inner partition with a passage; both floors can be traversed.
    if(h>245){const line=y+h*.69;wall(x+thickness,line,w*.27,14);wall(x+w*.57,line,w*.43-thickness,14);}
    const stair = levels===2?{x:x+w*.5-40,y:y+24,w:80,h:116}:null;
    structures.push({id,x:Math.round(x),y:Math.round(y),w:Math.round(w),h:Math.round(h),kind,levels,roofHeight:wallHeight,stair});
  }
  const add = (x, y, w, h, height = 80, kind = 'building') => {
    const cx=x+w/2,cy=y+h/2;
    const bases=[[6000,5500],[54000,5500],[30000,49500]];
    if(bases.some(([bx,by])=>Math.hypot(cx-bx,cy-by)<1050))return;
    if(kind==='building'||kind==='shed'){
      const levels=kind==='building'&&(Math.floor(cx/230+cy/430)%3===0)?2:1;
      addOpenBuilding(x,y,w,h,kind,levels);
    }else out.push({x:Math.round(x),y:Math.round(y),w:Math.round(w),h:Math.round(h),height,kind});
  };
  const width = 60000, height = 52000;

  // Complexes et couverts répartis sur une très grande carte, avec densité renforcée au centre.
  const cols = 10, rows = 8;
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const cellW = width / cols, cellH = height / rows;
      const cx = cellW * (gx + .5) + (rnd() - .5) * 900;
      const cy = cellH * (gy + .5) + (rnd() - .5) * 720;
      const flip = (gx + gy) % 2 === 1;
      add(cx - 360, cy - 240, 450, 270, 115, 'building');
      add(cx + 170, cy - 150, 300, 390, 100, 'building');
      add(cx - 260, cy + 170, 290, 170, 70, 'shed');
      add(cx + 90, cy + 290, 350, 72, 50, 'wall');
      add(cx - 470, cy - 350, 72, 330, 52, 'wall');
      add(cx + 470, cy - 330, 72, 270, 52, 'wall');
      add(cx - 95, cy - 430, 300, 62, 48, 'wall');
      add(cx + (flip ? -430 : 330), cy + (flip ? 75 : -25), 135, 105, 62, 'crate');
      add(cx + (flip ? 310 : -400), cy + 390, 165, 110, 62, 'crate');
      if (rnd() > .35) add(cx - 40, cy + 500, 260 + rnd()*170, 55, 44, 'barrier');
      // Secondary facilities increase urban density without creating impassable solid blocks.
      add(cx+575,cy+100,185+rnd()*65,205+rnd()*80,102,'shed');
    }
  }

  // Couverts intermédiaires : empêche les grands espaces d'être totalement vides.
  for (let i = 0; i < 260; i++) {
    const x = 650 + rnd() * (width - 1300), y = 650 + rnd() * (height - 1300);
    const long = rnd() > .62;
    if (long) add(x, y, 250 + rnd()*360, 48 + rnd()*24, 42, 'barrier');
    else add(x, y, 110 + rnd()*120, 75 + rnd()*80, 55, 'crate');
  }
  // Trees are authoritative physical cover; decorative grass and bushes are client-only.
  // Keep a generous clearance near bases and main structures to protect vehicle access.
  for(let i=0;i<1250;i++){
    const x=430+rnd()*(width-860),y=430+rnd()*(height-860);
    if([[6000,5500],[54000,5500],[30000,49500]].some(([a,b])=>Math.hypot(x-a,y-b)<1400))continue;
    if(structures.some(b=>x>b.x-150&&x<b.x+b.w+150&&y>b.y-150&&y<b.y+b.h+150))continue;
    const size=36+rnd()*24;
    out.push({x:Math.round(x-size/2),y:Math.round(y-size/2),w:Math.round(size),h:Math.round(size),height:145+rnd()*85,kind:'tree'});
  }
  return {obstacles:out,structures};
}
const generated = buildMapObstacles();
const MAP = {
  width: 60000,
  height: 52000,
  obstacles: generated.obstacles,
  structures: generated.structures
};

// Grande zone de guerre centrale. Elle n'est pas dessinée dans le monde 3D : seulement carte/minimap.
const WAR_ZONE = { x:MAP.width/2, y:MAP.height*.44, radius:12500 };

module.exports={BASE_SPAWNS,TEAMS,TEAM_IDS,MAP,WAR_ZONE,seededRandom};
