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
  const rnd = seededRandom(0x15F0A7);
  const add = (x, y, w, h, height = 80, kind = 'building') => {
    const cx=x+w/2,cy=y+h/2;
    const bases=[[6000,5500],[54000,5500],[30000,49500]];
    if(bases.some(([bx,by])=>Math.hypot(cx-bx,cy-by)<1050))return;
    out.push({ x:Math.round(x), y:Math.round(y), w:Math.round(w), h:Math.round(h), height, kind });
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
    }
  }

  // Couverts intermédiaires : empêche les grands espaces d'être totalement vides.
  for (let i = 0; i < 260; i++) {
    const x = 650 + rnd() * (width - 1300), y = 650 + rnd() * (height - 1300);
    const long = rnd() > .62;
    if (long) add(x, y, 250 + rnd()*360, 48 + rnd()*24, 42, 'barrier');
    else add(x, y, 110 + rnd()*120, 75 + rnd()*80, 55, 'crate');
  }
  return out;
}

const MAP = {
  width: 60000,
  height: 52000,
  obstacles: buildMapObstacles()
};

// Grande zone de guerre centrale. Elle n'est pas dessinée dans le monde 3D : seulement carte/minimap.
const WAR_ZONE = { x:MAP.width/2, y:MAP.height*.44, radius:12500 };

module.exports={BASE_SPAWNS,TEAMS,TEAM_IDS,MAP,WAR_ZONE,seededRandom};
