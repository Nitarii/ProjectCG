(() => {
'use strict';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const ui = Object.fromEntries([...document.querySelectorAll('[id]')].map(el => [el.id, el]));
const minimapCtx = ui.minimapCanvas.getContext('2d');
const worldMapCtx = ui.worldMapCanvas.getContext('2d');
const visionCanvas = document.createElement('canvas');
const visionCtx = visionCanvas.getContext('2d');
const wallFogCanvas = document.createElement('canvas');
const wallFogCtx = wallFogCanvas.getContext('2d');
const VISION_SCALE=.38, WALL_FOG_SCALE=.34;
let nextWallFogAt=0,nextMinimapAt=0,nextWorldMapAt=0,lastHudRefreshAt=0,lastVehicleUiAt=0;

let ws = null;
let selfId = null;
let map = null;
let weapons = {};
let equipment = [];
let medicalItems = [];
let accessories = [];
let tools = [];
let teams = {};
let match = null;
let profile = null;
let isAdminSession = false;
let draftLoadout = null;
let radar = { allies:[], spottedEnemies:[], audible:[] };
let latestLeaderboard = [];
let scoreboardHeld = false;
let tacticalMapOpen = false;
let pauseWindow = 'inventory';
let lastNetPingAt = 0, nextNetworkUiAt = 0, netPingNonce = 0, netPingPending = null, serverRttMs = null;
let tacticalMapView = { zoom:1, cx:0, cy:0, dragging:false, pointerId:null, startX:0, startY:0, startCx:0, startCy:0 };
let connected = false;
let snapshots = new Map();
let shots = [];
const OBSTACLE_CELL=900;let obstacleGrid=new Map();
let worldGrenades = [];
let worldRockets = [];
let worldMines = [];
let worldVehicles = [];
let worldCrates = [];
let camera = { x:0, y:0 };
let cameraLook = { x:0, y:0, vx:0, vy:0 };
let viewScaleVelocity = 0;
let mouse = { x:innerWidth/2, y:innerHeight/2, down:false, aiming:false };
let keys = { up:false, down:false, left:false, right:false, sprint:false };
let lastInputSent = 0;
let lastFireSent = 0;
let reviveHeld = false;
let accessoryPreviewHeld = false;
let fDownAt=0, fHoldTimer=null, fHoldSent=false;
const damageIndicators=[];
let deviceScale = 1;
let renderQuality = 1;
let frameMsEma = 16.7, nextQualityEvalAt = 0, qualityGoodSince = 0;
let viewScale = 1.02;
const STORAGE_KEYS=['team','keyboardLayout','profileToken','sfxVolume','nickname'];
for(const key of STORAGE_KEYS){const fresh=`projectpc.${key}`,legacy=`isofront.${key}`;if(localStorage.getItem(fresh)==null&&localStorage.getItem(legacy)!=null)localStorage.setItem(fresh,localStorage.getItem(legacy));}
let selectedTeam = localStorage.getItem('projectpc.team') || 'alpha';
let keyboardLayout = localStorage.getItem('projectpc.keyboardLayout') || ((navigator.language||'').toLowerCase().startsWith('fr')?'azerty':'qwerty');
const ISO_X = 0.58;
const ISO_Y = 0.31;
const BASE_WORLD_SCALE = 1.02;
const TEAM_FALLBACK = { alpha:'#d56559', bravo:'#6498e0', charlie:'#d4b34e' };

const casings = [];
const magazines = [];
const muzzleFlashes = [];
const explosionBursts = [];
const seenShotIds = new Map();
const seenShotGroups = new Map();
const seenEffectIds = new Map();
const footstepState = new Map();

function getToken() {
  let token = localStorage.getItem('projectpc.profileToken');
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
    const bytes = new Uint8Array(32); crypto.getRandomValues(bytes);
    token = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('projectpc.profileToken', token);
  }
  return token;
}
function teamColor(id){ return teams[id]?.color || TEAM_FALLBACK[id] || '#9aa397'; }
function teamName(id){ return teams[id]?.name || String(id || '').toUpperCase(); }
function escapeHtml(s){ return String(s).replace(/[&<>\"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '\"':'&quot;' }[c])); }
function hashString(s){ let h=2166136261; for(const ch of String(s)){ h^=ch.charCodeAt(0); h=Math.imul(h,16777619); } return h>>>0; }
function angleDiff(a,b){let d=a-b;while(d>Math.PI)d-=Math.PI*2;while(d<-Math.PI)d+=Math.PI*2;return d;}
function smoothDamp(current,target,velocity,smoothTime,dt,maxSpeed=Infinity){
  smoothTime=Math.max(.0001,smoothTime);dt=Math.max(0,Math.min(.05,dt));
  const omega=2/smoothTime,x=omega*dt,exp=1/(1+x+.48*x*x+.235*x*x*x);
  let change=current-target,originalTarget=target,maxChange=maxSpeed*smoothTime;
  change=Math.max(-maxChange,Math.min(maxChange,change));target=current-change;
  const temp=(velocity+omega*change)*dt;velocity=(velocity-omega*temp)*exp;
  let output=target+(change+temp)*exp;
  if((originalTarget-current>0)===(output>originalTarget)){output=originalTarget;velocity=dt>0?(output-originalTarget)/dt:0;}
  return [output,velocity];
}

let audioCtx=null,audioMaster=null,audioNoiseBuffer=null;
const GLOBAL_SFX_GAIN=2.0; // v1.6 : +100 % de niveau global par rapport aux versions précédentes.
const SFX_V16_MIGRATION='projectpc.sfxVolumeV18';
if(localStorage.getItem(SFX_V16_MIGRATION)!=='1'){if(localStorage.getItem('projectpc.sfxVolume')==null)localStorage.setItem('projectpc.sfxVolume','50');localStorage.setItem(SFX_V16_MIGRATION,'1');}
let sfxVolume=Math.max(0,Math.min(1,Number(localStorage.getItem('projectpc.sfxVolume')??50)/100));
function setSfxVolume(value,persist=true){
  sfxVolume=Math.max(0,Math.min(1,Number(value)||0));
  if(audioMaster)audioMaster.gain.setTargetAtTime(sfxVolume*GLOBAL_SFX_GAIN,audioCtx?.currentTime||0,.015);
  if(ui.sfxVolume)ui.sfxVolume.value=String(Math.round(sfxVolume*100));
  if(ui.sfxVolumeValue)ui.sfxVolumeValue.textContent=`${Math.round(sfxVolume*100)}%`;
  if(persist)localStorage.setItem('projectpc.sfxVolume',String(Math.round(sfxVolume*100)));
}
function ensureAudio(){
  try{
    if(!audioCtx){
      const AC=window.AudioContext||window.webkitAudioContext;if(!AC)return null;
      audioCtx=new AC();audioMaster=audioCtx.createGain();audioMaster.gain.value=sfxVolume*GLOBAL_SFX_GAIN;audioMaster.connect(audioCtx.destination);
      const noiseLen=Math.max(1,Math.floor(audioCtx.sampleRate*.36));audioNoiseBuffer=audioCtx.createBuffer(1,noiseLen,audioCtx.sampleRate);const noiseData=audioNoiseBuffer.getChannelData(0);for(let i=0;i<noiseLen;i++)noiseData[i]=Math.random()*2-1;
    }
    if(audioCtx.state==='suspended')audioCtx.resume();
    return audioCtx;
  }catch{return null;}
}
function spatialAudio(x,y,max=1800){
  const me=selfPlayer();
  if(!me||!Number.isFinite(x)||!Number.isFinite(y))return{gain:.72,pan:0,distance:0};
  const dx=x-me.x,dy=y-me.y,d=Math.hypot(dx,dy);
  if(d>=max)return{gain:0,pan:0,distance:d};
  const n=Math.max(0,1-d/max),gain=Math.pow(n,1.35);
  // Projection isométrique : (dx-dy) correspond approximativement à la provenance gauche/droite à l'écran.
  const screenX=dx-dy,pan=Math.max(-1,Math.min(1,screenX/(Math.max(1,max)*.58)));
  return{gain,pan,distance:d};
}
function connectSpatial(output,spatial=null){
  if(!audioMaster)return;
  if(!spatial){output.connect(audioMaster);return;}
  const s=spatialAudio(spatial.x,spatial.y,spatial.max||1800);
  if(s.gain<=.001)return null;
  const distanceGain=audioCtx.createGain();distanceGain.gain.value=s.gain;output.connect(distanceGain);
  if(audioCtx.createStereoPanner){
    const pan=audioCtx.createStereoPanner();pan.pan.value=s.pan;distanceGain.connect(pan);pan.connect(audioMaster);
  }else distanceGain.connect(audioMaster);
  return s;
}
function tone(freq,duration=.08,gain=.08,type='sine',delay=0,slide=0,spatial=null){
  const ac=ensureAudio();if(!ac||!audioMaster||gain<=0)return;
  if(spatial&&spatialAudio(spatial.x,spatial.y,spatial.max||1800).gain<=.001)return;
  const o=ac.createOscillator(),g=ac.createGain(),t=ac.currentTime+delay;
  o.type=type;o.frequency.setValueAtTime(Math.max(20,freq),t);if(slide)o.frequency.exponentialRampToValueAtTime(Math.max(20,freq+slide),t+duration);
  g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(Math.max(.0002,gain),t+.006);g.gain.exponentialRampToValueAtTime(.0001,t+duration);
  o.connect(g);if(connectSpatial(g,spatial)===null){try{o.disconnect();}catch{}return;}o.start(t);o.stop(t+duration+.02);
}
function noiseBurst(duration=.06,gain=.08,filterFreq=1800,delay=0,spatial=null){
  const ac=ensureAudio();if(!ac||!audioMaster||gain<=0)return;
  if(spatial&&spatialAudio(spatial.x,spatial.y,spatial.max||1800).gain<=.001)return;
  const src=ac.createBufferSource(),f=ac.createBiquadFilter(),g=ac.createGain(),t=ac.currentTime+delay;
  src.buffer=audioNoiseBuffer;src.playbackRate.value=.94+Math.random()*.12;f.type='lowpass';f.frequency.value=filterFreq;g.gain.setValueAtTime(gain,t);g.gain.exponentialRampToValueAtTime(.0001,t+duration);
  src.connect(f);f.connect(g);if(connectSpatial(g,spatial)===null)return;src.start(t,Math.random()*.08,Math.min(duration,.34));
}
function sfxShot(s){
  const w=weapons[s.weaponId]||{},max=(w.category==='sniper'||w.category==='dmr')?3600:w.category==='shotgun'?2700:w.category==='pistol'?1900:2500,pos={x:s.x,y:s.y,max};
  if(w.category==='sniper'||w.category==='dmr'){noiseBurst(.13,.17,1050,0,pos);tone(92,.14,.11,'square',0,-28,pos);}
  else if(w.category==='shotgun'){noiseBurst(.12,.18,760,0,pos);tone(78,.1,.08,'triangle',0,-24,pos);}
  else if(w.category==='pistol'){noiseBurst(.055,.11,2100,0,pos);tone(150,.055,.055,'square',0,-55,pos);}
  else if(w.category==='smg'){noiseBurst(.042,.085,2500,0,pos);tone(180,.038,.038,'square',0,-75,pos);}
  else{noiseBurst(.065,.12,1800,0,pos);tone(125,.065,.05,'square',0,-50,pos);}
}
function sfxExplosion(x,y,flash=false){const pos={x,y,max:flash?3000:3400};if(flash){noiseBurst(.08,.17,4200,0,pos);tone(1850,.42,.045,'sine',.02,-980,pos);}else{noiseBurst(.28,.26,620,0,pos);tone(62,.26,.12,'sine',0,-30,pos);}}
function sfxReload(x,y){const pos={x,y,max:1050};noiseBurst(.025,.035,3200,0,pos);tone(560,.035,.025,'square',.05,-120,pos);tone(390,.045,.025,'square',.22,110,pos);}
function sfxHeal(x,y){const pos={x,y,max:760};noiseBurst(.035,.025,2400,0,pos);tone(520,.08,.025,'sine',.03,120,pos);}
function sfxRevive(x,y,fast=false){const pos={x,y,max:1100};if(fast){tone(1100,.06,.06,'square',0,0,pos);tone(1450,.06,.055,'square',.09,0,pos);tone(1900,.12,.05,'sine',.18,-300,pos);}else{tone(620,.1,.035,'sine',0,0,pos);tone(820,.12,.035,'sine',.14,0,pos);}}
function sfxCrate(x,y,type='ammo'){const pos={x,y,max:1000};tone(type==='ammo'?180:260,.07,.05,'square',0,0,pos);noiseBurst(.06,.045,900,.03,pos);}
function sfxResupply(type='ammo'){tone(type==='ammo'?760:960,.07,.035,'sine');tone(type==='ammo'?980:1220,.08,.03,'sine',.07);}
function sfxXp(reason='XP'){if(reason==='VICTOIRE'){tone(520,.12,.06,'sine');tone(680,.13,.06,'sine',.11);tone(880,.22,.065,'sine',.23);}else if(reason==='ÉLIMINATION'){tone(840,.07,.045,'square');tone(1120,.09,.04,'sine',.065);}else{tone(650,.06,.028,'sine');tone(850,.08,.025,'sine',.055);}}
function sfxHitmarker(){tone(1180,.045,.04,'square');tone(1680,.035,.026,'sine',.018,-180);}
let hitmarkerTimer=null;
function showHitmarker(){
  ui.crosshair.classList.remove('hitConfirmed');
  // Force le redémarrage de l'animation quand plusieurs impacts arrivent très vite.
  void ui.crosshair.offsetWidth;
  ui.crosshair.classList.add('hitConfirmed');
  clearTimeout(hitmarkerTimer);hitmarkerTimer=setTimeout(()=>ui.crosshair.classList.remove('hitConfirmed'),120);
  sfxHitmarker();
}
function sfxFootstep(x,y,sprinting=false,self=false,seed=0){
  const max=sprinting?1280:730,pos=self?null:{x,y,max};
  const base=(seed%7)*3;
  noiseBurst(sprinting?.036:.025,sprinting?.060:.027,sprinting?720:920,0,pos);
  tone((sprinting?88:112)+base,sprinting?.055:.038,sprinting?.028:.013,'triangle',0,-18,pos);
}
function updateFootsteps(now=performance.now()){
  const me=selfPlayer();if(!connected||!me)return;
  const sources=[{id:selfId,x:me.x,y:me.y,sprinting:!!me.sprinting,self:true,moving:(me.moveSpeed||0)>80},
    ...(radar.audible||[]).map(p=>({...p,self:false,moving:true}))];
  const live=new Set();
  for(const p of sources){
    if(!p?.id||!p.moving)continue;live.add(p.id);
    let st=footstepState.get(p.id);if(!st){st={nextAt:now+Math.random()*180};footstepState.set(p.id,st);}
    if(now<st.nextAt)continue;
    sfxFootstep(p.x,p.y,!!p.sprinting,!!p.self,hashString(p.id));
    const cadence=p.sprinting?285:455;st.nextAt=now+cadence*(.88+Math.random()*.24);
  }
  for(const [id,st] of footstepState)if(!live.has(id)&&now-st.nextAt>1600)footstepState.delete(id);
}
['pointerdown','keydown'].forEach(ev=>addEventListener(ev,()=>ensureAudio(),{once:true,capture:true}));

ui.nickname.value = localStorage.getItem('projectpc.nickname') || `Joueur${Math.floor(Math.random()*900+100)}`;
function refreshTeamPicker(){
  document.querySelectorAll('[data-team]').forEach(b => b.classList.toggle('selected', b.dataset.team === selectedTeam));
  document.querySelectorAll('[data-switch-team]').forEach(b => b.classList.toggle('selected', b.dataset.switchTeam === (selfPlayer()?.teamId || selectedTeam)));
}
refreshTeamPicker();
document.querySelectorAll('[data-team]').forEach(b => b.addEventListener('click', () => {
  selectedTeam=b.dataset.team; localStorage.setItem('projectpc.team',selectedTeam); refreshTeamPicker();
}));
document.querySelectorAll('[data-switch-team]').forEach(b => b.addEventListener('click', () => {
  selectedTeam=b.dataset.switchTeam; localStorage.setItem('projectpc.team',selectedTeam); send({type:'team',teamId:selectedTeam});
  closePauseMenu(); refreshTeamPicker();
}));
ui.resumeBtn.addEventListener('click', closePauseMenu);
ui.newProfileBtn.addEventListener('click', () => {
  if (!confirm('Créer un nouveau profil local ? La progression de ce navigateur ne sera plus reliée à l’ancien code profil.')) return;
  localStorage.removeItem('projectpc.profileToken'); getToken();
  ui.menuStatus.textContent = 'Nouveau profil local créé.';
});
ui.playBtn.addEventListener('click', connect);
ui.nickname.addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });
if(ui.sfxVolume){
  setSfxVolume(sfxVolume,false);
  ui.sfxVolume.addEventListener('input',()=>setSfxVolume(Number(ui.sfxVolume.value)/100,true));
}


const isStaticHosting = /(?:^|\.)github\.io$/i.test(location.hostname) ||
  new URLSearchParams(location.search).has('server');
const serverQuery = new URLSearchParams(location.search).get('server');
if (serverQuery) {
  try { localStorage.setItem('projectpc.serverUrl',serverQuery); } catch {}
}
if (isStaticHosting) {
  ui.serverChooser.hidden=false;
  ui.serverUrl.value=localStorage.getItem('projectpc.serverUrl')||'';
  ui.playBtn.textContent='REJOINDRE LA PARTIE';
  ui.menuStatus.textContent='Serveur de jeu requis pour lancer une partie.';
}
function selectedWebSocketUrl() {
  if (!isStaticHosting) {
    const scheme=location.protocol==='https:'?'wss:':'ws:';
    return `${scheme}//${location.host}/ws`;
  }
  let input=String(ui.serverUrl.value||'').trim();
  if (!input) throw new Error('Renseigne l’adresse HTTPS de ton serveur de jeu.');
  if (!/^[a-z]+:\/\//i.test(input)) input=`https://${input}`;
  const endpoint=new URL(input);
  if (endpoint.username||endpoint.password||endpoint.search||endpoint.hash) {
    throw new Error('Utilise uniquement l’adresse publique de ton serveur, sans identifiants ni paramètres.');
  }
  if (endpoint.protocol==='https:') endpoint.protocol='wss:';
  else if(endpoint.protocol==='http:') endpoint.protocol='ws:';
  if (endpoint.protocol!=='wss:' && endpoint.protocol!=='ws:') {
    throw new Error('Adresse non prise en charge : utilise HTTPS ou WSS.');
  }
  if(location.protocol==='https:' && endpoint.protocol!=='wss:'){
    throw new Error('Le serveur doit utiliser HTTPS/WSS depuis GitHub Pages.');
  }
  endpoint.pathname=endpoint.pathname.replace(/\/+$/,'') || '/';
  if(endpoint.pathname==='/') endpoint.pathname='/ws';
  else if(!endpoint.pathname.endsWith('/ws')) endpoint.pathname+='/ws';
  localStorage.setItem('projectpc.serverUrl',input);
  return endpoint.toString();
}

function connect() {
  if (connected) return;
  const nickname = (ui.nickname.value.trim() || 'Joueur').slice(0, 18);
  localStorage.setItem('projectpc.nickname', nickname);
  localStorage.setItem('projectpc.team', selectedTeam);
  let endpoint;
  try { endpoint=selectedWebSocketUrl(); }
  catch(e){ ui.menuStatus.textContent=e.message; return; }
  ui.playBtn.disabled = true;
  ui.menuStatus.textContent = 'Connexion au serveur…';
  ws = new WebSocket(endpoint);
  ws.addEventListener('open', () => ws.send(JSON.stringify({ type:'hello', token:getToken(), nickname, teamId:selectedTeam })));
  ws.addEventListener('message', e => { let msg; try { msg = JSON.parse(e.data); } catch { return; } onMessage(msg); });
  ws.addEventListener('close', () => {
    connected = false; netPingPending=null;serverRttMs=null; mouse.down = false; mouse.aiming = false; keys={up:false,down:false,left:false,right:false,sprint:false};
    ui.connection.textContent = '● déconnecté'; ui.connection.style.color = '#ff6570';
    ui.menuStatus.textContent = 'Connexion perdue. Tu peux rejoindre à nouveau.';
    ui.playBtn.disabled = false; ui.playBtn.textContent = isStaticHosting?'REJOINDRE LA PARTIE':'REJOINDRE LE SERVEUR';
    ui.pauseMenu.classList.remove('active'); closeTacticalMap(); setScoreboardHeld(false); ui.menu.classList.add('active');
  });
  ws.addEventListener('error', () => { ui.menuStatus.textContent = 'Impossible de joindre le serveur.'; ui.playBtn.disabled = false; });
}

function decodeRemotePlayer(a){return{id:a[0],nickname:a[1],isBot:!!a[2],teamId:a[3],squadId:a[4],x:a[5],y:a[6],vx:a[7],vy:a[8],moveSpeed:a[9],angle:a[10],hp:a[11],maxHp:a[12],alive:!!a[13],downed:!!a[14],beingRevivedBy:a[15],beingRevivedProgress:a[16],beingRevivedFast:!!a[17],weaponId:a[18],reloadingMs:a[19],medicalId:a[20],medicalUseMs:a[21],vehicleId:a[22],vehicleSeat:a[23],aiming:!!a[24],sprinting:!!a[25],pilotRole:!!a[26],pilotCountdownMs:a[27],beingHealedById:a[28],healLockMs:a[29],dragTargetId:a[30],draggedById:a[31]};}
function decodeRadarState(r){if(!r?.packed)return r||radar;return{allies:(r.allies||[]).map(a=>({id:a[0],nickname:a[1],x:a[2],y:a[3],angle:a[4],isBot:!!a[5],downed:!!a[6],squadId:a[7]||null})),spottedEnemies:(r.spottedEnemies||[]).map(a=>({id:a[0],x:a[1],y:a[2],teamId:a[3],remainingMs:a[4]})),audible:(r.audible||[]).map(a=>({id:a[0],x:a[1],y:a[2],sprinting:!!a[3]})),vehicles:(r.vehicles||[]).map(a=>({id:a[0],type:a[1],x:a[2],y:a[3],alive:!!a[4]}))};}
function onMessage(msg) {
  if (msg.type === 'welcome') {
    selfId=msg.selfId; map=msg.map; buildObstacleIndex(); weapons=msg.weapons||{}; equipment=msg.equipment||[]; medicalItems=msg.medicalItems||[]; accessories=msg.accessories||[]; tools=msg.tools||[]; teams=msg.teams||{}; profile=msg.profile; match=msg.match||null; isAdminSession=!!msg.isAdmin;
    draftLoadout={...(profile?.loadout||{})};
    connected=true; resetTacticalMapView(); ui.menu.classList.remove('active'); ui.hud.classList.remove('hidden');
    ui.connection.textContent='● connecté'; ui.connection.style.color=''; updateProfileUi(); updateMatchUi(); renderAdminPanel(); renderSquadPanel();
  } else if(msg.type==='net_pong') {
    if(netPingPending && msg.nonce===netPingPending.nonce){
      const measured=performance.now()-netPingPending.at;
      serverRttMs=serverRttMs==null?measured:serverRttMs*.65+measured*.35;
      netPingPending=null;
    }
  } else if (msg.type === 'snapshot') {
    const receivedAt=performance.now(),packetPlayers=[...(msg.players||[]),...(msg.remotePlayers||[]).map(decodeRemotePlayer)];
    for (const p of packetPlayers) {
      const old=snapshots.get(p.id); snapshots.set(p.id,{...p,rx:old?.rx??p.x,ry:old?.ry??p.y,rangle:old?.rangle??p.angle,receivedAt});
    }
    const live=new Set(packetPlayers.map(p=>p.id)); for(const id of snapshots.keys()) if(!live.has(id)) snapshots.delete(id);
    if(msg.shots?.length)ingestShotBatch(msg.shots,msg.serverTime); // compatibilité avec anciens serveurs.
    worldGrenades=msg.grenades||[]; worldRockets=msg.rockets||[]; worldMines=msg.mines||[];
    const oldVehicles=new Map(worldVehicles.map(v=>[v.id,v]));
    worldVehicles=(msg.vehicles||[]).map(v=>{const old=oldVehicles.get(v.id);return {...v,rx:old?.rx??v.x,ry:old?.ry??v.y,rangle:old?.rangle??v.angle,receivedAt};});
    worldCrates=msg.crates||[]; match=msg.match||match; if(msg.radar)radar=decodeRadarState(msg.radar); processWorldEffects(msg.effects||[]);
    // Les mises à jour DOM à 20/30 Hz provoquaient des recalculs de layout et faisaient chuter
    // les FPS des clients distants. Le HUD n'a pas besoin d'être rafraîchi plus de 10 fois/s.
    if(receivedAt-lastHudRefreshAt>=95){lastHudRefreshAt=receivedAt;updateSelfHud();if(msg.match)updateMatchUi();renderSquadPanel();}
    if(receivedAt-lastVehicleUiAt>=180){lastVehicleUiAt=receivedAt;updateVehicleOccupancy();}
  } else if (msg.type === 'shot_batch') {
    ingestShotBatch(msg.shots||[],msg.serverTime);
  } else if (msg.type === 'profile') {
    profile=msg.profile; if(msg.loadoutApplied||msg.spentMoney!=null)draftLoadout={...(profile?.loadout||{})}; updateProfileUi();
    if(msg.gainedXp) combatNotice(msg.xpReason||'XP',msg.gainedXp,msg.gainedMoney);
    if(ui.loadoutHint&&msg.spentMoney!=null)ui.loadoutHint.textContent=msg.xpReason==='LICENCE'?`Licence achetée · ${Math.round(msg.spentMoney)} € dépensés.`:`Équipement acheté pour cette vie · ${Math.round(msg.spentMoney)} € dépensés.`;
  } else if(msg.type==='loadout_rejected'||msg.type==='shop_rejected') { if(ui.loadoutHint)ui.loadoutHint.textContent=msg.reason||'Achat indisponible ici.'; }
  else if(msg.type==='admin_granted'){isAdminSession=true;renderAdminPanel();addFeed('Tu es maintenant l’hôte administrateur.','objective');}
  else if (msg.type === 'feed') addFeed(msg.text,msg.kind);
  else if (msg.type === 'leaderboard') { renderLeaderboard(msg.players||[]); renderAdminPanel(); if(msg.match){match=msg.match;updateMatchUi();} }
}

function updateProfileUi(){
  if(!profile)return; ui.hudName.textContent=profile.nickname; ui.hudLevel.textContent=`Niv. ${profile.level}`;
  const span=Math.max(1,profile.nextLevelXp-profile.currentLevelXp),pos=Math.max(0,profile.xp-profile.currentLevelXp);
  ui.xpFill.style.width=`${Math.min(100,pos/span*100)}%`; ui.xpText.textContent=`${pos} / ${span} XP · total ${profile.xp}`; if(ui.moneyText)ui.moneyText.textContent=`${Math.round(profile.money||0).toLocaleString('fr-FR')} €`; if(ui.shopMoney)ui.shopMoney.textContent=`${Math.round(profile.money||0).toLocaleString('fr-FR')} €`; renderUnlocks();
}
function renderUnlocks(){
  if(!profile)return;
  const next=[...Object.values(weapons).map(w=>({level:w.level,name:w.name,type:'Arme'})),...equipment.map(e=>({level:e.level,name:e.name,type:'Équipement'})),...medicalItems.map(m=>({level:m.level,name:m.name,type:'Soin'})),...tools.map(a=>({level:a.level,name:a.name,type:'Outil'})),...accessories.map(a=>({level:a.level,name:a.name,type:'Accessoire'}))]
    .filter(x=>x.level>profile.level).sort((a,b)=>a.level-b.level).slice(0,6);
  ui.unlocks.innerHTML=next.length?next.map(x=>`<div class="unlock"><b>Niv. ${x.level}</b> · ${escapeHtml(x.name)} <span>${x.type}</span></div>`).join(''):'<div class="unlock">Tout est débloqué.</div>';
  renderLoadout();
}

function ownBase(){const me=selfPlayer();return me&&map?.bases?.[me.teamId];}
function selfInBase(){const me=selfPlayer(),b=ownBase();if(!me||!b)return false;const r=map?.baseRadius||match?.baseRadius||700;return Math.hypot(me.x-b[0],me.y-b[1])<=r;}
function canEditLoadout(){const me=selfPlayer();return !!me?.alive&&selfInBase();}
function licenseSet(kind){return new Set(profile?.licenses?.[kind]||[]);}
function itemOwned(kind,id){return licenseSet(kind).has(id);}
function itemCost(item){return Math.max(0,Number(item?.lifeCost||0));}
function licenseCost(item){return Math.max(0,Number(item?.licenseCost||0));}
function euro(v){return `${Math.round(Number(v)||0).toLocaleString('fr-FR')} €`;}
function ensureDraftLoadout(){if(!draftLoadout)draftLoadout={...(profile?.loadout||{})};draftLoadout.equipmentIds=[...(draftLoadout.equipmentIds||[])];return draftLoadout;}
function trySelectOrLicense(kind,item,id,onSelect){
  if(!canEditLoadout()){ui.loadoutHint.textContent='Tu dois être dans ta base pour acheter ou changer de stuff.';return;}
  if(profile.level<(item.level||1)){ui.loadoutHint.textContent=`Niveau ${item.level} requis.`;return;}
  if(!itemOwned(kind,id)){const cost=licenseCost(item);if((profile.money||0)<cost){ui.loadoutHint.textContent=`Licence : ${euro(cost)} requis.`;return;}ui.loadoutHint.textContent=`Achat de la licence ${item.name}…`;send({type:'buy_license',kind,id});return;}
  onSelect();renderLoadout();
}
function renderLoadout(){
  if(!profile||!ui.loadoutWeapons)return;const d=ensureDraftLoadout(),canChange=canEditLoadout();
  if(ui.shopMoney)ui.shopMoney.textContent=euro(profile.money||0);
  const label=(item,kind,id,detail='')=>{const levelOk=profile.level>=(item.level||1),owned=itemOwned(kind,id);if(!levelOk)return `Niv. ${item.level} requis`;if(!owned)return `LICENCE ${euro(licenseCost(item))}${detail?` · ${detail}`:''}`;return `${itemCost(item)?`Vie ${euro(itemCost(item))}`:'GRATUIT'}${detail?` · ${detail}`:''}`;};
  ui.loadoutWeapons.innerHTML=Object.values(weapons).sort((a,b)=>a.level-b.level||a.name.localeCompare(b.name)).map(w=>`<button class="loadoutItem ${d.weaponId===w.id?'selected':''} ${profile.level<w.level?'locked':''} ${itemOwned('weapon',w.id)?'licensed':'unlicensed'}" data-loadout-weapon="${w.id}" ${canChange?'':'disabled'}><b>${escapeHtml(w.name)}</b><span>${label(w,'weapon',w.id,`${w.automatic?'auto':'coup par coup'} · ${Math.round(w.range/10)} m`)}</span></button>`).join('');
  ui.loadoutEquipment.innerHTML=equipment.map(e=>`<button class="loadoutItem ${(d.equipmentIds||[]).includes(e.id)?'selected':''} ${profile.level<e.level?'locked':''} ${itemOwned('equipment',e.id)?'licensed':'unlicensed'}" data-loadout-equipment="${e.id}" ${canChange?'':'disabled'}><b>${escapeHtml(e.name)}</b><span>${label(e,'equipment',e.id,escapeHtml(e.description||''))}</span></button>`).join('');
  if(ui.loadoutMedical)ui.loadoutMedical.innerHTML=medicalItems.map(m=>`<button class="loadoutItem ${d.medicalId===m.id?'selected':''} ${profile.level<m.level?'locked':''} ${itemOwned('medical',m.id)?'licensed':'unlicensed'}" data-loadout-medical="${m.id}" ${canChange?'':'disabled'}><b>${escapeHtml(m.name)}</b><span>${label(m,'medical',m.id,`${m.heal} PV · ${(m.useTime/1000).toFixed(1)} s`)}</span></button>`).join('');
  if(ui.loadoutTools)ui.loadoutTools.innerHTML=tools.map(t=>`<button class="loadoutItem ${d.toolId===t.id?'selected':''} ${profile.level<t.level?'locked':''} ${itemOwned('tool',t.id)?'licensed':'unlicensed'}" data-loadout-tool="${t.id}" ${canChange?'':'disabled'}><b>${escapeHtml(t.name)}</b><span>${label(t,'tool',t.id,escapeHtml(t.description||''))}</span></button>`).join('');
  ui.loadoutAccessories.innerHTML=accessories.map(a=>`<button class="loadoutItem ${d.accessoryId===a.id?'selected':''} ${profile.level<a.level?'locked':''} ${itemOwned('accessory',a.id)?'licensed':'unlicensed'}" data-loadout-accessory="${a.id}" ${canChange?'':'disabled'}><b>${escapeHtml(a.name)}</b><span>${label(a,'accessory',a.id,escapeHtml(a.description||''))}</span></button>`).join('');
  if(ui.loadoutHint)ui.loadoutHint.textContent=canChange?'Clique un objet non possédé pour acheter sa licence. Sélectionne ton stuff puis achète-le pour cette vie.':'Retourne dans ta base pour acheter ou modifier ton équipement.';
  if(ui.buyLoadoutBtn){ui.buyLoadoutBtn.disabled=!canChange;ui.buyLoadoutBtn.onclick=()=>submitLoadout(d.weaponId||'pistol',[...(d.equipmentIds||[])],d.accessoryId||'none',d.toolId||'none',d.medicalId||'bandage');}
  if(!canChange)return;
  ui.loadoutWeapons.querySelectorAll('[data-loadout-weapon]').forEach(b=>b.onclick=()=>{const id=b.dataset.loadoutWeapon,w=weapons[id];trySelectOrLicense('weapon',w,id,()=>d.weaponId=id);});
  ui.loadoutEquipment.querySelectorAll('[data-loadout-equipment]').forEach(b=>b.onclick=()=>{const id=b.dataset.loadoutEquipment,e=equipment.find(x=>x.id===id);trySelectOrLicense('equipment',e,id,()=>{const arr=d.equipmentIds||[];const i=arr.indexOf(id);if(i>=0)arr.splice(i,1);else if(arr.length<2)arr.push(id);else ui.loadoutHint.textContent='Deux équipements maximum.';});});
  ui.loadoutMedical?.querySelectorAll('[data-loadout-medical]').forEach(b=>b.onclick=()=>{const id=b.dataset.loadoutMedical,m=medicalItems.find(x=>x.id===id);trySelectOrLicense('medical',m,id,()=>d.medicalId=id);});
  ui.loadoutTools?.querySelectorAll('[data-loadout-tool]').forEach(b=>b.onclick=()=>{const id=b.dataset.loadoutTool,t=tools.find(x=>x.id===id);trySelectOrLicense('tool',t,id,()=>d.toolId=id);});
  ui.loadoutAccessories.querySelectorAll('[data-loadout-accessory]').forEach(b=>b.onclick=()=>{const id=b.dataset.loadoutAccessory,a=accessories.find(x=>x.id===id);trySelectOrLicense('accessory',a,id,()=>d.accessoryId=id);});
}
function submitLoadout(weaponId,equipmentIds,accessoryId,toolId,medicalId){
  if(!connected)return;if(!canEditLoadout()){if(ui.loadoutHint)ui.loadoutHint.textContent='Tu dois être dans ta base pour changer de stuff.';return;}ui.loadoutHint.textContent='Achat de l’équipement pour cette vie…';send({type:'loadout',weaponId,equipmentIds,accessoryId,toolId,medicalId});
}
function renderAdminPanel(){
  if(!ui.adminPanel)return;const me=selfPlayer(),allowed=!!(isAdminSession||me?.isAdmin);
  ui.adminPanel.classList.toggle('hidden',!allowed);ui.adminMenuTab?.classList.toggle('hidden',!allowed);ui.adminUnavailable?.classList.toggle('hidden',allowed);
  if(!allowed){if(pauseWindow==='admin')setPauseWindow('inventory');return;}
  const humans=latestLeaderboard.filter(p=>!p.isBot);const current=ui.adminPlayerSelect?.value;
  if(ui.adminPlayerSelect){ui.adminPlayerSelect.innerHTML=humans.map(p=>`<option value="${p.id}">${escapeHtml(p.nickname)} · niv. ${p.level}${p.godMode?' · GOD':''}</option>`).join('');if(current&&humans.some(p=>p.id===current))ui.adminPlayerSelect.value=current;}
}
function adminSend(action,extra={}){const targetId=ui.adminPlayerSelect?.value||selfId;send({type:'admin',action,targetId,...extra});}
if(ui.adminLevelDown)ui.adminLevelDown.onclick=()=>adminSend('level_delta',{delta:-1});
if(ui.adminLevelUp)ui.adminLevelUp.onclick=()=>adminSend('level_delta',{delta:1});
if(ui.adminGod)ui.adminGod.onclick=()=>adminSend('god');
if(ui.adminMoneyDown)ui.adminMoneyDown.onclick=()=>adminSend('money_delta',{delta:-1000});
if(ui.adminMoneyUp)ui.adminMoneyUp.onclick=()=>adminSend('money_delta',{delta:1000});
if(ui.adminTeleportControl)ui.adminTeleportControl.onclick=()=>adminSend('teleport_control');
if(ui.adminSpawnVehicle)ui.adminSpawnVehicle.onclick=()=>adminSend('spawn_vehicle',{vehicleType:ui.adminVehicleType?.value||'quad'});
function renderSquadPanel(){
  if(!ui.squadPicker)return;const me=selfPlayer(),current=me?.squadId||null;
  ui.squadPicker.querySelectorAll('[data-squad]').forEach(btn=>{btn.classList.toggle('active',btn.dataset.squad===current);btn.onclick=()=>send({type:'squad',action:'join',squadId:btn.dataset.squad});});
  if(ui.leaveSquadBtn){ui.leaveSquadBtn.disabled=!current;ui.leaveSquadBtn.onclick=()=>send({type:'squad',action:'leave'});}
}
function isSquadMate(p,me=selfPlayer()){return !!(p&&me&&p.id!==me.id&&p.teamId===me.teamId&&me.squadId&&p.squadId===me.squadId);}
function updateVehicleOccupancy(){
  if(!ui.vehicleOccupancy)return;const me=selfPlayer();if(!me?.vehicleId){ui.vehicleOccupancy.classList.add('hidden');ui.vehicleOccupancy.innerHTML='';return;}
  const v=worldVehicles.find(x=>x.id===me.vehicleId);if(!v){ui.vehicleOccupancy.classList.add('hidden');return;}
  const occ=new Map((v.occupants||[]).map(o=>[o.seat,o]));const rows=[['driver','CONDUCTEUR']];for(let i=0;i<(v.passengerCapacity||1);i++)rows.push([`passenger${i}`,`PASSAGER ${i+1}`]);
  ui.vehicleOccupancy.innerHTML=`<div class="vehTitle"><span>${v.type==='jeep'?'JEEP':'QUAD'}</span><b>${(v.occupants||[]).length}/${1+(v.passengerCapacity||1)}</b></div>`+rows.map(([seat,label])=>{const o=occ.get(seat);return `<div class="vehSeat"><b>${label}</b><span class="${o?'':'empty'}">${o?escapeHtml(o.nickname):'Libre'}</span></div>`;}).join('');
  ui.vehicleOccupancy.classList.remove('hidden');
}

function renderLeaderboard(list){
  latestLeaderboard=[...(list||[])];const ids=['alpha','bravo','charlie'];
  ui.leaderboard.innerHTML=ids.map(id=>{const rows=latestLeaderboard.filter(p=>p.teamId===id).sort((a,b)=>(b.moneyNet||0)-(a.moneyNet||0)||b.kills-a.kills||b.assists-a.assists||a.deaths-b.deaths);
    return `<section class="scoreTeamColumn"><div class="scoreTeamHeader"><span><i class="teamDot" style="background:${teamColor(id)}"></i>${teamName(id)}</span><em>${rows.length} combattants</em></div><div class="scoreRows"><div class="scoreRow scoreRowHeader"><span>JOUEUR</span><em>€ NET</em><em>K</em><em>A</em><em>D</em><em>NIV</em></div>${rows.map(p=>`<div class="scoreRow ${p.id===selfId?'me':''}"><span class="scoreName">${escapeHtml(p.nickname)}</span><b class="scoreMoney ${Number(p.moneyNet||0)<0?'negative':''}">${Number(p.moneyNet||0)>=0?'+':''}${Math.round(p.moneyNet||0).toLocaleString('fr-FR')} €</b><em>${p.kills||0}</em><em>${p.assists||0}</em><em>${p.deaths||0}</em><em>${p.level||1}</em></div>`).join('')}</div></section>`;
  }).join('');renderAdminPanel();
}
function updateMatchUi(){
  if(!match)return;
  const ids=['alpha','bravo','charlie'],war=match.warControl||{},warOcc=war.occupants||{};
  ui.teamScores.innerHTML=ids.map(id=>`<div class="scoreTeam"><i style="background:${teamColor(id)}"></i><span>${teamName(id)}</span><b>${match.scores?.[id]??0}</b></div>`).join('');
  if(ui.teamScoresMini)ui.teamScoresMini.innerHTML=ids.map(id=>`<span title="${teamName(id)} : ${warOcc[id]||0} de poids de capture dans la zone de guerre"><i style="background:${teamColor(id)}"></i><b>${match.scores?.[id]??0} pts</b><em>${warOcc[id]||0} zone</em></span>`).join('');
  const o=match.objective||{}; const me=selfPlayer();
  const cycle=Math.max(0,Math.min(1,Number(war.cycle||0))),pct=cycle*100;
  if((match.prepMs||0)>0&&!match.winner){
    ui.objectiveState.textContent=`DÉPLOIEMENT · ${Math.ceil(match.prepMs/1000)} s`;
    ui.captureFill.style.width=`${Math.max(0,100-(match.prepMs/30000)*100)}%`;ui.captureFill.style.background='#c8d3c2';
    ui.objectiveTimer.textContent='préparation des équipes';
  }else if(match.winner){
    ui.objectiveState.textContent=`${teamName(match.winner)} REMPORTE LA MANCHE`;ui.captureFill.style.width='100%';ui.captureFill.style.background=teamColor(match.winner);ui.objectiveTimer.textContent='nouvelle manche imminente';
  }else{
    if(war.tied){ui.objectiveState.textContent='ZONE DE GUERRE · ÉGALITÉ';ui.captureFill.style.background='#aeb4ac';}
    else if(war.leader){ui.objectiveState.textContent=`ZONE DE GUERRE · ${teamName(war.leader)} EN TÊTE`;ui.captureFill.style.background=teamColor(war.leader);}
    else{ui.objectiveState.textContent='ZONE DE GUERRE · AUCUN CONTRÔLE';ui.captureFill.style.background='#7f8780';}
    ui.captureFill.style.width=`${pct}%`;
    const sec=Math.max(0,Math.ceil((1-cycle)*10));
    const pointState=o.contested?'point de contrôle contesté':o.owner?`point de contrôle ${teamName(o.owner)} · présence ×2`:'point de contrôle neutre';
    ui.objectiveTimer.textContent=`cycle ${sec} s · ${pointState}`;
  }
  for(const t of match.teams||[]){const e=ui[`${t.id}Count`];if(e)e.textContent=`${t.total} combattants`;}
  if(me){selectedTeam=me.teamId||selectedTeam;refreshTeamPicker();renderSquadPanel();}
}
function addFeed(text,kind=''){const el=document.createElement('div');el.className=`feedItem ${kind}`;el.textContent=text;ui.killFeed.prepend(el);while(ui.killFeed.children.length>7)ui.killFeed.lastChild.remove();setTimeout(()=>{el.style.opacity='.2';},6500);setTimeout(()=>el.remove(),9000);}
function combatNotice(reason, amount, moneyAmount=null){
  if(!ui.combatNotices)return;const n=Number(amount||0),kind=n<0?'penalty':reason==='ÉLIMINATION'?'kill':reason==='ASSISTANCE'?'assist':reason==='ZONE'?'objective':'xp',now=performance.now();
  const fmt=v=>`${v>=0?'+':''}${Math.round(v)} XP${moneyAmount!=null?` · ${Number(moneyAmount)>=0?'+':''}${Math.round(moneyAmount)} €`:''}`;
  const last=[...ui.combatNotices.children].find(el=>el.dataset.kind===kind && el.querySelector('b')?.textContent===reason && now-Number(el.dataset.created||0)<650);
  if(n>0)sfxXp(reason);
  if(last){const total=Number(last.dataset.amount||0)+n;last.dataset.amount=String(total);last.dataset.created=String(now);last.querySelector('span').textContent=fmt(total);last.classList.remove('pulse');void last.offsetWidth;last.classList.add('pulse');clearTimeout(last._removeTimer);last._removeTimer=setTimeout(()=>last.remove(),2200);return;}
  const el=document.createElement('div');el.className=`combatNotice ${kind}`;el.dataset.kind=kind;el.dataset.amount=String(n);el.dataset.created=String(now);const label=document.createElement('b');label.textContent=reason;const xp=document.createElement('span');xp.textContent=fmt(n);el.append(label,xp);ui.combatNotices.appendChild(el);while(ui.combatNotices.children.length>4)ui.combatNotices.firstChild.remove();el._removeTimer=setTimeout(()=>el.remove(),2200);
}

function resize(){
  // Le canvas 2D était rendu jusqu'à 2x la résolution CSS. Sur des écrans 1440p/4K ou
  // via un navigateur distant cela doublait/quadrupait facilement le coût GPU sans gain lisible.
  deviceScale=Math.max(.72,Math.min(1.35,devicePixelRatio||1)*renderQuality); canvas.width=Math.floor(innerWidth*deviceScale);canvas.height=Math.floor(innerHeight*deviceScale);canvas.style.width=innerWidth+'px';canvas.style.height=innerHeight+'px';
  ctx.setTransform(deviceScale,0,0,deviceScale,0,0);
  visionCanvas.width=Math.max(1,Math.ceil(innerWidth*VISION_SCALE));visionCanvas.height=Math.max(1,Math.ceil(innerHeight*VISION_SCALE));
  wallFogCanvas.width=Math.max(1,Math.ceil(innerWidth*WALL_FOG_SCALE));wallFogCanvas.height=Math.max(1,Math.ceil(innerHeight*WALL_FOG_SCALE));nextWallFogAt=0;nextMinimapAt=0;
}
addEventListener('resize',resize);resize();
function project(x,y,z=0){return{x:(x-y)*ISO_X*viewScale-camera.x+innerWidth/2,y:(x+y)*ISO_Y*viewScale-camera.y+innerHeight/2-z};}
function inverseVector(sx,sy){const kx=ISO_X*viewScale,ky=ISO_Y*viewScale;return{x:sx/(2*kx)+sy/(2*ky),y:-sx/(2*kx)+sy/(2*ky)};}
function screenAngleFromWorldAngle(angle){const dx=Math.cos(angle),dy=Math.sin(angle);return Math.atan2((dx+dy)*ISO_Y*viewScale,(dx-dy)*ISO_X*viewScale);}
function selfPlayer(){return snapshots.get(selfId);}

function rememberKeyboardLayout(layout){if(layout!==keyboardLayout){keyboardLayout=layout;localStorage.setItem('projectpc.keyboardLayout',layout);}}
function movementActionForEvent(e){
  const k=String(e.key||'').toLowerCase();
  if(k==='z')rememberKeyboardLayout('azerty');else if(k==='w')rememberKeyboardLayout('qwerty');
  if(e.code==='ArrowUp')return'up';if(e.code==='ArrowDown')return'down';if(e.code==='ArrowLeft')return'left';if(e.code==='ArrowRight')return'right';
  if(k==='s')return'down';if(k==='d')return'right';
  if(keyboardLayout==='azerty'){if(k==='z')return'up';if(k==='q')return'left';}
  else{if(k==='w')return'up';if(k==='a')return'left';}
  return null;
}
function isToolKey(e){const k=String(e.key||'').toLowerCase();return keyboardLayout==='azerty'?k==='a':k==='q';}
function setMovement(action,down){if(!action)return;const changed=keys[action]!==down;keys[action]=down;if(changed)sendInput(true);}
function isTypingTarget(target){return target instanceof Element&&target.matches('input, textarea, select, [contenteditable="true"]');}
function setPauseWindow(name){
  const allowed=['inventory','team','admin','settings'];if(!allowed.includes(name))name='inventory';
  if(name==='admin'&&ui.adminMenuTab?.classList.contains('hidden'))name='inventory';pauseWindow=name;
  document.querySelectorAll('[data-menu-panel]').forEach(el=>el.classList.toggle('active',el.dataset.menuPanel===name));
  document.querySelectorAll('[data-menu-window]').forEach(el=>el.classList.toggle('active',el.dataset.menuWindow===name));
  const position=menuWindowPositions.get(name+'Window');
  if(position&&innerWidth>900){const el=ui[name+'Window'];el.style.left=Math.min(position.x,innerWidth-250)+'px';el.style.top=Math.min(position.y,innerHeight-100)+'px';el.style.transform='none';}
  if(name==='inventory')renderLoadout();else if(name==='team'){refreshTeamPicker();renderSquadPanel();}else if(name==='admin')renderAdminPanel();
}
document.querySelectorAll('[data-menu-window]').forEach(btn=>btn.addEventListener('click',()=>setPauseWindow(btn.dataset.menuWindow)));
// Each panel is a separate window, draggable on desktop.
const menuWindowPositions=new Map();
for(const panel of document.querySelectorAll('.pauseWindow')){
  panel.querySelector('.windowClose')?.addEventListener('click',()=>closePauseMenu());
  const grip=panel.querySelector('[data-window-drag]');
  grip?.addEventListener('pointerdown',e=>{
    if(e.button!==0||e.target.closest('button')||innerWidth<=900)return;
    const bounds=panel.getBoundingClientRect(),originX=e.clientX,originY=e.clientY;
    const baseLeft=bounds.left,baseTop=bounds.top;
    const move=ev=>{
      const x=Math.max(205,Math.min(innerWidth-bounds.width-10,baseLeft+ev.clientX-originX));
      const y=Math.max(8,Math.min(innerHeight-75,baseTop+ev.clientY-originY));
      panel.style.left=x+'px';panel.style.top=y+'px';panel.style.transform='none';
      menuWindowPositions.set(panel.id,{x,y});
    };
    const stop=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',stop);window.removeEventListener('pointercancel',stop);};
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',stop);window.addEventListener('pointercancel',stop);
  });
}
function updateNetworkDiagnostics(now=performance.now()){
  if(now<nextNetworkUiAt)return;nextNetworkUiAt=now+500;
  if(!connected||!ws||ws.readyState!==WebSocket.OPEN){if(ui.networkStatus)ui.networkStatus.textContent='Hors connexion';return;}
  if(now-lastNetPingAt>3000 && (!netPingPending||now-netPingPending.at>9000)){
    lastNetPingAt=now;netPingPending={nonce:++netPingNonce,at:now};
    if(!send({type:'net_ping',nonce:netPingNonce}))netPingPending=null;
  }
  if(ui.networkStatus){const rtt=serverRttMs==null?'mesure en cours':Math.round(serverRttMs)+' ms';
    ui.networkStatus.textContent=`RTT ${rtt} · envoi en attente : ${Math.round(ws.bufferedAmount/1024)} Ko`;
  }
}
function pauseOpen(){return ui.pauseMenu.classList.contains('active');}
function menuControlsBlocked(){return pauseOpen()||ui.menu.classList.contains('active');}
function actionControlsBlocked(){return menuControlsBlocked()||tacticalMapOpen;}
function vehicleCombatLocked(){return !!selfPlayer()?.vehicleId;}
function controlsBlocked(){return actionControlsBlocked()||vehicleCombatLocked();}
function setScoreboardHeld(active){
  scoreboardHeld=!!active&&connected&&!pauseOpen()&&!tacticalMapOpen&&!ui.menu.classList.contains('active');
  ui.scoreboardOverlay.classList.toggle('hidden',!scoreboardHeld);
  if(scoreboardHeld){updateMatchUi();renderLeaderboard(latestLeaderboard);}
}
function isTacticalMapKey(e){
  const k=String(e.key||'').toLowerCase();
  return e.code==='KeyM'||e.code==='Comma'||k==='m'||k===',';
}
function resetTacticalMapView(){if(!map)return;tacticalMapView.zoom=1;tacticalMapView.cx=map.width/2;tacticalMapView.cy=map.height/2;clampTacticalMapView();}
function openTacticalMap(){
  if(!connected||pauseOpen()||ui.menu.classList.contains('active'))return;
  setScoreboardHeld(false);
  // La carte n'interrompt plus le déplacement : seules la visée, le tir et les actions contextuelles sont neutralisés.
  if(reviveHeld||fHoldSent){reviveHeld=false;fHoldSent=false;clearTimeout(fHoldTimer);fHoldTimer=null;send({type:'revive_stop'});}
  mouse.down=false;mouse.aiming=false;
  if(!tacticalMapView.cx&&!tacticalMapView.cy)resetTacticalMapView();
  tacticalMapOpen=true;sendInput(true);ui.worldMap.classList.remove('hidden');updateMapZoomLabel();drawWorldMap();
}
function closeTacticalMap(){if(!tacticalMapOpen)return;tacticalMapOpen=false;tacticalMapView.dragging=false;ui.worldMap.classList.add('hidden');}
function toggleTacticalMap(){tacticalMapOpen?closeTacticalMap():openTacticalMap();}
function openPauseMenu(){if(!connected)return;closeTacticalMap();setScoreboardHeld(false);keys={up:false,down:false,left:false,right:false,sprint:false};mouse.down=false;mouse.aiming=false;sendInput(true);ui.pauseMenu.classList.add('active');updateMatchUi();renderAdminPanel();setPauseWindow(pauseWindow||'inventory');}
function closePauseMenu(){ui.pauseMenu.classList.remove('active');}

addEventListener('keydown',e=>{
  if(isTypingTarget(e.target))return;
  if(e.code==='Tab'){e.preventDefault();if(!e.repeat)setScoreboardHeld(true);return;}
  if(isTacticalMapKey(e)&&!e.repeat){e.preventDefault();toggleTacticalMap();return;}
  if(e.code==='Escape'&&!e.repeat){e.preventDefault();if(tacticalMapOpen){closeTacticalMap();return;}pauseOpen()?closePauseMenu():openPauseMenu();return;}
  const moveAction=movementActionForEvent(e);
  if((moveAction||['ShiftLeft','ShiftRight'].includes(e.code))&&!menuControlsBlocked()){if(e.code.startsWith('Arrow'))e.preventDefault();if(moveAction)setMovement(moveAction,true);else{const changed=keys.sprint!==true;keys.sprint=true;if(changed)sendInput(true);}return;}
  if(actionControlsBlocked())return;if(e.repeat)return;
  if(isToolKey(e)){if(!vehicleCombatLocked())send({type:'tool',angle:aimAngle()});return;}
  if(e.code==='KeyR'){if(!vehicleCombatLocked())send({type:'reload'});}
  if(e.code==='KeyE')send({type:'medical'});
  if(e.code==='KeyF'){
    fDownAt=performance.now();fHoldSent=false;clearTimeout(fHoldTimer);fHoldTimer=setTimeout(()=>{if(fDownAt&&!fHoldSent&&!actionControlsBlocked()){fHoldSent=true;reviveHeld=true;send({type:'revive_start'});}},330);
  }
  if(e.code==='KeyK')send({type:'kick_passengers'});
  if(e.code==='Space'){e.preventDefault();send({type:'respawn'});}
  if(e.code==='KeyG'&&!vehicleCombatLocked()){accessoryPreviewHeld=true;return;}
});
addEventListener('keyup',e=>{
  if(e.code==='Tab'){e.preventDefault();setScoreboardHeld(false);return;}
  if(e.code==='KeyG'){if(accessoryPreviewHeld&&!actionControlsBlocked()&&!vehicleCombatLocked())send({type:'accessory',angle:aimAngle()});accessoryPreviewHeld=false;return;}
  if(e.code==='KeyF'){
    clearTimeout(fHoldTimer);fHoldTimer=null;
    if(fHoldSent||reviveHeld){send({type:'revive_stop'});fHoldSent=false;reviveHeld=false;}else if(fDownAt&&!actionControlsBlocked())send({type:'interact'});
    fDownAt=0;
  }
  if(isTypingTarget(e.target))return;const moveAction=movementActionForEvent(e);if(moveAction&&!menuControlsBlocked())setMovement(moveAction,false);if(['ShiftLeft','ShiftRight'].includes(e.code)&&!menuControlsBlocked()){const changed=keys.sprint!==false;keys.sprint=false;if(changed)sendInput(true);}
});
addEventListener('blur',()=>{accessoryPreviewHeld=false;setScoreboardHeld(false);clearTimeout(fHoldTimer);fHoldTimer=null;fDownAt=0;if(reviveHeld||fHoldSent){reviveHeld=false;fHoldSent=false;send({type:'revive_stop'});}keys={up:false,down:false,left:false,right:false,sprint:false};mouse.down=false;mouse.aiming=false;sendInput(true);});
addEventListener('mousemove',e=>{mouse.x=e.clientX;mouse.y=e.clientY;ui.crosshair.style.left=mouse.x+'px';ui.crosshair.style.top=mouse.y+'px';updateCrosshairRange();});
addEventListener('mousedown',e=>{if(actionControlsBlocked()||vehicleCombatLocked())return;if(e.button===0){mouse.down=true;tryFireInput('click');}if(e.button===2){mouse.aiming=true;sendInput(true);}});
addEventListener('mouseup',e=>{if(e.button===0)mouse.down=false;if(e.button===2){mouse.aiming=false;sendInput(true);}});addEventListener('contextmenu',e=>e.preventDefault());

function tacticalMapMetrics(){
  const c=ui.worldMapCanvas,w=c.width,h=c.height,pad=38;
  const fit=map?Math.min((w-pad*2)/map.width,(h-pad*2)/map.height):1;
  return{c,w,h,pad,fit,scale:fit*tacticalMapView.zoom};
}
function clampTacticalMapView(){
  if(!map)return;const {w,h,pad,scale}=tacticalMapMetrics();
  const halfW=Math.max(1,(w/2-pad)/scale),halfH=Math.max(1,(h/2-pad)/scale);
  tacticalMapView.cx=halfW>=map.width/2?map.width/2:Math.max(halfW,Math.min(map.width-halfW,tacticalMapView.cx||map.width/2));
  tacticalMapView.cy=halfH>=map.height/2?map.height/2:Math.max(halfH,Math.min(map.height-halfH,tacticalMapView.cy||map.height/2));
}
function updateMapZoomLabel(){if(ui.mapZoomLabel)ui.mapZoomLabel.textContent=`${Math.round(tacticalMapView.zoom*100)}%`;}
function setTacticalMapZoom(nextZoom,anchor=null){
  if(!map)return;const old=tacticalMapMetrics();
  const ax=anchor?.x??old.w/2,ay=anchor?.y??old.h/2;
  const wx=tacticalMapView.cx+(ax-old.w/2)/old.scale,wy=tacticalMapView.cy+(ay-old.h/2)/old.scale;
  tacticalMapView.zoom=Math.max(1,Math.min(8,nextZoom));const cur=tacticalMapMetrics();
  tacticalMapView.cx=wx-(ax-cur.w/2)/cur.scale;tacticalMapView.cy=wy-(ay-cur.h/2)/cur.scale;
  clampTacticalMapView();updateMapZoomLabel();drawWorldMap();
}
function tacticalMapCanvasPoint(e){
  const r=ui.worldMapCanvas.getBoundingClientRect();return{x:(e.clientX-r.left)*(ui.worldMapCanvas.width/r.width),y:(e.clientY-r.top)*(ui.worldMapCanvas.height/r.height)};
}
ui.mapZoomIn.addEventListener('click',()=>setTacticalMapZoom(tacticalMapView.zoom*1.35));
ui.mapZoomOut.addEventListener('click',()=>setTacticalMapZoom(tacticalMapView.zoom/1.35));
ui.worldMapCanvas.addEventListener('wheel',e=>{if(!tacticalMapOpen)return;e.preventDefault();setTacticalMapZoom(tacticalMapView.zoom*(e.deltaY<0?1.22:.82),tacticalMapCanvasPoint(e));},{passive:false});
ui.worldMapCanvas.addEventListener('pointerdown',e=>{if(!tacticalMapOpen||e.button!==0)return;const p=tacticalMapCanvasPoint(e);tacticalMapView.dragging=true;tacticalMapView.pointerId=e.pointerId;tacticalMapView.startX=p.x;tacticalMapView.startY=p.y;tacticalMapView.startCx=tacticalMapView.cx;tacticalMapView.startCy=tacticalMapView.cy;ui.worldMapCanvas.setPointerCapture?.(e.pointerId);});
ui.worldMapCanvas.addEventListener('pointermove',e=>{if(!tacticalMapView.dragging||e.pointerId!==tacticalMapView.pointerId)return;const p=tacticalMapCanvasPoint(e),m=tacticalMapMetrics();tacticalMapView.cx=tacticalMapView.startCx-(p.x-tacticalMapView.startX)/m.scale;tacticalMapView.cy=tacticalMapView.startCy-(p.y-tacticalMapView.startY)/m.scale;clampTacticalMapView();drawWorldMap();});
function endTacticalMapDrag(e){if(!tacticalMapView.dragging)return;if(e&&tacticalMapView.pointerId!=null&&e.pointerId!==tacticalMapView.pointerId)return;tacticalMapView.dragging=false;tacticalMapView.pointerId=null;}
ui.worldMapCanvas.addEventListener('pointerup',endTacticalMapDrag);ui.worldMapCanvas.addEventListener('pointercancel',endTacticalMapDrag);
ui.worldMapCanvas.addEventListener('dblclick',()=>{resetTacticalMapView();updateMapZoomLabel();drawWorldMap();});

function aimAngle(){const p=selfPlayer();if(!p)return 0;const ps=project(p.rx??p.x,p.ry??p.y,18),v=inverseVector(mouse.x-ps.x,mouse.y-ps.y);return Math.atan2(v.y,v.x);}
function send(obj){if(!ws||ws.readyState!==WebSocket.OPEN)return false;if(ws.bufferedAmount>96*1024&&obj?.type==='input')return false;ws.send(JSON.stringify(obj));return true;}
function sendInput(force=false){const now=performance.now();if(!force&&now-lastInputSent<45)return;lastInputSent=now;const me=selfPlayer(),combatLocked=!!me?.vehicleId;send({type:'input',keys,angle:(tacticalMapOpen||combatLocked)?(me?.angle||0):aimAngle(),aiming:(tacticalMapOpen||combatLocked)?false:mouse.aiming});}
function tryFireInput(mode='hold'){const p=selfPlayer();if(!p?.alive||p.sprinting||controlsBlocked())return;const w=weapons[p.weaponId];if(!w)return;if(mode==='hold'&&!w.automatic)return;const now=performance.now();if(now-lastFireSent<1000/w.fireRate*.82)return;lastFireSent=now;send({type:'fire',angle:aimAngle()});}
function cursorWorldDistance(){const p=selfPlayer();if(!p)return 0;const ps=project(p.rx??p.x,p.ry??p.y,18),v=inverseVector(mouse.x-ps.x,mouse.y-ps.y);return Math.hypot(v.x,v.y);}
function updateCrosshairRange(){const p=selfPlayer(),w=p&&weapons[p.weaponId];if(!w)return;const d=cursorWorldDistance(),active=!p.sprinting;ui.crosshair.classList.toggle('falloff',active&&d>w.range&&d<w.range*2);ui.crosshair.classList.toggle('outOfRange',active&&d>=w.range*2);}

function updateSelfHud(){
  const p=selfPlayer();if(!p)return;
  ui.hpText.textContent=Math.round(p.hp);ui.hpFill.style.width=`${Math.max(0,p.hp/p.maxHp*100)}%`;const w=weapons[p.weaponId];ui.weaponName.textContent=(w?.name||p.weaponId).toUpperCase();ui.ammoText.textContent=p.ammo;ui.magText.textContent=`/${p.mag} · ${p.reserveAmmo||0} réserve`;
  if(p.vehicleId&&mouse.aiming){mouse.aiming=false;sendInput(true);}const veh=p.vehicleId?worldVehicles.find(v=>v.id===p.vehicleId):null,vehName=veh?.type==='jeep'?'JEEP':'QUAD',isPassenger=String(p.vehicleSeat||'').startsWith('passenger');
  ui.reloadText.textContent=p.vehicleSeat==='driver'?`${vehName} · CONDUCTEUR · armes/outils désactivés`:isPassenger?`${vehName} · PASSAGER · armes/outils désactivés`:p.reloadingMs>0?`Rechargement ${(p.reloadingMs/1000).toFixed(1)} s`:(p.sprinting?'Tir impossible en sprint':((p.reserveAmmo||0)<=0&&p.ammo<=0?'PLUS DE MUNITIONS':''));
  ui.staminaFill.style.width=`${Math.max(0,Math.min(100,p.stamina/p.maxStamina*100))}%`;ui.staminaText.textContent=`${Math.round(p.stamina)}%${p.sprinting?' · SPRINT':''}`;ui.aimText.textContent=p.vehicleId?'COMBAT DÉSACTIVÉ EN VÉHICULE':(mouse.aiming?'VISÉE · précision +':'TIR À LA HANCHE');
  const med=medicalItems.find(m=>m.id===p.medicalId)||medicalItems[0];if(ui.medicalName)ui.medicalName.textContent=med?.name||'Soin';if(ui.medicalText)ui.medicalText.textContent=p.medicalUseMs>0?`${p.medicalTargetId&&p.medicalTargetId!==p.id?'Soin allié':'Application'} ${(p.medicalUseMs/1000).toFixed(1)} s`:`${p.medicalCharges||0}/${med?.maxCharges||0} · ${med?.heal||0} PV`;
  const tool=tools.find(t=>t.id===p.toolId),acc=accessories.find(a=>a.id===p.accessoryId);if(ui.toolName)ui.toolName.textContent=tool?.name||'Aucun outil';if(ui.toolText){if((p.toolCooldownMs||0)>0)ui.toolText.textContent=`Recharge ${(p.toolCooldownMs/1000).toFixed(1)} s`;else if(p.toolId==='defib')ui.toolText.textContent='Prêt · maintenir F';else if(p.toolId==='none')ui.toolText.textContent='Non équipé';else ui.toolText.textContent='Prêt · A/Q';}if(ui.accessoryName)ui.accessoryName.textContent=acc?.name||'Aucun accessoire';if(ui.accessoryText)ui.accessoryText.textContent=p.accessoryId==='none'?'Non équipé':`${p.accessoryCharges||0}/${p.accessoryMax||acc?.maxCharges||1} · G`;
  if(p.downed){ui.respawn.classList.remove('hidden');ui.respawnLabel.textContent='AU SOL';ui.respawnTime.textContent=p.respawnMs>0?`réapparition disponible dans ${(p.respawnMs/1000).toFixed(1)} s`:'ESPACE pour abandonner et réapparaître';}else if(!p.alive){ui.respawn.classList.remove('hidden');ui.respawnLabel.textContent='RÉAPPARITION';ui.respawnTime.textContent=`${(p.respawnMs/1000).toFixed(1)} s`;}else ui.respawn.classList.add('hidden');
  if(ui.beingRevived){const active=!!p.downed&&!!p.beingRevivedBy;ui.beingRevived.classList.toggle('hidden',!active);if(active)ui.beingRevived.innerHTML=`RÉANIMATION EN COURS <b>${Math.round((p.beingRevivedProgress||0)*100)}%</b>${p.beingRevivedFast?' · DÉFIBRILLATEUR':''}`;}
  const downedAlly=[...snapshots.values()].find(x=>x.downed&&x.teamId===p.teamId&&x.id!==p.id&&Math.hypot(x.x-p.x,x.y-p.y)<=90),nearbyVehicle=!p.vehicleId?worldVehicles.find(v=>v.alive&&v.teamId===p.teamId&&Math.hypot(v.x-p.x,v.y-p.y)<=115&&(!v.driverId||(v.passengerIds||[]).length<(v.passengerCapacity||1))):null;
  renderAdminPanel();
  if(ui.reviveHint){const show=!!p.alive&&(!!p.reviveTargetId||!!downedAlly||!!p.dragTargetId||!!p.vehicleId||!!nearbyVehicle);ui.reviveHint.classList.toggle('hidden',!show);if(p.reviveTargetId)ui.reviveHint.innerHTML=`RÉANIMATION <b>${Math.round((p.reviveProgress||0)*100)}%</b>`;else if(p.dragTargetId)ui.reviveHint.innerHTML=`<b>F</b> RELÂCHER LE CORPS · MAINTENIR F POUR RÉANIMER`;else if(downedAlly)ui.reviveHint.innerHTML=`<b>F</b> APPUI COURT : TRAÎNER · MAINTENIR <b>F</b> : RÉANIMER${p.toolId==='defib'&&p.toolReady?' · DÉFIBRILLATEUR':''}`;else if(p.vehicleId){const canTakeWheel=isPassenger&&(!veh?.driverId||veh?.driverIsBot);ui.reviveHint.innerHTML=canTakeWheel?`<b>F</b> PRENDRE LE VOLANT${veh?.driverIsBot?' · PREND LE VOLANT':''}`:`<b>F</b> QUITTER ${vehName}${p.vehicleSeat==='driver'?' · <b>K</b> ÉJECTER PASSAGERS':''}`;}else if(nearbyVehicle)ui.reviveHint.innerHTML=`<b>F</b> MONTER DANS ${nearbyVehicle.type==='jeep'?'LA JEEP':'LE QUAD'}`;}
  const spreadPx=Math.max(5,Math.min(25,5+(p.spread||.03)*125));ui.crosshair.style.setProperty('--gap',`${spreadPx}px`);ui.crosshair.classList.toggle('aiming',!!mouse.aiming);ui.crosshair.classList.toggle('blocked',!!p.sprinting||!p.alive||!!p.vehicleId);updateCrosshairRange();
}

function ingestShotBatch(list,serverTime){
  if(!list?.length)return;const localNow=Date.now(),serverNow=Number(serverTime)||null,normalized=[];
  for(const raw of list){
    if(!raw?.id||seenShotIds.has(raw.id))continue;
    // Les horloges des PC ne sont pas synchronisées. Utiliser directement `shot.at` faisait
    // disparaître instantanément les balles/tracers chez les amis dont l'horloge différait.
    const serverAge=serverNow&&Number.isFinite(raw.at)?Math.max(0,Math.min(260,serverNow-raw.at)):0;
    normalized.push({...raw,at:localNow-serverAge});
  }
  if(!normalized.length)return;shots.push(...normalized);if(shots.length>700)shots.splice(0,shots.length-700);processShotEvents(normalized);
}
function processShotEvents(list){const now=Date.now();for(const s of list){if(!s.id||seenShotIds.has(s.id))continue;seenShotIds.set(s.id,now);if(!seenShotGroups.has(s.groupId)){seenShotGroups.set(s.groupId,now);spawnCasing(s);muzzleFlashes.push({x:s.x,y:s.y,angle:s.angle,weaponId:s.weaponId,born:performance.now(),life:70});sfxShot(s);}}}
function processWorldEffects(list){const now=Date.now();for(const e of list){
  if(!e.id||seenEffectIds.has(e.id))continue;seenEffectIds.set(e.id,now);
  if(e.type==='mag'){spawnMagazine(e);sfxReload(e.x,e.y);}
  if(e.type==='explosion'){explosionBursts.push({x:e.x,y:e.y,radius:e.radius||220,accessoryId:e.accessoryId||'frag',born:performance.now(),life:e.accessoryId==='flash'?520:430});sfxExplosion(e.x,e.y,e.accessoryId==='flash');}
  if(e.type==='medical')sfxHeal(e.x,e.y);if(e.type==='revive')sfxRevive(e.x,e.y,!!e.fast);if(e.type==='crate_place')sfxCrate(e.x,e.y,e.crateType==='ammocrate'?'ammo':'medical');if(e.type==='resupply_ammo'&&e.targetId===selfId)sfxResupply('ammo');if(e.type==='resupply_medical'&&e.targetId===selfId)sfxResupply('medical');
  if(e.type==='vehicle_explosion'){explosionBursts.push({x:e.x,y:e.y,radius:e.radius||390,accessoryId:'frag',born:performance.now(),life:620});sfxExplosion(e.x,e.y,false);}if(e.type==='stim')sfxHeal(e.x,e.y);if(e.type==='rocket_launch')sfxShot({x:e.x,y:e.y,weaponId:'heavybolt'});if(e.type==='mine_place')sfxCrate(e.x,e.y,'ammo');
  if(e.type==='hit_confirm'&&e.shooterId===selfId)showHitmarker();
  if(e.type==='damage_direction'&&e.targetId===selfId){const me=selfPlayer();if(me){const bearing=Math.atan2(e.y-me.y,e.x-me.x),rel=Math.abs(angleDiff(bearing,me.angle));if(rel>Math.PI*.46)damageIndicators.push({angle:bearing,born:performance.now(),life:780});}}
}}
function spawnCasing(s){const side=s.angle+Math.PI/2+(Math.random()-.5)*.35,speed=75+Math.random()*55;casings.push({x:s.x+Math.cos(s.angle)*22,y:s.y+Math.sin(s.angle)*22,z:28,vx:Math.cos(side)*speed,vy:Math.sin(side)*speed,vz:85+Math.random()*45,rot:Math.random()*Math.PI*2,vr:(Math.random()-.5)*13,born:performance.now(),life:5200,weaponId:s.weaponId,radius:2});}
function spawnMagazine(e){const side=e.angle+Math.PI/2+(Math.random()-.5)*.25,speed=32+Math.random()*30;magazines.push({x:e.x+Math.cos(e.angle)*10,y:e.y+Math.sin(e.angle)*10,z:26,vx:Math.cos(side)*speed,vy:Math.sin(side)*speed,vz:35+Math.random()*25,rot:screenAngleFromWorldAngle(e.angle)+Math.PI/2,vr:(Math.random()-.5)*5,born:performance.now(),life:7000,weaponId:e.weaponId,radius:5});}
function circleRectCollision(x,y,r,o){const cx=Math.max(o.x,Math.min(x,o.x+o.w)),cy=Math.max(o.y,Math.min(y,o.y+o.h)),dx=x-cx,dy=y-cy;return dx*dx+dy*dy<r*r;}
function buildObstacleIndex(){obstacleGrid=new Map();if(!map?.obstacles)return;for(const o of map.obstacles){const x0=Math.floor(o.x/OBSTACLE_CELL),x1=Math.floor((o.x+o.w)/OBSTACLE_CELL),y0=Math.floor(o.y/OBSTACLE_CELL),y1=Math.floor((o.y+o.h)/OBSTACLE_CELL);for(let gx=x0;gx<=x1;gx++)for(let gy=y0;gy<=y1;gy++){const k=`${gx},${gy}`;let arr=obstacleGrid.get(k);if(!arr)obstacleGrid.set(k,arr=[]);arr.push(o);}}}
function obstaclesInClientBounds(minX,minY,maxX,maxY){if(!obstacleGrid.size)return map?.obstacles||[];const out=[],seen=new Set(),x0=Math.floor(minX/OBSTACLE_CELL),x1=Math.floor(maxX/OBSTACLE_CELL),y0=Math.floor(minY/OBSTACLE_CELL),y1=Math.floor(maxY/OBSTACLE_CELL);for(let gx=x0;gx<=x1;gx++)for(let gy=y0;gy<=y1;gy++)for(const o of obstacleGrid.get(`${gx},${gy}`)||[]){if(seen.has(o))continue;seen.add(o);if(o.x<=maxX&&o.x+o.w>=minX&&o.y<=maxY&&o.y+o.h>=minY)out.push(o);}return out;}
function obstaclesNearClient(x,y,r){return obstaclesInClientBounds(x-r,y-r,x+r,y+r);}
function renderObstacleRadius(){return Math.max(2550,innerWidth/(Math.max(.25,ISO_X*viewScale))*.72,innerHeight/(Math.max(.18,ISO_Y*viewScale))*.72);}
function particleBlocked(x,y,r){if(!map)return false;if(x<r||y<r||x>map.width-r||y>map.height-r)return true;return obstaclesNearClient(x,y,r+8).some(o=>circleRectCollision(x,y,r,o));}
function updateParticleMotion(p,dt){
  const nx=p.x+p.vx*dt;if(!particleBlocked(nx,p.y,p.radius))p.x=nx;else{p.vx=-p.vx*.18;p.vy*=.78;p.vr*=-.35;}
  const ny=p.y+p.vy*dt;if(!particleBlocked(p.x,ny,p.radius))p.y=ny;else{p.vy=-p.vy*.18;p.vx*=.78;p.vr*=-.35;}
}
function updateParticles(dt){
  const gravity=280;for(const arr of [casings,magazines])for(let i=arr.length-1;i>=0;i--){const p=arr[i];updateParticleMotion(p,dt);if(p.z>0||p.vz>0){p.z+=p.vz*dt;p.vz-=gravity*dt;if(p.z<=0){p.z=0;if(Math.abs(p.vz)>30)p.vz=-p.vz*.22;else p.vz=0;p.vx*=.54;p.vy*=.54;p.vr*=.55;}}p.rot+=p.vr*dt;if(performance.now()-p.born>p.life)arr.splice(i,1);}
  for(let i=muzzleFlashes.length-1;i>=0;i--)if(performance.now()-muzzleFlashes[i].born>muzzleFlashes[i].life)muzzleFlashes.splice(i,1);
  for(let i=explosionBursts.length-1;i>=0;i--)if(performance.now()-explosionBursts[i].born>explosionBursts[i].life)explosionBursts.splice(i,1);
  const now=Date.now();for(let i=shots.length-1;i>=0;i--)if(now-(shots[i].at||0)>700)shots.splice(i,1);for(const m of [seenShotIds,seenShotGroups,seenEffectIds])for(const[id,t]of m)if(now-t>15000)m.delete(id);
}

function clientPlayerCanStandAt(x,y,r=27){
  if(!map||x<r||y<r||x>map.width-r||y>map.height-r)return false;
  return !obstaclesNearClient(x,y,r+10).some(o=>circleRectCollision(x,y,r,o));
}
function predictSelfRender(me,dt){
  if(!me)return;const authX=me.x,authY=me.y;
  if(!me.alive||me.downed||me.vehicleId||(match?.prepMs||0)>0){const b=1-Math.exp(-14*dt);me.rx+=(authX-me.rx)*b;me.ry+=(authY-me.ry)*b;return;}
  const sx=(keys.right?1:0)-(keys.left?1:0),sy=(keys.down?1:0)-(keys.up?1:0);let dx=sx+sy,dy=-sx+sy;const moving=!!(dx||dy);
  if(moving){const len=Math.hypot(dx,dy)||1;dx/=len;dy/=len;}
  const healLocked=!!me.beingHealedById;const wantsSprint=moving&&keys.sprint&&!mouse.aiming&&!me.dragTargetId&&!(me.medicalUseMs>0)&&!healLocked&&(me.stamina||0)>.5;
  let speed=wantsSprint?410:255;if(me.dragTargetId)speed*=.68;if(me.medicalUseMs>0)speed*=.62;if(healLocked)speed=0;
  const nx=me.rx+dx*speed*dt,ny=me.ry+dy*speed*dt,r=me.hitRadius||27;
  if(clientPlayerCanStandAt(nx,me.ry,r))me.rx=nx;if(clientPlayerCanStandAt(me.rx,ny,r))me.ry=ny;
  const err=Math.hypot(authX-me.rx,authY-me.ry);
  if(err>520){me.rx=authX;me.ry=authY;return;}
  const correction=1-Math.exp(-(moving?1.45:7.5)*dt);me.rx+=(authX-me.rx)*correction;me.ry+=(authY-me.ry)*correction;
}
function update(dt){
  const pBlend=1-Math.exp(-13*dt),aBlend=1-Math.exp(-11*dt),vBlend=1-Math.exp(-14*dt),vaBlend=1-Math.exp(-10*dt),perfNow=performance.now();
  for(const p of snapshots.values()){
    if(p.id===selfId){predictSelfRender(p,dt);p.rangle=p.angle;continue;}
    const age=Math.min(.10,Math.max(0,(perfNow-(p.receivedAt||perfNow))/1000)),tx=p.x+(p.vx||0)*age,ty=p.y+(p.vy||0)*age;
    p.rx+=(tx-p.rx)*pBlend;p.ry+=(ty-p.ry)*pBlend;p.rangle=(p.rangle??p.angle)+angleDiff(p.angle,p.rangle??p.angle)*aBlend;
  }
  for(const v of worldVehicles){const age=Math.min(.10,Math.max(0,(perfNow-(v.receivedAt||perfNow))/1000)),tx=v.x+(v.vx||0)*age,ty=v.y+(v.vy||0)*age;v.rx=(v.rx??v.x)+(tx-(v.rx??v.x))*vBlend;v.ry=(v.ry??v.y)+(ty-(v.ry??v.y))*vBlend;const targetAngle=Math.hypot(v.vx||0,v.vy||0)>18?Math.atan2(v.vy,v.vx):v.angle;v.rangle=(v.rangle??targetAngle)+angleDiff(targetAngle,v.rangle??targetAngle)*vaBlend;}
  const me=selfPlayer();if(me){
    const currentAim=aimAngle();if(!tacticalMapOpen&&!menuControlsBlocked())me.angle=currentAim;
    const aiming=mouse.aiming&&me.alive,w=weapons[me.weaponId]||{};
    // Le zoom dépend réellement de la portée : léger sur les armes courtes, plus marqué sur DMR/snipers.
    // Il reste volontairement limité pour conserver la lecture top-down et éviter l'effet de tunnel brutal.
    const rangeFactor=Math.max(0,Math.min(1,((w.range||500)-300)/(1450-300)));
    const aimZoom=1.07+rangeFactor*.15,targetScale=aiming?BASE_WORLD_SCALE*aimZoom:BASE_WORLD_SCALE;

    // SmoothDamp garde une vitesse continue quand le clic droit est pressé/relâché : pas de snap ni de rebond.
    const oldScale=viewScale,[nextScale,nextScaleVelocity]=smoothDamp(viewScale,targetScale,viewScaleVelocity,aiming ? .30 : .36,dt,.90);
    viewScale=nextScale;viewScaleVelocity=nextScaleVelocity;

    // Compensation exacte du changement d'échelle autour du joueur. Sans elle, changer viewScale déplace le point
    // projeté du personnage et la caméra "remonte" brutalement pour le recentrer, ce qui causait la nausée.
    const scaleDelta=viewScale-oldScale;
    camera.x+=(me.rx-me.ry)*ISO_X*scaleDelta;
    camera.y+=(me.rx+me.ry)*ISO_Y*scaleDelta;

    // En visée, le curseur pilote un look-ahead écran indépendant de la projection du joueur. Déplacer le réticule
    // permet donc de regarder plus loin dans cette direction sans boucle de rétroaction caméra <-> angle de visée.
    let desiredLookX=0,desiredLookY=0;
    if(aiming&&!tacticalMapOpen&&!menuControlsBlocked()){
      const cx=innerWidth*.5,cy=innerHeight*.5,dx=mouse.x-cx,dy=mouse.y-cy,len=Math.hypot(dx,dy);
      if(len>1){
        const deadZone=42,maxCursor=Math.max(220,Math.min(innerWidth,innerHeight)*.43);
        const strength=Math.max(0,Math.min(1,(len-deadZone)/Math.max(1,maxCursor-deadZone)));
        const maxLook=48+rangeFactor*112;
        desiredLookX=dx/len*maxLook*strength;desiredLookY=dy/len*maxLook*strength;
      }
    }
    [cameraLook.x,cameraLook.vx]=smoothDamp(cameraLook.x,desiredLookX,cameraLook.vx,aiming ? .28 : .38,dt,620);
    [cameraLook.y,cameraLook.vy]=smoothDamp(cameraLook.y,desiredLookY,cameraLook.vy,aiming ? .28 : .38,dt,620);

    const rawX=(me.rx-me.ry)*ISO_X*viewScale,rawY=(me.rx+me.ry)*ISO_Y*viewScale,followSpeed=5.0;
    camera.x+=(rawX+cameraLook.x-camera.x)*(1-Math.exp(-followSpeed*dt));
    camera.y+=(rawY+cameraLook.y-camera.y)*(1-Math.exp(-followSpeed*dt));
  }
  const now=performance.now();for(let i=damageIndicators.length-1;i>=0;i--)if(now-damageIndicators[i].born>damageIndicators[i].life)damageIndicators.splice(i,1);
  updateParticles(dt);updateFootsteps(now);updateCrosshairRange();if(connected&&!menuControlsBlocked()){sendInput(false);const p=selfPlayer(),w=p&&weapons[p.weaponId];if(!actionControlsBlocked()&&!vehicleCombatLocked()&&mouse.down&&w?.automatic)tryFireInput('hold');}
}

function drawDiamond(x,y,w,h,fill,stroke=null){const a=project(x,y),b=project(x+w,y),c=project(x+w,y+h),d=project(x,y+h);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.lineTo(c.x,c.y);ctx.lineTo(d.x,d.y);ctx.closePath();ctx.fillStyle=fill;ctx.fill();if(stroke){ctx.strokeStyle=stroke;ctx.stroke();}}
function drawBaseZones(){if(!map?.bases)return;const r=map.baseRadius||match?.baseRadius||700;for(const [id,b] of Object.entries(map.bases)){drawProjectedRing(b[0],b[1],r,hexAlpha(teamColor(id),.24),hexAlpha(teamColor(id),.035),1,[8,14]);}}
function drawObjectiveZone(){
  const o=match?.objective;if(!o)return;const col=o.owner?teamColor(o.owner):'#c8cec4';ctx.save();ctx.beginPath();for(let i=0;i<=48;i++){const a=i/48*Math.PI*2,p=project(o.x+Math.cos(a)*o.radius,o.y+Math.sin(a)*o.radius,1);if(i===0)ctx.moveTo(p.x,p.y);else ctx.lineTo(p.x,p.y);}ctx.closePath();ctx.fillStyle=o.contested?'rgba(205,210,200,.085)':hexAlpha(col,.10);ctx.fill();ctx.strokeStyle=o.contested?'rgba(220,224,214,.55)':hexAlpha(col,.72);ctx.lineWidth=2;ctx.setLineDash([10,7]);ctx.stroke();ctx.setLineDash([]);const c=project(o.x,o.y,7);ctx.fillStyle='rgba(7,10,8,.72)';ctx.beginPath();ctx.arc(c.x,c.y,16,0,Math.PI*2);ctx.fill();ctx.strokeStyle=col;ctx.lineWidth=2;ctx.stroke();ctx.fillStyle='#e6e9e2';ctx.font='900 9px Segoe UI';ctx.textAlign='center';ctx.fillText('POINT',c.x,c.y+3);ctx.restore();
}
function drawProjectedRing(x,y,r,stroke='rgba(230,235,225,.2)',fill=null,width=1,dash=[]){
  ctx.save();ctx.beginPath();for(let i=0;i<=64;i++){const a=i/64*Math.PI*2,p=project(x+Math.cos(a)*r,y+Math.sin(a)*r,1);if(i===0)ctx.moveTo(p.x,p.y);else ctx.lineTo(p.x,p.y);}ctx.closePath();
  if(fill){ctx.fillStyle=fill;ctx.fill();}ctx.strokeStyle=stroke;ctx.lineWidth=width;ctx.setLineDash(dash);ctx.stroke();ctx.setLineDash([]);ctx.restore();
}
function drawWeaponRange(me){
  if(!me?.alive||!weapons[me.weaponId])return;const r=weapons[me.weaponId].range;
  drawProjectedRing(me.rx,me.ry,r,'rgba(224,232,220,.105)',null,1,[5,9]);
}
function drawCrateZones(){
  const me=selfPlayer();if(!me)return;
  for(const c of worldCrates){
    if(c.teamId!==me.teamId)continue;const inside=Math.hypot(me.x-c.x,me.y-c.y)<=c.radius;
    const col=c.type==='ammo'?'rgba(204,181,94,':'rgba(103,190,126,';
    drawProjectedRing(c.x,c.y,c.radius,`${col}${inside?.72:.32})`,`${col}${inside?.11:.045})`,inside?2:1,[7,7]);
    const p=project(c.x,c.y,16);ctx.save();ctx.textAlign='center';ctx.font='800 8px Segoe UI';ctx.fillStyle=inside?'rgba(238,242,232,.92)':'rgba(210,218,207,.55)';
    ctx.fillText(c.type==='ammo'?(inside?'RAVITAILLEMENT MUNITIONS':'ZONE MUNITIONS'):(inside?'SOINS ACTIFS':'ZONE DE SOINS'),p.x,p.y-26);ctx.restore();
  }
}
function drawWallFog(me){
  if(!me?.alive||!map)return;const now=performance.now();
  if(now>=nextWallFogAt){
    nextWallFogAt=now+(renderQuality<.82?150:renderQuality<.93?110:80);wallFogCtx.setTransform(WALL_FOG_SCALE,0,0,WALL_FOG_SCALE,0,0);wallFogCtx.clearRect(0,0,innerWidth,innerHeight);wallFogCtx.fillStyle='rgba(3,5,4,.22)';
    for(const o of obstaclesNearClient(me.rx,me.ry,2050)){
      const cx=o.x+o.w/2,cy=o.y+o.h/2,vx=cx-me.rx,vy=cy-me.ry,d=Math.hypot(vx,vy);if(d<35||d>2000)continue;
      const px=-vy/d,py=vx/d,corners=[{x:o.x,y:o.y},{x:o.x+o.w,y:o.y},{x:o.x+o.w,y:o.y+o.h},{x:o.x,y:o.y+o.h}];
      let lo=corners[0],hi=corners[0],loV=Infinity,hiV=-Infinity;
      for(const c of corners){const v=(c.x-cx)*px+(c.y-cy)*py;if(v<loV){loV=v;lo=c;}if(v>hiV){hiV=v;hi=c;}}
      const extend=(c)=>{const dx=c.x-me.rx,dy=c.y-me.ry,l=Math.hypot(dx,dy)||1,far=3900;return{x:me.rx+dx/l*far,y:me.ry+dy/l*far};};
      const flo=extend(lo),fhi=extend(hi),a=project(lo.x,lo.y,2),b=project(hi.x,hi.y,2),c=project(fhi.x,fhi.y,2),e=project(flo.x,flo.y,2);
      wallFogCtx.beginPath();wallFogCtx.moveTo(a.x,a.y);wallFogCtx.lineTo(b.x,b.y);wallFogCtx.lineTo(c.x,c.y);wallFogCtx.lineTo(e.x,e.y);wallFogCtx.closePath();wallFogCtx.fill();
    }
  }
  ctx.save();ctx.globalAlpha=.92;ctx.imageSmoothingEnabled=true;ctx.drawImage(wallFogCanvas,0,0,innerWidth,innerHeight);ctx.restore();
}
function hexAlpha(hex,a){if(!hex||hex[0]!=='#')return hex;const n=parseInt(hex.slice(1),16),r=(n>>16)&255,g=(n>>8)&255,b=n&255;return`rgba(${r},${g},${b},${a})`;}
function drawMap(){
  if(!map)return;ctx.fillStyle='#090b0b';ctx.fillRect(0,0,innerWidth,innerHeight);drawDiamond(0,0,map.width,map.height,'#30372f','#5a6258');
  drawDiamond(0,map.height/2-125,map.width,250,'#454840');drawDiamond(map.width/2-135,0,270,map.height,'#41453d');
  drawDiamond(0,map.height*.25-62,map.width,124,'#393d36');drawDiamond(0,map.height*.75-62,map.width,124,'#393d36');
  drawDiamond(map.width*.25-62,0,124,map.height,'#393d36');drawDiamond(map.width*.75-62,0,124,map.height,'#393d36');drawBaseZones();
  const grid=500;ctx.lineWidth=1;ctx.strokeStyle='rgba(235,240,225,.022)';for(let x=0;x<=map.width;x+=grid){const a=project(x,0),b=project(x,map.height);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();}for(let y=0;y<=map.height;y+=grid){const a=project(0,y),b=project(map.width,y);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();}drawObjectiveZone();
}
function obstaclePalette(kind){if(kind==='wall'||kind==='barrier')return{a:'#555c54',b:'#4b524b',top:'#686f65'};if(kind==='crate')return{a:'#51483a',b:'#463f34',top:'#665a47'};if(kind==='shed')return{a:'#494f4a',b:'#404641',top:'#5b625b'};return{a:'#3f4644',b:'#363d3b',top:'#555d59'};}
function drawBox(o){const top=[project(o.x,o.y,o.height),project(o.x+o.w,o.y,o.height),project(o.x+o.w,o.y+o.h,o.height),project(o.x,o.y+o.h,o.height)],base=[project(o.x,o.y),project(o.x+o.w,o.y),project(o.x+o.w,o.y+o.h),project(o.x,o.y+o.h)],xs=[...top,...base].map(p=>p.x),ys=[...top,...base].map(p=>p.y);if(Math.max(...xs)<-80||Math.min(...xs)>innerWidth+80||Math.max(...ys)<-100||Math.min(...ys)>innerHeight+100)return;const pal=obstaclePalette(o.kind),faces=[[0,1],[1,2],[2,3],[3,0]];for(const[i,j]of faces){ctx.beginPath();ctx.moveTo(base[i].x,base[i].y);ctx.lineTo(base[j].x,base[j].y);ctx.lineTo(top[j].x,top[j].y);ctx.lineTo(top[i].x,top[i].y);ctx.closePath();ctx.fillStyle=i%2?pal.a:pal.b;ctx.fill();}ctx.beginPath();ctx.moveTo(top[0].x,top[0].y);for(let i=1;i<4;i++)ctx.lineTo(top[i].x,top[i].y);ctx.closePath();ctx.fillStyle=pal.top;ctx.fill();ctx.strokeStyle='rgba(225,235,225,.09)';ctx.stroke();}
function drawShot(s){
  const age=Date.now()-s.at;if(age<0)return;
  const w=weapons[s.weaponId]||{};
  const ex=s.x+Math.cos(s.angle)*s.range,ey=s.y+Math.sin(s.angle)*s.range;
  if(s.tracer||w.tracer){
    if(age>220)return;const a=project(s.x,s.y,24),b=project(ex,ey,24);ctx.globalAlpha=Math.max(0,1-age/220)*.72;ctx.strokeStyle='#eee8d7';ctx.lineWidth=(w.category==='sniper'?1.8:1.3);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();ctx.globalAlpha=1;return;
  }
  const velocity=s.muzzleVelocity||w.muzzleVelocity||6500,flightMs=Math.max(18,s.range/velocity*1000);
  if(age>flightMs+55)return;
  const t=Math.max(0,Math.min(1,age/flightMs)),d=s.range*t,x=s.x+Math.cos(s.angle)*d,y=s.y+Math.sin(s.angle)*d,p=project(x,y,24);
  const sa=screenAngleFromWorldAngle(s.angle);ctx.save();ctx.translate(p.x,p.y);ctx.rotate(sa);ctx.globalAlpha=Math.max(.18,1-age/(flightMs+55));
  ctx.fillStyle=w.category==='shotgun'?'#d6c59b':'#ece9d8';ctx.beginPath();ctx.ellipse(0,0,w.category==='shotgun'?1.4:2.2,w.category==='shotgun'?.65:.85,0,0,Math.PI*2);ctx.fill();ctx.restore();ctx.globalAlpha=1;
}

function drawWeapon2D(weaponId,magVisible=true){
  ctx.save();ctx.lineJoin='round';ctx.lineCap='round';
  const dark='#111513',metal='#2c3230',mid='#3b423e',wood='#6b5038',tan='#6d6450',optic='#0b0e0d';
  const body=(x,y,w,h,c=metal)=>{ctx.fillStyle=c;ctx.fillRect(x,y,w,h);};
  const barrel=(x,len,th=3)=>{body(x,-th/2,len,th,dark);};
  const mag=(x,h=12,lean=2,c='#202523')=>{if(!magVisible)return;ctx.fillStyle=c;ctx.beginPath();ctx.moveTo(x,-1);ctx.lineTo(x+6,-1);ctx.lineTo(x+6+lean,h);ctx.lineTo(x+1+lean,h-1);ctx.closePath();ctx.fill();};
  const stock=(len=14,h=7,c=dark)=>{ctx.fillStyle=c;ctx.beginPath();ctx.moveTo(-len,-h/2);ctx.lineTo(1,-4);ctx.lineTo(2,4);ctx.lineTo(-len,h/2);ctx.closePath();ctx.fill();};
  const scope=(x=8,len=14)=>{body(x,-9,len,3,optic);body(x+4,-11,5,2,optic);};
  switch(weaponId){
    case 'pistol':
      body(0,-3,16,6,metal);barrel(14,8,2.6);body(3,2,6,9,'#202523');mag(4,8,0,'#171b19');body(1,-5,11,2,mid);break;
    case 'smg':
      stock(8,5);body(0,-5,18,10,metal);barrel(17,15,3);mag(7,10,1);body(20,-6,7,2,mid);break;
    case 'mp5':
      stock(12,5);body(0,-5,20,10,'#242a28');barrel(19,17,3);mag(9,11,0,'#171b19');body(22,-7,8,2,mid);body(-8,-2,8,4,dark);break;
    case 'vector':
      stock(10,5);body(0,-7,22,14,'#252b29');barrel(20,14,3);mag(8,16,4,'#151918');body(20,-4,7,8,mid);body(3,-10,12,3,optic);break;
    case 'carbine':
      stock(15,7);body(0,-5,21,10,metal);barrel(20,24,3);mag(9,13,2);body(24,-6,12,3,mid);scope(7,10);break;
    case 'rifle':
      stock(17,8);body(0,-5,22,10,'#303633');barrel(21,27,3);mag(9,14,2);body(25,-6,14,3,mid);scope(7,12);body(-14,-3,6,6,'#222725');break;
    case 'akm':
      stock(18,8,wood);body(0,-5,22,10,metal);barrel(21,29,3);mag(9,16,5,wood);body(24,-6,15,4,wood);body(-10,-4,10,8,wood);break;
    case 'shotgun':
      stock(18,9,wood);body(0,-5,18,10,metal);barrel(17,35,3.5);mag(8,8,0,'#242927');body(21,-6,17,12,wood);body(36,-4,12,8,'#3a3228');break;
    case 'semi556':
      stock(16,7);body(0,-5,23,10,metal);barrel(22,31,3);mag(10,12,1);body(27,-6,15,3,mid);scope(8,14);break;
    case 'semi762':
      stock(19,8,wood);body(0,-5,24,10,'#333936');barrel(23,34,3);mag(10,13,2);body(28,-6,17,3,mid);scope(9,15);body(-14,-3,8,6,wood);break;
    case 'dmr':
      stock(20,8);body(0,-5,25,10,metal);barrel(24,38,3);mag(11,13,2);body(30,-5,19,2.5,mid);scope(7,22);body(53,-3,10,6,dark);break;
    case 'bolt':
      stock(22,9,wood);body(0,-4.5,25,9,'#313735');barrel(24,42,2.8);mag(13,8,0,'#242927');body(16,4,3,7,metal);scope(7,24);body(58,-2.5,10,5,dark);break;
    case 'heavybolt':
      stock(24,10,'#2e332f');body(0,-6,28,12,'#363d39');barrel(27,48,4);mag(13,12,1,'#1c211f');body(12,5,7,12,'#222725');scope(8,27);body(60,-4,17,8,dark);body(48,-7,10,3,mid);break;
    default:
      stock(14,7);body(0,-5,20,10,metal);barrel(19,24,3);mag(8,12,2);
  }
  ctx.restore();
}
function drawHelmet(variant,teamCol){
  ctx.fillStyle='#9b876d';ctx.beginPath();ctx.arc(9,0,7,0,Math.PI*2);ctx.fill();
  if(variant===0||variant===3){ctx.fillStyle='#394237';ctx.beginPath();ctx.arc(8.5,0,8,Math.PI*.72,Math.PI*1.28);ctx.lineTo(13,6);ctx.lineTo(13,-6);ctx.closePath();ctx.fill();ctx.strokeStyle='#242a24';ctx.lineWidth=1.5;ctx.stroke();}
  else if(variant===1){ctx.fillStyle='#303934';ctx.beginPath();ctx.arc(8,0,7.6,0,Math.PI*2);ctx.fill();ctx.fillStyle='#161b19';ctx.fillRect(6,-8,8,3);}
  else if(variant===2){ctx.fillStyle='#4c4a39';ctx.beginPath();ctx.arc(8.5,0,8.2,Math.PI*.65,Math.PI*1.35);ctx.lineTo(13,7);ctx.lineTo(13,-7);ctx.closePath();ctx.fill();ctx.strokeStyle='#29291f';ctx.stroke();}
  else{ctx.fillStyle='#222827';ctx.beginPath();ctx.arc(8,0,7.5,Math.PI*.78,Math.PI*1.22);ctx.lineTo(12,5);ctx.lineTo(12,-5);ctx.closePath();ctx.fill();ctx.strokeStyle=teamCol;ctx.lineWidth=1;ctx.stroke();}
}
function drawPlayer(p){
  const mounted=p.vehicleId?worldVehicles.find(v=>v.id===p.vehicleId):null;let wx=p.rx,wy=p.ry;
  if(mounted){const pos=vehicleSeatRenderPosition(mounted,p.vehicleSeat);wx=pos.x;wy=pos.y;}
  const ground=project(wx,wy),center=project(wx,wy,mounted?34:25),worldAim=p.id===selfId?p.angle:(p.rangle??p.angle),aimAngleScreen=screenAngleFromWorldAngle(worldAim),isMe=p.id===selfId,col=teamColor(p.teamId),seed=hashString(p.id),variant=seed%5;
  const me=selfPlayer(),isAlly=!isMe&&!!me&&p.teamId===me.teamId,isEnemy=!isMe&&!!me&&p.teamId!==me.teamId,relationCol=isMe?'#f3f5ef':isAlly?'#68ddd5':teamColor(p.teamId);
  const moveSpeed=Math.hypot(p.vx||0,p.vy||0),moving=p.alive&&moveSpeed>22&&!mounted,phase=performance.now()*(p.sprinting?.027:.018)+seed*.01,stride=moving?Math.sin(phase)*(p.sprinting?5.2:3.4):0,bob=moving?Math.abs(Math.sin(phase))*1.1:0;
  ctx.globalAlpha=p.alive?1:.34;ctx.fillStyle='rgba(0,0,0,.40)';ctx.beginPath();ctx.ellipse(ground.x,ground.y+5,mounted?17:24,mounted?7:10,0,0,Math.PI*2);ctx.fill();
  ctx.save();ctx.translate(center.x,center.y+bob);if(mounted)ctx.scale(.82,.82);if(p.downed){ctx.translate(0,11);ctx.rotate(-.88);}ctx.lineJoin='round';ctx.lineCap='round';
  // Tenues volontairement plus claires que le terrain pour préserver la silhouette.
  ctx.fillStyle=variant%2?'#4f5850':'#596158';ctx.beginPath();ctx.roundRect(-10,8+stride,8,18,3);ctx.fill();ctx.beginPath();ctx.roundRect(2,8-stride,8,18,3);ctx.fill();ctx.fillStyle='#202521';ctx.beginPath();ctx.roundRect(-11,22+stride,9,6,3);ctx.fill();ctx.beginPath();ctx.roundRect(2,22-stride,9,6,3);ctx.fill();
  ctx.fillStyle=variant===2?'#746c55':'#606960';ctx.beginPath();ctx.roundRect(-12,-4,24,19,6);ctx.fill();ctx.strokeStyle='#1e241f';ctx.lineWidth=1.3;ctx.stroke();ctx.fillStyle=variant===1?'#71786e':variant===3?'#7b735c':'#737e70';ctx.beginPath();ctx.roundRect(-10,-8,20,18,6);ctx.fill();ctx.strokeStyle='#292e29';ctx.stroke();
  ctx.fillStyle='#353d35';ctx.beginPath();ctx.roundRect(-6,-6,12,13,3);ctx.fill();ctx.fillStyle='#222822';ctx.fillRect(-5,-4,4,4);ctx.fillRect(1,-4,4,4);ctx.fillStyle=hexAlpha(col,.98);ctx.fillRect(-10,-6,3,8);
  ctx.save();ctx.translate(0,-12);ctx.rotate(-Math.PI/2);drawHelmet(variant,col);ctx.restore();
  ctx.save();ctx.rotate(aimAngleScreen);ctx.strokeStyle=variant===4?'#555e57':'#807f70';ctx.lineWidth=5.2;ctx.beginPath();ctx.moveTo(-2,-6);ctx.lineTo(10,-5);ctx.lineTo(18,-2);ctx.stroke();ctx.beginPath();ctx.moveTo(-2,6);ctx.lineTo(10,5);ctx.lineTo(18,2);ctx.stroke();ctx.save();ctx.translate(15,0);ctx.scale(1,Math.cos(aimAngleScreen)>=0?1:-1);drawWeapon2D(p.weaponId,!(p.reloadingMs>0));ctx.restore();ctx.restore();ctx.restore();ctx.globalAlpha=1;
  if(!p.alive){if(p.downed&&isAlly){ctx.save();const markerY=center.y-56,reviving=!!p.beingRevivedBy,progress=Math.max(0,Math.min(1,p.beingRevivedProgress||0));ctx.fillStyle='rgba(5,8,6,.84)';ctx.beginPath();ctx.roundRect(center.x-50,markerY-13,100,26,5);ctx.fill();ctx.fillStyle='#79ded6';ctx.font='900 9px Segoe UI';ctx.textAlign='center';ctx.fillText(reviving?`RÉANIMATION ${Math.round(progress*100)}%`:'ALLIÉ AU SOL',center.x,markerY-1);if(reviving){ctx.fillStyle='rgba(255,255,255,.14)';ctx.fillRect(center.x-41,markerY+5,82,3);ctx.fillStyle='#79ded6';ctx.fillRect(center.x-41,markerY+5,82*progress,3);}ctx.restore();}return;}
  if((p.medicalUseMs||0)>0){const med=medicalItems.find(m=>m.id===p.medicalId),duration=Math.max(1,med?.useTime||2600),remain=p.medicalUseMs||0,progress=Math.max(0,Math.min(1,1-remain/duration));ctx.save();ctx.fillStyle='rgba(5,8,6,.78)';ctx.beginPath();ctx.roundRect(center.x-39,center.y-78,78,15,4);ctx.fill();ctx.fillStyle='rgba(255,255,255,.12)';ctx.fillRect(center.x-32,center.y-69,64,3);ctx.fillStyle='#78c98c';ctx.fillRect(center.x-32,center.y-69,64*progress,3);ctx.fillStyle='#a9e5b5';ctx.font='800 8px Segoe UI';ctx.textAlign='center';ctx.fillText(`SOIN ${(remain/1000).toFixed(1)} s`,center.x,center.y-71);ctx.restore();}
  else if((p.healLockMs||0)>0&&p.beingHealedById){ctx.save();ctx.fillStyle='rgba(5,8,6,.78)';ctx.beginPath();ctx.roundRect(center.x-39,center.y-78,78,15,4);ctx.fill();ctx.fillStyle='#a9e5b5';ctx.font='800 8px Segoe UI';ctx.textAlign='center';ctx.fillText(`SOIGNÉ ${(p.healLockMs/1000).toFixed(1)} s`,center.x,center.y-68);ctx.restore();}
  ctx.save();const squadMate=isSquadMate(p,me),name=p.nickname;ctx.font='800 10px Segoe UI';ctx.textAlign='center';const tw=ctx.measureText(name).width,pad=5;ctx.fillStyle='rgba(5,8,6,.76)';ctx.beginPath();ctx.roundRect(center.x-tw/2-pad,center.y-45,tw+pad*2,15,4);ctx.fill();ctx.fillStyle=squadMate?'#68e58d':relationCol;ctx.fillText(name,center.x,center.y-34);const bw=52;ctx.fillStyle='rgba(0,0,0,.72)';ctx.fillRect(center.x-bw/2,center.y-28,bw,4);ctx.fillStyle=isEnemy?teamColor(p.teamId):isAlly?'#58bfb9':col;ctx.fillRect(center.x-bw/2,center.y-28,bw*Math.max(0,p.hp/p.maxHp),4);
  if(p.pilotRole&&p.pilotCountdownMs>0){const sec=Math.max(1,Math.ceil(p.pilotCountdownMs/1000));ctx.fillStyle='rgba(4,7,5,.82)';ctx.beginPath();ctx.roundRect(center.x-35,center.y-64,70,14,4);ctx.fill();ctx.fillStyle='#e8d89b';ctx.font='900 8px Segoe UI';ctx.fillText(`DÉPART ${sec}s`,center.x,center.y-54);}
  ctx.restore();
}
function drawCasing(c){const p=project(c.x,c.y,c.z);if(p.x<-20||p.x>innerWidth+20||p.y<-20||p.y>innerHeight+20)return;ctx.save();ctx.translate(p.x,p.y);ctx.rotate(c.rot);ctx.strokeStyle='#b79a55';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(-2,0);ctx.lineTo(3,0);ctx.stroke();ctx.restore();}
function drawMagazine(m){const p=project(m.x,m.y,m.z);if(p.x<-30||p.x>innerWidth+30||p.y<-30||p.y>innerHeight+30)return;ctx.save();ctx.translate(p.x,p.y);ctx.rotate(m.rot);ctx.fillStyle='#1d2320';const len=m.weaponId==='pistol'?8:13;ctx.fillRect(-3,-len/2,6,len);ctx.strokeStyle='#0f1210';ctx.strokeRect(-3,-len/2,6,len);ctx.fillStyle='rgba(210,220,205,.16)';ctx.fillRect(-2,-len/2+1,1,len-2);ctx.restore();}
function drawMuzzleFlash(f){const age=performance.now()-f.born;if(age>f.life)return;const w=weapons[f.weaponId]||{},len=w.category==='pistol'?35:w.category==='smg'?45:w.category==='shotgun'?58:w.category==='sniper'?68:w.category==='dmr'?62:55,mx=f.x+Math.cos(f.angle)*len,my=f.y+Math.sin(f.angle)*len,p=project(mx,my,24);ctx.save();ctx.translate(p.x,p.y);ctx.rotate(screenAngleFromWorldAngle(f.angle));ctx.globalAlpha=Math.max(0,1-age/f.life);ctx.fillStyle='#e4c882';ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(13,-4);ctx.lineTo(8,0);ctx.lineTo(13,4);ctx.closePath();ctx.fill();ctx.restore();ctx.globalAlpha=1;}
function drawWorldGrenade(g){const p=project(g.x,g.y,g.z||0),flash=g.accessoryId==='flash';ctx.save();ctx.translate(p.x,p.y);ctx.fillStyle='rgba(0,0,0,.35)';ctx.beginPath();ctx.ellipse(2,6,6,2.5,0,0,Math.PI*2);ctx.fill();ctx.fillStyle=flash?'#b9b8aa':'#354034';ctx.strokeStyle='#151915';ctx.lineWidth=1.2;ctx.beginPath();ctx.arc(0,0,4.8,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.strokeStyle='#777b6f';ctx.beginPath();ctx.moveTo(-1,-5);ctx.lineTo(4,-8);ctx.lineTo(6,-5);ctx.stroke();if((g.fuseMs||0)<900){ctx.fillStyle='#d96c58';ctx.beginPath();ctx.arc(5,-6,1.6,0,Math.PI*2);ctx.fill();}ctx.restore();}
function drawRocket(r){
  const p=project(r.x,r.y,r.z||24);ctx.save();ctx.translate(p.x,p.y);ctx.rotate(screenAngleFromWorldAngle(r.angle));
  ctx.fillStyle='#c3b98b';ctx.fillRect(-7,-2,14,4);ctx.fillStyle='#5c645c';ctx.beginPath();ctx.moveTo(7,0);ctx.lineTo(2,-4);ctx.lineTo(2,4);ctx.closePath();ctx.fill();
  ctx.fillStyle='rgba(232,144,72,.8)';ctx.beginPath();ctx.moveTo(-7,0);ctx.lineTo(-14,-3);ctx.lineTo(-12,0);ctx.lineTo(-14,3);ctx.closePath();ctx.fill();ctx.restore();
}
function drawMine(m){
  const p=project(m.x,m.y,3);ctx.save();ctx.translate(p.x,p.y);ctx.fillStyle=m.armed?'#4e5548':'#777362';ctx.strokeStyle='#181c18';ctx.lineWidth=1.4;ctx.beginPath();ctx.ellipse(0,0,8,4,0,0,Math.PI*2);ctx.fill();ctx.stroke();
  if(m.armed){ctx.fillStyle='#c66a58';ctx.beginPath();ctx.arc(0,-1,1.4,0,Math.PI*2);ctx.fill();}ctx.restore();
}
function vehicleSeatRenderPosition(v,seat){const a=v.rangle??v.angle,x=v.rx??v.x,y=v.ry??v.y,c=Math.cos(a),sn=Math.sin(a),sideX=-sn,sideY=c;let forward=0,side=0;if(seat==='driver'){forward=v.type==='jeep'?14:8;side=v.type==='jeep'?-15:-5;}else{const idx=Math.max(0,Number(String(seat||'passenger0').replace('passenger',''))||0);if(v.type==='quad'){forward=-15;side=4;}else if(idx===0){forward=13;side=15;}else{forward=-18;side=(idx-2)*19;}}return{x:x+c*forward+sideX*side,y:y+sn*forward+sideY*side};}
function drawVehicle(v){
  const vx=v.rx??v.x,vy=v.ry??v.y,va=v.rangle??v.angle,p=project(vx,vy,10),ang=screenAngleFromWorldAngle(va),jeep=v.type==='jeep';ctx.save();ctx.translate(p.x,p.y);ctx.rotate(ang);ctx.globalAlpha=v.alive?1:.48;
  const L=jeep?37:22,W=jeep?17:13;ctx.fillStyle='#151917';
  if(jeep){for(const sx of [-1,1])for(const sy of [-1,1])ctx.fillRect(sx*25-6,sy*13-5,12,10);ctx.fillStyle='#3a433a';ctx.beginPath();ctx.roundRect(-31,-14,62,28,6);ctx.fill();ctx.strokeStyle='#171c18';ctx.lineWidth=2;ctx.stroke();ctx.fillStyle='#222923';ctx.fillRect(-13,-12,28,24);ctx.fillStyle='#566259';ctx.fillRect(16,-11,12,22);ctx.strokeStyle='#8b978b';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(12,-13);ctx.lineTo(18,-19);ctx.lineTo(27,-19);ctx.moveTo(12,13);ctx.lineTo(18,19);ctx.lineTo(27,19);ctx.stroke();}
  else{for(const sx of [-1,1])for(const sy of [-1,1])ctx.fillRect(sx*16-5,sy*11-4,10,8);ctx.fillStyle='#3b453b';ctx.beginPath();ctx.roundRect(-18,-9,36,18,5);ctx.fill();ctx.strokeStyle='#171c18';ctx.lineWidth=2;ctx.stroke();ctx.fillStyle='#202722';ctx.fillRect(-7,-3,14,10);ctx.fillStyle='#5c675c';ctx.fillRect(10,-3,13,6);ctx.strokeStyle='#7c897c';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(8,-8);ctx.lineTo(16,-14);ctx.moveTo(8,8);ctx.lineTo(16,14);ctx.stroke();}
  ctx.fillStyle=teamColor(v.teamId);ctx.fillRect(jeep?-7:-5,jeep?-13:-8,jeep?14:10,3);
  // Fumée puis flammes lors du nettoyage des véhicules abandonnés / dégâts.
  ctx.rotate(-ang);if(v.smoking||v.burning){const t=performance.now()/240;for(let i=0;i<4;i++){const ox=Math.sin(t+i*2.1)*5,oy=-26-i*8-(t*7+i*4)%15;ctx.fillStyle=`rgba(95,103,96,${v.burning?.20:.12})`;ctx.beginPath();ctx.arc(ox,oy,5+i*1.5,0,Math.PI*2);ctx.fill();}if(v.burning){ctx.fillStyle='rgba(231,132,61,.74)';ctx.beginPath();ctx.moveTo(-5,-17);ctx.quadraticCurveTo(0,-35,5,-17);ctx.quadraticCurveTo(0,-23,-5,-17);ctx.fill();}}
  if(v.alive&&v.hp<v.maxHp){ctx.fillStyle='rgba(0,0,0,.72)';ctx.fillRect(-25,-34,50,4);ctx.fillStyle=teamColor(v.teamId);ctx.fillRect(-25,-34,50*Math.max(0,v.hp/v.maxHp),4);}if(!v.alive){ctx.fillStyle='rgba(230,232,225,.78)';ctx.font='800 8px Segoe UI';ctx.textAlign='center';ctx.fillText(`${jeep?'JEEP':'QUAD'} · ${Math.ceil((v.respawnMs||0)/1000)} s`,0,-30);}ctx.restore();ctx.globalAlpha=1;
}
function drawSupplyCrate(c){
  const p=project(c.x,c.y,10),ammo=c.type==='ammo',col=ammo?'#b69b4d':'#6ba778';
  ctx.save();ctx.translate(p.x,p.y);ctx.fillStyle='rgba(0,0,0,.38)';ctx.beginPath();ctx.ellipse(3,8,15,6,0,0,Math.PI*2);ctx.fill();
  ctx.fillStyle=ammo?'#5c5236':'#3c5b42';ctx.strokeStyle='#1a201a';ctx.lineWidth=2;ctx.beginPath();ctx.roundRect(-12,-8,24,16,3);ctx.fill();ctx.stroke();
  ctx.strokeStyle=col;ctx.lineWidth=2;ctx.beginPath();if(ammo){ctx.moveTo(-6,0);ctx.lineTo(6,0);ctx.moveTo(-4,-4);ctx.lineTo(4,-4);ctx.moveTo(-4,4);ctx.lineTo(4,4);}else{ctx.moveTo(-6,0);ctx.lineTo(6,0);ctx.moveTo(0,-6);ctx.lineTo(0,6);}ctx.stroke();
  ctx.fillStyle='rgba(230,235,226,.75)';ctx.font='800 7px Segoe UI';ctx.textAlign='center';ctx.fillText(`${Math.ceil((c.remainingMs||0)/1000)}s`,0,19);ctx.restore();
}
function drawExplosionBurst(e){const age=performance.now()-e.born,t=Math.min(1,age/e.life),c=project(e.x,e.y,8),r=Math.max(8,e.radius*.12*(.35+t));ctx.save();ctx.globalAlpha=(1-t)*(e.accessoryId==='flash'?.75:.6);ctx.strokeStyle=e.accessoryId==='flash'?'#f5f3df':'#e0b06a';ctx.lineWidth=3*(1-t)+1;ctx.beginPath();ctx.arc(c.x,c.y,r,0,Math.PI*2);ctx.stroke();ctx.fillStyle=e.accessoryId==='flash'?'rgba(255,255,245,.32)':'rgba(220,150,75,.18)';ctx.beginPath();ctx.arc(c.x,c.y,r*.55,0,Math.PI*2);ctx.fill();ctx.restore();ctx.globalAlpha=1;}

function accessoryPreviewSpec(me){
  if(!accessoryPreviewHeld||!me?.alive||me.vehicleId||me.sprinting)return null;
  const a=accessories.find(x=>x.id===me.accessoryId);
  if(!a||a.id==='none'||(me.accessoryCharges||0)<=0)return null;
  return a;
}
function drawAccessoryPreview(){
  const me=selfPlayer(),a=accessoryPreviewSpec(me);if(!a)return;
  const ang=aimAngle(),col=a.id==='flash'?'rgba(232,234,214,.78)':'rgba(218,190,112,.72)';
  ctx.save();ctx.setLineDash([5,7]);ctx.lineWidth=1.35;ctx.strokeStyle=col;ctx.fillStyle=col;
  if(a.id==='proximity'){
    const x=me.x+Math.cos(ang)*34,y=me.y+Math.sin(ang)*34,p=project(x,y,3);
    ctx.beginPath();ctx.arc(p.x,p.y,12,0,Math.PI*2);ctx.stroke();ctx.beginPath();ctx.moveTo(p.x-6,p.y);ctx.lineTo(p.x+6,p.y);ctx.moveTo(p.x,p.y-6);ctx.lineTo(p.x,p.y+6);ctx.stroke();ctx.setLineDash([]);ctx.restore();return;
  }
  if(a.id!=='frag'&&a.id!=='flash'){ctx.restore();return;}
  let x=me.x+Math.cos(ang)*28,y=me.y+Math.sin(ang)*28,z=34;
  let vx=Math.cos(ang)*(a.id==='flash'?350:330),vy=Math.sin(ang)*(a.id==='flash'?350:330),vz=175;
  const pts=[],dt=.055,steps=Math.ceil(Math.min(2.8,(a.fuse||2800)/1000)/dt);
  for(let i=0;i<steps;i++){
    let nx=x+vx*dt,ny=y+vy*dt,nz=z+vz*dt;vz-=310*dt;
    if(particleBlocked(nx,y,7)){vx*=-.48;nx=x+vx*dt;}
    if(particleBlocked(x,ny,7)){vy*=-.48;ny=y+vy*dt;}
    x=nx;y=ny;z=nz;
    if(z<=0){z=0;if(Math.abs(vz)>42){vz=Math.abs(vz)*.36;vx*=.72;vy*=.72;}else{vz=0;vx*=.90;vy*=.90;}}
    pts.push(project(x,y,Math.max(0,z)));
  }
  if(pts.length){ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i].x,pts[i].y);ctx.stroke();const p=pts[pts.length-1];ctx.setLineDash([]);ctx.globalAlpha=.75;ctx.beginPath();ctx.arc(p.x,p.y,8,0,Math.PI*2);ctx.stroke();}
  ctx.restore();
}

function drawDamageIndicators(){const now=performance.now();for(const d of damageIndicators){const t=Math.max(0,1-(now-d.born)/d.life),a=screenAngleFromWorldAngle(d.angle),r=Math.min(innerWidth,innerHeight)*.40,x=innerWidth/2+Math.cos(a)*r,y=innerHeight/2+Math.sin(a)*r;ctx.save();ctx.globalAlpha=t*.48;ctx.strokeStyle='#e8534f';ctx.shadowColor='rgba(235,52,50,.7)';ctx.shadowBlur=18;ctx.lineWidth=9;ctx.beginPath();ctx.arc(innerWidth/2,innerHeight/2,r,a-.16,a+.16);ctx.stroke();ctx.restore();}}
function drawBlindness(me){const remain=me?Math.max(0,(me.blindedMs||0)-(performance.now()-(me.receivedAt||performance.now()))):0;const a=remain>0?Math.min(.98,.18+.8*(remain/2000)):0;if(ui.flashOverlay)ui.flashOverlay.style.opacity=String(a);}

function drawVisionMask(me){
  if(!me?.alive)return;const origin=project(me.rx,me.ry,18),a=screenAngleFromWorldAngle(me.angle),fov=Number.isFinite(me.fov)?me.fov:Math.PI,half=fov/2,r=Math.hypot(innerWidth,innerHeight)*1.8;
  visionCtx.setTransform(VISION_SCALE,0,0,VISION_SCALE,0,0);visionCtx.clearRect(0,0,innerWidth,innerHeight);visionCtx.globalCompositeOperation='source-over';visionCtx.globalAlpha=1;visionCtx.fillStyle=me.sprinting?'rgba(4,6,5,.50)':'rgba(4,6,5,.29)';visionCtx.fillRect(0,0,innerWidth,innerHeight);
  // Transition douce sans blur plein écran : plusieurs cônes semi-transparents sont découpés
  // sur un canvas basse résolution, beaucoup moins coûteux sur les GPU/navigateurs modestes.
  visionCtx.globalCompositeOperation='destination-out';
  for(let i=6;i>=0;i--){const extra=i*.018,alpha=i===0?1:.10;visionCtx.globalAlpha=alpha;visionCtx.beginPath();visionCtx.moveTo(origin.x,origin.y);visionCtx.arc(origin.x,origin.y,r,a-half-extra,a+half+extra,false);visionCtx.closePath();visionCtx.fill();}
  visionCtx.globalAlpha=1;visionCtx.globalCompositeOperation='source-over';
  ctx.save();ctx.imageSmoothingEnabled=true;ctx.drawImage(visionCanvas,0,0,innerWidth,innerHeight);const vg=ctx.createRadialGradient(innerWidth/2,innerHeight/2,Math.min(innerWidth,innerHeight)*.25,innerWidth/2,innerHeight/2,Math.max(innerWidth,innerHeight)*.72);vg.addColorStop(0,'rgba(0,0,0,0)');vg.addColorStop(1,'rgba(0,0,0,.10)');ctx.fillStyle=vg;ctx.fillRect(0,0,innerWidth,innerHeight);ctx.restore();
}
function teamMapVehicles(){const me=selfPlayer(),myTeam=me?.teamId||selectedTeam,byId=new Map();for(const v of radar.vehicles||[])if(v.teamId==null||v.teamId===myTeam)byId.set(v.id,{...v,teamId:myTeam});for(const v of worldVehicles)if(v.teamId===myTeam)byId.set(v.id,v);return[...byId.values()];}
function drawMinimap(){
  if(!map||!ui.minimapCanvas)return;
  const me=selfPlayer();
  const c=ui.minimapCanvas,w=c.width,h=c.height,pad=8,innerW=w-pad*2,innerH=h-pad*2;
  minimapCtx.clearRect(0,0,w,h);
  minimapCtx.fillStyle='#0b0f0c';minimapCtx.fillRect(0,0,w,h);
  minimapCtx.fillStyle='#1b231c';minimapCtx.fillRect(pad,pad,innerW,innerH);
  minimapCtx.strokeStyle='rgba(225,232,220,.14)';minimapCtx.lineWidth=1;minimapCtx.strokeRect(pad+.5,pad+.5,innerW-1,innerH-1);
  if(!me)return;

  // La minimap est locale : environ 350 m de largeur autour du joueur, pas la carte entière.
  const worldPerPixel=15;
  const halfWorldW=innerW*worldPerPixel*.5,halfWorldH=innerH*worldPerPixel*.5;
  const minX=me.x-halfWorldW,maxX=me.x+halfWorldW,minY=me.y-halfWorldH,maxY=me.y+halfWorldH;
  const mm=(x,y)=>({x:pad+(x-minX)/worldPerPixel,y:pad+(y-minY)/worldPerPixel});
  const visible=(x,y,margin=0)=>x>=minX-margin&&x<=maxX+margin&&y>=minY-margin&&y<=maxY+margin;

  minimapCtx.save();
  minimapCtx.beginPath();minimapCtx.rect(pad,pad,innerW,innerH);minimapCtx.clip();

  // Grille locale discrète pour donner une sensation de déplacement sans révéler la carte entière.
  minimapCtx.strokeStyle='rgba(225,232,220,.035)';minimapCtx.lineWidth=1;
  const grid=500,startGX=Math.floor(minX/grid)*grid,startGY=Math.floor(minY/grid)*grid;
  for(let x=startGX;x<=maxX;x+=grid){const a=mm(x,minY);minimapCtx.beginPath();minimapCtx.moveTo(a.x,pad);minimapCtx.lineTo(a.x,pad+innerH);minimapCtx.stroke();}
  for(let y=startGY;y<=maxY;y+=grid){const a=mm(minX,y);minimapCtx.beginPath();minimapCtx.moveTo(pad,a.y);minimapCtx.lineTo(pad+innerW,a.y);minimapCtx.stroke();}

  minimapCtx.fillStyle='rgba(218,225,211,.13)';
  for(const o of obstaclesInClientBounds(minX,minY,maxX,maxY)){
    if(o.x>maxX||o.y>maxY||o.x+o.w<minX||o.y+o.h<minY)continue;
    const a=mm(o.x,o.y);minimapCtx.fillRect(a.x,a.y,Math.max(1,o.w/worldPerPixel),Math.max(1,o.h/worldPerPixel));
  }

  if(map?.bases){const br=map.baseRadius||match?.baseRadius||700;for(const [id,b] of Object.entries(map.bases)){if(!visible(b[0],b[1],br))continue;const bp=mm(b[0],b[1]),rr=Math.max(5,br/worldPerPixel);minimapCtx.fillStyle=hexAlpha(teamColor(id),.06);minimapCtx.strokeStyle=hexAlpha(teamColor(id),.42);minimapCtx.lineWidth=1;minimapCtx.beginPath();minimapCtx.arc(bp.x,bp.y,rr,0,Math.PI*2);minimapCtx.fill();minimapCtx.stroke();}}

  const war=match?.warZone;
  if(war){
    const inside=Math.hypot(me.x-war.x,me.y-war.y)<=war.radius;if(inside){minimapCtx.fillStyle='rgba(205,177,92,.035)';minimapCtx.fillRect(pad,pad,innerW,innerH);minimapCtx.fillStyle='rgba(223,205,140,.45)';minimapCtx.font='800 7px Segoe UI';minimapCtx.textAlign='left';minimapCtx.fillText('ZONE DE GUERRE',pad+6,pad+11);}
    const wp=mm(war.x,war.y),rr=war.radius/worldPerPixel;if(wp.x+rr>=pad&&wp.x-rr<=pad+innerW&&wp.y+rr>=pad&&wp.y-rr<=pad+innerH){minimapCtx.strokeStyle='rgba(220,194,110,.34)';minimapCtx.lineWidth=1.3;minimapCtx.setLineDash([5,6]);minimapCtx.beginPath();minimapCtx.arc(wp.x,wp.y,rr,0,Math.PI*2);minimapCtx.stroke();minimapCtx.setLineDash([]);}
  }

  const objective=match?.objective;
  if(objective&&visible(objective.x,objective.y,objective.radius)){
    const p=mm(objective.x,objective.y),rx=Math.max(4,objective.radius/worldPerPixel),ry=rx;
    minimapCtx.fillStyle=objective.owner?hexAlpha(teamColor(objective.owner),.30):'rgba(235,238,230,.18)';
    minimapCtx.strokeStyle=objective.owner?teamColor(objective.owner):'#d8ddd4';minimapCtx.lineWidth=1.5;
    minimapCtx.beginPath();minimapCtx.ellipse(p.x,p.y,rx,ry,0,0,Math.PI*2);minimapCtx.fill();minimapCtx.stroke();
  }

  const myTeam=me.teamId||selectedTeam;
  for(const a of radar.allies||[]){
    if(!visible(a.x,a.y))continue;const p=mm(a.x,a.y),isMe=a.id===selfId;
    const squadMate=!!(me.squadId&&a.squadId===me.squadId&&a.id!==selfId);minimapCtx.fillStyle=isMe?'#f5f7f1':squadMate?'#68e58d':teamColor(myTeam);minimapCtx.beginPath();minimapCtx.arc(p.x,p.y,isMe?3.8:2.7,0,Math.PI*2);minimapCtx.fill();
    if(a.downed&&!isMe){minimapCtx.strokeStyle='#eef1e9';minimapCtx.lineWidth=1.2;minimapCtx.beginPath();minimapCtx.moveTo(p.x-4,p.y-4);minimapCtx.lineTo(p.x+4,p.y+4);minimapCtx.moveTo(p.x+4,p.y-4);minimapCtx.lineTo(p.x-4,p.y+4);minimapCtx.stroke();}
    if(isMe){minimapCtx.strokeStyle='#0b0e0b';minimapCtx.lineWidth=1;minimapCtx.stroke();}
  }
  for(const v of teamMapVehicles()){if(!v.alive||v.teamId!==myTeam||!visible(v.x,v.y))continue;const vp=mm(v.x,v.y);minimapCtx.fillStyle=hexAlpha(teamColor(myTeam),.9);minimapCtx.fillRect(vp.x-(v.type==='jeep'?4:3),vp.y-(v.type==='jeep'?2.5:2),v.type==='jeep'?8:6,v.type==='jeep'?5:4);}
  for(const c of worldCrates){
    if(c.teamId!==myTeam||!visible(c.x,c.y))continue;const p=mm(c.x,c.y);minimapCtx.fillStyle=c.type==='ammo'?'#b69b4d':'#6ba778';minimapCtx.fillRect(p.x-2.5,p.y-2.5,5,5);
  }
  for(const e of radar.spottedEnemies||[]){
    if(!visible(e.x,e.y))continue;const p=mm(e.x,e.y),alpha=Math.max(.22,Math.min(1,(e.remainingMs||0)/4200));
    minimapCtx.globalAlpha=alpha;minimapCtx.fillStyle=teamColor(e.teamId);minimapCtx.beginPath();minimapCtx.arc(p.x,p.y,3,0,Math.PI*2);minimapCtx.fill();
    minimapCtx.strokeStyle='rgba(245,245,235,.78)';minimapCtx.lineWidth=.8;minimapCtx.stroke();minimapCtx.globalAlpha=1;
  }

  // Le joueur reste toujours au centre de la minimap.
  minimapCtx.save();minimapCtx.translate(w/2,h/2);minimapCtx.rotate(me.angle);minimapCtx.fillStyle='#fff';
  minimapCtx.beginPath();minimapCtx.moveTo(7,0);minimapCtx.lineTo(-4.5,-4);minimapCtx.lineTo(-4.5,4);minimapCtx.closePath();minimapCtx.fill();minimapCtx.restore();
  minimapCtx.restore();

  // Si la zone est hors de la fenêtre locale, une flèche sur le bord de la minimap indique uniquement sa direction.
  if(objective&&!visible(objective.x,objective.y,objective.radius)){
    const dx=objective.x-me.x,dy=objective.y-me.y,ang=Math.atan2(dy,dx);
    const ux=Math.cos(ang),uy=Math.sin(ang),edgePad=15;
    const maxDx=innerW/2-edgePad,maxDy=innerH/2-edgePad;
    const scale=Math.min(maxDx/Math.max(.0001,Math.abs(ux)),maxDy/Math.max(.0001,Math.abs(uy)));
    const x=w/2+ux*scale,y=h/2+uy*scale;
    minimapCtx.save();minimapCtx.translate(x,y);minimapCtx.rotate(ang);
    minimapCtx.fillStyle='#e7e9df';minimapCtx.strokeStyle='rgba(4,6,5,.9)';minimapCtx.lineWidth=2;
    minimapCtx.beginPath();minimapCtx.moveTo(7,0);minimapCtx.lineTo(-5,-5);minimapCtx.lineTo(-2,0);minimapCtx.lineTo(-5,5);minimapCtx.closePath();minimapCtx.fill();minimapCtx.stroke();minimapCtx.restore();
    const distance=Math.round(Math.hypot(dx,dy)/10);
    minimapCtx.font='800 8px Segoe UI';minimapCtx.fillStyle='rgba(236,239,230,.86)';minimapCtx.textAlign=x>w/2?'right':'left';
    minimapCtx.fillText(`${distance} m`,x+(x>w/2?-10:10),Math.max(12,Math.min(h-8,y+3)));
  }
}
function drawWorldMap(){
  if(!tacticalMapOpen||!map||!ui.worldMapCanvas)return;
  const {w,h,scale}=tacticalMapMetrics();
  worldMapCtx.clearRect(0,0,w,h);worldMapCtx.fillStyle='#090d0a';worldMapCtx.fillRect(0,0,w,h);
  const toMap=(x,y)=>({x:w/2+(x-tacticalMapView.cx)*scale,y:h/2+(y-tacticalMapView.cy)*scale});
  const a=toMap(0,0),b=toMap(map.width,map.height);
  worldMapCtx.fillStyle='#182019';worldMapCtx.fillRect(a.x,a.y,b.x-a.x,b.y-a.y);
  worldMapCtx.strokeStyle='rgba(224,232,220,.16)';worldMapCtx.lineWidth=2;worldMapCtx.strokeRect(a.x,a.y,b.x-a.x,b.y-a.y);

  // Grille kilométrique : reste lisible quel que soit le niveau de zoom.
  const grid=1000;worldMapCtx.lineWidth=1;worldMapCtx.strokeStyle='rgba(225,233,220,.055)';
  for(let x=0;x<=map.width;x+=grid){const p0=toMap(x,0),p1=toMap(x,map.height);worldMapCtx.beginPath();worldMapCtx.moveTo(p0.x,p0.y);worldMapCtx.lineTo(p1.x,p1.y);worldMapCtx.stroke();}
  for(let y=0;y<=map.height;y+=grid){const p0=toMap(0,y),p1=toMap(map.width,y);worldMapCtx.beginPath();worldMapCtx.moveTo(p0.x,p0.y);worldMapCtx.lineTo(p1.x,p1.y);worldMapCtx.stroke();}

  // Bâtiments, murs, caisses et barrières sont tous visibles sur la carte tactique.
  for(const o of map.obstacles){
    const p=toMap(o.x,o.y),ow=Math.max(1.2,o.w*scale),oh=Math.max(1.2,o.h*scale);
    worldMapCtx.fillStyle=o.kind==='building'?'#59625a':o.kind==='shed'?'#4d574f':o.kind==='wall'||o.kind==='barrier'?'#788078':'#665c49';
    worldMapCtx.globalAlpha=(o.kind==='wall'||o.kind==='barrier') ? .9 : .78;worldMapCtx.fillRect(p.x,p.y,ow,oh);worldMapCtx.globalAlpha=1;
  }

  if(map?.bases){const br=map.baseRadius||match?.baseRadius||700;for(const [id,b] of Object.entries(map.bases)){const bp=toMap(b[0],b[1]),rr=Math.max(5,br*scale);worldMapCtx.fillStyle=hexAlpha(teamColor(id),.08);worldMapCtx.strokeStyle=hexAlpha(teamColor(id),.55);worldMapCtx.lineWidth=1.4;worldMapCtx.beginPath();worldMapCtx.arc(bp.x,bp.y,rr,0,Math.PI*2);worldMapCtx.fill();worldMapCtx.stroke();worldMapCtx.fillStyle=teamColor(id);worldMapCtx.font='800 9px Segoe UI';worldMapCtx.textAlign='center';worldMapCtx.fillText(`BASE ${teamName(id)}`,bp.x,bp.y+3);}}

  const war=match?.warZone;if(war){const wp=toMap(war.x,war.y),wr=Math.max(10,war.radius*scale);worldMapCtx.fillStyle='rgba(196,166,76,.055)';worldMapCtx.strokeStyle='rgba(220,194,110,.55)';worldMapCtx.lineWidth=2;worldMapCtx.setLineDash([11,8]);worldMapCtx.beginPath();worldMapCtx.arc(wp.x,wp.y,wr,0,Math.PI*2);worldMapCtx.fill();worldMapCtx.stroke();worldMapCtx.setLineDash([]);worldMapCtx.fillStyle='rgba(237,220,158,.78)';worldMapCtx.font='900 11px Segoe UI';worldMapCtx.textAlign='center';worldMapCtx.fillText('ZONE DE GUERRE',wp.x,wp.y-wr-9);}

  const o=match?.objective;if(o){
    const p=toMap(o.x,o.y),r=Math.max(7,o.radius*scale),col=o.owner?teamColor(o.owner):'#d8ddd4';
    worldMapCtx.fillStyle=o.owner?hexAlpha(col,.22):'rgba(230,236,225,.12)';worldMapCtx.strokeStyle=col;worldMapCtx.lineWidth=2;worldMapCtx.setLineDash([8,5]);
    worldMapCtx.beginPath();worldMapCtx.arc(p.x,p.y,r,0,Math.PI*2);worldMapCtx.fill();worldMapCtx.stroke();worldMapCtx.setLineDash([]);
    worldMapCtx.fillStyle='#edf1e9';worldMapCtx.font='900 12px Segoe UI';worldMapCtx.textAlign='center';worldMapCtx.fillText('POINT DE CONTRÔLE',p.x,p.y-r-8);
  }

  const me=selfPlayer(),myTeam=me?.teamId||selectedTeam;
  for(const ally of radar.allies||[]){
    const p=toMap(ally.x,ally.y),isMe=ally.id===selfId,rr=isMe?6:4;
    const squadMate=!!(me?.squadId&&ally.squadId===me.squadId&&!isMe);
    worldMapCtx.fillStyle=isMe?'#f6f8f3':squadMate?'#68e58d':teamColor(myTeam);worldMapCtx.beginPath();worldMapCtx.arc(p.x,p.y,rr,0,Math.PI*2);worldMapCtx.fill();
    if(ally.downed&&!isMe){worldMapCtx.strokeStyle='#f0f2ec';worldMapCtx.lineWidth=1.4;worldMapCtx.beginPath();worldMapCtx.moveTo(p.x-5,p.y-5);worldMapCtx.lineTo(p.x+5,p.y+5);worldMapCtx.moveTo(p.x+5,p.y-5);worldMapCtx.lineTo(p.x-5,p.y+5);worldMapCtx.stroke();}
    if(isMe){worldMapCtx.save();worldMapCtx.translate(p.x,p.y);worldMapCtx.rotate(ally.angle||me?.angle||0);worldMapCtx.fillStyle='#f6f8f3';worldMapCtx.beginPath();worldMapCtx.moveTo(12,0);worldMapCtx.lineTo(4,-4);worldMapCtx.lineTo(4,4);worldMapCtx.closePath();worldMapCtx.fill();worldMapCtx.restore();}
  }
  for(const v of teamMapVehicles()){if(!v.alive||v.teamId!==myTeam)continue;const vp=toMap(v.x,v.y);worldMapCtx.fillStyle=teamColor(myTeam);worldMapCtx.fillRect(vp.x-(v.type==='jeep'?6:4),vp.y-(v.type==='jeep'?3.5:2.5),v.type==='jeep'?12:8,v.type==='jeep'?7:5);}
  for(const c of worldCrates){
    if(c.teamId!==myTeam)continue;const p=toMap(c.x,c.y);worldMapCtx.fillStyle=c.type==='ammo'?'#b69b4d':'#6ba778';worldMapCtx.fillRect(p.x-4,p.y-4,8,8);
  }
  for(const enemy of radar.spottedEnemies||[]){
    const p=toMap(enemy.x,enemy.y),alpha=Math.max(.18,Math.min(1,(enemy.remainingMs||0)/4200));worldMapCtx.globalAlpha=alpha;
    worldMapCtx.fillStyle=teamColor(enemy.teamId);worldMapCtx.strokeStyle='rgba(245,245,235,.86)';worldMapCtx.lineWidth=1.2;worldMapCtx.beginPath();worldMapCtx.arc(p.x,p.y,5,0,Math.PI*2);worldMapCtx.fill();worldMapCtx.stroke();worldMapCtx.globalAlpha=1;
  }

  worldMapCtx.fillStyle='rgba(230,236,225,.78)';worldMapCtx.font='800 11px Segoe UI';worldMapCtx.textAlign='left';worldMapCtx.fillText(`CARTE ${Math.round(map.width/10)} × ${Math.round(map.height/10)} m`,18,h-17);
}
function worldEntityOnScreen(x,y,margin=180){const p=project(x,y,20);return p.x>=-margin&&p.x<=innerWidth+margin&&p.y>=-margin&&p.y<=innerHeight+margin;}
function render(){
  ctx.setTransform(deviceScale,0,0,deviceScale,0,0);ctx.clearRect(0,0,innerWidth,innerHeight);drawMap();drawWeaponRange(selfPlayer());drawCrateZones();
  if(map){
    const renderables=[],me=selfPlayer(),obstacles=me?obstaclesNearClient(me.rx??me.x,me.ry??me.y,renderObstacleRadius()):map.obstacles;
    for(const o of obstacles)renderables.push({sort:o.x+o.y,kind:'box',value:o});
    for(const v of worldVehicles)if(worldEntityOnScreen(v.rx??v.x,v.ry??v.y,260))renderables.push({sort:(v.rx??v.x)+(v.ry??v.y),kind:'vehicle',value:v});
    for(const p of snapshots.values())if(worldEntityOnScreen(p.rx,p.ry,220))renderables.push({sort:p.rx+p.ry+.1,kind:'player',value:p});
    for(const m of magazines)if(worldEntityOnScreen(m.x,m.y,80))renderables.push({sort:m.x+m.y,kind:'mag',value:m});
    for(const c of worldCrates)if(worldEntityOnScreen(c.x,c.y,180))renderables.push({sort:c.x+c.y,kind:'crate',value:c});
    renderables.sort((a,b)=>a.sort-b.sort);
    for(const r of renderables){if(r.kind==='box')drawBox(r.value);else if(r.kind==='vehicle')drawVehicle(r.value);else if(r.kind==='player')drawPlayer(r.value);else if(r.kind==='crate')drawSupplyCrate(r.value);else drawMagazine(r.value);}
  }
  for(const g of worldGrenades)if(worldEntityOnScreen(g.x,g.y,100))drawWorldGrenade(g);for(const r of worldRockets)if(worldEntityOnScreen(r.x,r.y,120))drawRocket(r);for(const m of worldMines)if(worldEntityOnScreen(m.x,m.y,80))drawMine(m);for(const c of casings)if(worldEntityOnScreen(c.x,c.y,60))drawCasing(c);for(const s of shots)drawShot(s);for(const f of muzzleFlashes)if(worldEntityOnScreen(f.x,f.y,80))drawMuzzleFlash(f);for(const e of explosionBursts)if(worldEntityOnScreen(e.x,e.y,420))drawExplosionBurst(e);
  drawWallFog(selfPlayer());drawVisionMask(selfPlayer());drawAccessoryPreview();const now=performance.now();if(now>=nextMinimapAt){nextMinimapAt=now+90;drawMinimap();}drawDamageIndicators();drawBlindness(selfPlayer());if(tacticalMapOpen&&performance.now()>=nextWorldMapAt){nextWorldMapAt=performance.now()+33;drawWorldMap();}
}
let last=performance.now();function frame(t){
  const frameMs=Math.max(1,Math.min(80,t-last));frameMsEma=frameMsEma*.94+frameMs*.06;const dt=Math.min(.05,frameMs/1000);last=t;
  if(t>=nextQualityEvalAt){
    nextQualityEvalAt=t+3000;
    if(frameMsEma>22&&renderQuality>.74){renderQuality=Math.max(.74,renderQuality-.10);qualityGoodSince=0;resize();}
    else if(frameMsEma<15&&renderQuality<1){if(!qualityGoodSince)qualityGoodSince=t;if(t-qualityGoodSince>9000){renderQuality=Math.min(1,renderQuality+.05);qualityGoodSince=t;resize();}}
    else qualityGoodSince=0;
  }
  updateNetworkDiagnostics(t);update(dt);render();requestAnimationFrame(frame);
}requestAnimationFrame(frame);
})();
