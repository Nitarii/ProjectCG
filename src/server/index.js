'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('./net/simple-ws');
const { SpatialHash } = require('./core/spatial-hash');
const { startFixedLoop } = require('./core/fixed-loop');
const { ProfileStore } = require('./persistence/profile-store');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_TOKEN = process.env.PROJECTPC_ADMIN_TOKEN || crypto.randomBytes(18).toString('hex');
function isValidAdminToken(value) {
  if(typeof value !== 'string' || value.length < 16 || value.length > 128)return false;
  const supplied=Buffer.from(value,'utf8'),actual=Buffer.from(ADMIN_TOKEN,'utf8');
  return supplied.length===actual.length && crypto.timingSafeEqual(supplied,actual);
}
const TEAM_TARGET_SIZE = Number(process.env.TEAM_TARGET_SIZE || 33); // combattants par équipe
const PILOTS_PER_TEAM = 2;
const MAX_HUMANS_PER_TEAM = Math.max(1, TEAM_TARGET_SIZE-PILOTS_PER_TEAM);
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || MAX_HUMANS_PER_TEAM*3); // deux places sont réservées aux navettes de chaque équipe
const BASE_RADIUS = 900;
const ROUND_PREP_MS = Number(process.env.ROUND_PREP_MS || 30000);
const TRANSPORT_XP = 35;
const WAR_ENTRY_XP = 40;
const WAR_PRESENCE_XP = 5;
const MATCH_SCORE_LIMIT = 100;
const SQUAD_IDS = ['squad1','squad2','squad3','squad4'];
const SIM_HZ = 30;
const SNAPSHOT_HZ = 15; // état réseau à 15 Hz, rendu extrapolé/interpolé côté client à la fréquence écran.
const AI_HZ = 15;       // décisions bots à 15 Hz, mouvement physique conservé à 30 Hz.
const REMOTE_PLAYER_RADIUS = 3400; // couvre largement 2x la portée de l'arme la plus longue.
const SHOT_REPLICATION_RADIUS = 3400;
const MAX_SNAPSHOT_BACKLOG = 192 * 1024;
const MAX_BROADCAST_BACKLOG = 384 * 1024;
const ALLOWED_ORIGINS = new Set(['https://nitarii.github.io', ...String(process.env.PROJECTPC_ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean)]);
const ROOT_DIR = path.resolve(__dirname, '../..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const PROFILE_FILE = path.join(DATA_DIR, 'profiles.json');

const profileStore = new ProfileStore(PROFILE_FILE);

const {BASE_SPAWNS,TEAMS,TEAM_IDS,MAP,WAR_ZONE,seededRandom}=require('./config/map');

function insideWarZoneXY(x,y,pad=0){ return Math.hypot(x-WAR_ZONE.x,y-WAR_ZONE.y) <= WAR_ZONE.radius+pad; }
function playerInsideWarZone(p){ return !!p?.alive && insideWarZoneXY(p.x,p.y); }

const {WEAPONS,EQUIPMENT,MEDICAL_ITEMS,TOOLS,ACCESSORIES,BOT_PERSONALITIES}=require('./config/catalog');

function buildBotNamePool(count=500){
  const a=['Iron','Silent','Ghost','Nova','Black','Red','Blue','Grey','Night','Dust','Wolf','Fox','Hawk','Raven','Viper','Mako','Atlas','Echo','Nomad','Rook','Sable','Kestrel','Bishop','Orion','Lynx'];
  const b=['One','Two','Six','Nine','Actual','Prime','Zero','North','South','East','West','Scout','Rider','Blade','Stone','Vox','Miller','Archer','Talon','Mace'];
  const out=[];for(const x of a)for(const y of b){out.push(`${x}${y}`);if(out.length>=count)return out;}return out;
}
const BOT_NAME_POOL = buildBotNamePool(500);
let roundBotNames=[];let nextRoundBotNameIndex=0;
function resetRoundBotNames(seed=Date.now()){
  const rnd=seededRandom((seed>>>0)^0xB075A11);roundBotNames=[...BOT_NAME_POOL];
  for(let i=roundBotNames.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[roundBotNames[i],roundBotNames[j]]=[roundBotNames[j],roundBotNames[i]];}
  nextRoundBotNameIndex=0;
}
function nextBotName(){return roundBotNames[nextRoundBotNameIndex++%roundBotNames.length]||`BOT-${nextBotSerial}`;}
resetRoundBotNames();

let profiles = loadProfiles();
let saveTimer = null;
const clients = new Map();
const players = new Map();
const shots = [];
const effects = [];
const grenades = [];
const supplyCrates = [];
const rockets = [];
const mines = [];
const vehicles = [];
let nextPlayerId = 1;
let nextEventId = 1;
let nextBotSerial = 1;
let botBalanceDirty = true;
let nextBotBalanceAt = 0;
let adminHostId = null;

const match = {
  mode:'domination3',
  scores:{ alpha:0, bravo:0, charlie:0 },
  scoreLimit:MATCH_SCORE_LIMIT,
  warControl:{occupants:{alpha:0,bravo:0,charlie:0},leader:null,tied:false,cycle:0},
  objective:{
    x:WAR_ZONE.x, y:WAR_ZONE.y, radius:950, owner:null,
    capture:{alpha:0,bravo:0,charlie:0}, contested:false, occupants:{alpha:0,bravo:0,charlie:0},
    targetX:MAP.width*.68, targetY:MAP.height*.47, speed:72, nextTargetAt:Date.now()+42000
  },
  round:1,
  prepUntil:Date.now()+ROUND_PREP_MS,
  winner:null,
  resetAt:0,
  lastScoreAt:Date.now(),
  lastZoneXpAt:Date.now(),
  lastWarScoreAt:Date.now(),
  lastObjectiveTickAt:Date.now()
};
const _initialObjective=pickObjectiveTarget(MAP.width*.18,MAP.height*.18);match.objective.x=_initialObjective.x;match.objective.y=_initialObjective.y;const _initialTarget=pickObjectiveTarget(_initialObjective.x,_initialObjective.y);match.objective.targetX=_initialTarget.x;match.objective.targetY=_initialTarget.y;
const teamSpots = Object.fromEntries(TEAM_IDS.map(id => [id, new Map()]));
let nextSpotUpdateAt = 0;

// Index dynamique des acteurs. Un seul rebuild par tick remplace de nombreux scans O(N) répétés
// par client / bots (visibilité, audio, séparation, soin, réanimation, snapshots).
const actorIndex = new SpatialHash(720);
let actorIndexBuiltAt = 0;
function rebuildActorIndex(now=Date.now()){ actorIndex.rebuild(players.values()); actorIndexBuiltAt=now; }
function nearbyActors(x,y,r){ if(actorIndex.entityCell.size!==players.size)rebuildActorIndex();return actorIndex.queryCircle(x,y,r); }

const perfStats={avgTickCostMs:0,avgLoopLagMs:0,maxLoopLagMs:0,snapshotsSent:0,snapshotsSkipped:0,shotPackets:0,wsBytesOut:0};
let cachedMatchPublic=null,cachedMatchPublicAt=0;
function matchPublicCached(now){ if(!cachedMatchPublic||now-cachedMatchPublicAt>100){cachedMatchPublic=matchPublic(now);cachedMatchPublicAt=now;} return cachedMatchPublic; }

function loadProfiles() { return profileStore.load(); }
function scheduleSave() { profileStore.schedule(profiles); }
function xpForLevel(level) {
  if (level <= 1) return 0;
  const n = level - 1;
  return Math.floor(350 * n + 110 * n * (n - 1) / 2);
}
function levelFromXp(xp) {
  let level = 1;
  while (level < 50 && xp >= xpForLevel(level + 1)) level++;
  return level;
}
function ensureProfileEconomy(p){
  if(!p||typeof p!=='object')return p;
  p.xp=Number.isFinite(p.xp)?p.xp:0;p.money=Number.isFinite(p.money)?Math.max(0,Math.round(p.money)):0;
  const raw=p.loadout&&typeof p.loadout==='object'?p.loadout:{};
  if(!p.licenses||typeof p.licenses!=='object')p.licenses={};
  for(const kind of ['weapon','equipment','medical','tool','accessory'])if(!Array.isArray(p.licenses[kind]))p.licenses[kind]=[];
  const add=(kind,id)=>{if(id&&!p.licenses[kind].includes(id))p.licenses[kind].push(id);};
  add('weapon','pistol');add('medical','bandage');add('tool','none');add('accessory','none');
  // Migration : conserve comme licences les objets déjà équipés dans les versions précédentes.
  if(!p.economyV17){p.money=Math.max(p.money||0,p.xp||0);add('weapon',raw.weaponId);for(const id of raw.equipmentIds||[])add('equipment',id);add('medical',raw.medicalId);add('tool',raw.toolId);add('accessory',raw.accessoryId);p.economyV17=true;}
  return p;
}
function hasLicense(p,kind,id){ensureProfileEconomy(p);return !!id&&p.licenses[kind]?.includes(id);}
function catalogItem(kind,id){
  if(kind==='weapon')return WEAPONS[id]||null;if(kind==='equipment')return EQUIPMENT.find(x=>x.id===id)||null;
  if(kind==='medical')return MEDICAL_ITEMS.find(x=>x.id===id)||null;if(kind==='tool')return TOOLS.find(x=>x.id===id)||null;
  if(kind==='accessory')return ACCESSORIES.find(x=>x.id===id)||null;return null;
}
function normalizeProfileLoadout(p) {
  ensureProfileEconomy(p);const level = levelFromXp(p.xp || 0);const raw = p.loadout && typeof p.loadout === 'object' ? p.loadout : {};
  const allowed=(kind,id)=>{const item=catalogItem(kind,id);return !!item&&item.level<=level&&hasLicense(p,kind,id);};
  const weaponId=allowed('weapon',raw.weaponId)?raw.weaponId:'pistol';
  let equipmentIds=Array.isArray(raw.equipmentIds)?raw.equipmentIds.filter(id=>allowed('equipment',id)):[];equipmentIds=[...new Set(equipmentIds)].slice(0,2);
  const medicalId=allowed('medical',raw.medicalId)?raw.medicalId:'bandage';
  const toolId=allowed('tool',raw.toolId)?raw.toolId:'none';const accessoryId=allowed('accessory',raw.accessoryId)?raw.accessoryId:'none';
  p.loadout={weaponId,equipmentIds,accessoryId,toolId,medicalId};return p.loadout;
}
function profileView(p) {
  ensureProfileEconomy(p);const level = levelFromXp(p.xp || 0);const loadout = normalizeProfileLoadout(p);
  return {
    nickname:p.nickname, xp:p.xp || 0, money:p.money||0, level,
    currentLevelXp:xpForLevel(level), nextLevelXp:xpForLevel(level + 1),
    kills:p.kills || 0, assists:p.assists || 0, deaths:p.deaths || 0,
    unlockedWeapons:Object.values(WEAPONS).filter(w => w.level <= level).map(w => w.id),
    unlockedEquipment:EQUIPMENT.filter(e => e.level <= level).map(e => e.id),
    unlockedAccessories:ACCESSORIES.filter(a => a.level <= level).map(a => a.id),
    unlockedTools:TOOLS.filter(a => a.level <= level).map(a => a.id),
    unlockedMedical:MEDICAL_ITEMS.filter(m => m.level <= level).map(m => m.id),
    licenses:{weapon:[...p.licenses.weapon],equipment:[...p.licenses.equipment],medical:[...p.licenses.medical],tool:[...p.licenses.tool],accessory:[...p.licenses.accessory]},
    loadout:{ weaponId:loadout.weaponId, equipmentIds:[...loadout.equipmentIds], accessoryId:loadout.accessoryId, toolId:loadout.toolId, medicalId:loadout.medicalId }
  };
}
function playerInsideObjective(player){const o=match.objective;return !!player?.alive&&Math.hypot(player.x-o.x,player.y-o.y)<=o.radius;}
function awardXp(player, amount, reason='') {
  if (!player || player.isBot || !player.profileKey || !Number.isFinite(amount) || amount === 0) return 0;
  const pr = profiles[player.profileKey]; if (!pr) return 0;ensureProfileEconomy(pr);
  const zoneBonus=amount>0&&playerInsideObjective(player);const delta=Math.round(amount*(zoneBonus?2:1));
  const beforeLevel=levelFromXp(pr.xp||0),beforeXp=pr.xp||0;pr.xp=Math.max(0,beforeXp+delta);const applied=pr.xp-beforeXp;
  const moneyDelta=delta;pr.money=Math.max(0,(pr.money||0)+moneyDelta);player.matchMoneyNet=(player.matchMoneyNet||0)+moneyDelta;
  const afterLevel=levelFromXp(pr.xp||0);if(afterLevel!==beforeLevel)botBalanceDirty=true;scheduleSave();
  send(player.ws, 'profile', { profile:profileView(pr), gainedXp:applied, gainedMoney:moneyDelta, xpReason:reason });return applied;
}
function buyLicense(p,kind,id){
  if(!p||p.isBot||!p.profileKey)return false;
  if(!p.alive||!inOwnBase(p,BASE_RADIUS)){send(p.ws,'shop_rejected',{reason:'Tu dois être vivant et dans ta base pour acheter une licence.'});return false;}
  const pr=profiles[p.profileKey];ensureProfileEconomy(pr);const item=catalogItem(kind,id);if(!item||item.level>playerLevel(p)){send(p.ws,'shop_rejected',{reason:'Objet indisponible ou niveau insuffisant.'});return false;}
  if(hasLicense(pr,kind,id)){send(p.ws,'profile',{profile:profileView(pr)});return true;}const cost=item.licenseCost||0;if((pr.money||0)<cost){send(p.ws,'shop_rejected',{reason:`Fonds insuffisants : ${cost.toLocaleString('fr-FR')} € nécessaires.`});return false;}
  pr.money-=cost;pr.licenses[kind].push(id);p.matchMoneyNet=(p.matchMoneyNet||0)-cost;scheduleSave();send(p.ws,'profile',{profile:profileView(pr),spentMoney:cost,xpReason:'LICENCE'});return true;
}
function safeNickname(value) {
  const s = String(value || '').trim().replace(/[<>\\/]/g, '');
  return (s || 'Joueur').slice(0, 18);
}
function safeTeam(teamId) { return TEAM_IDS.includes(teamId) ? teamId : 'alpha'; }
function availableHumanTeam(requested){const counts=humansPerTeam(),want=safeTeam(requested);if((counts[want]||0)<MAX_HUMANS_PER_TEAM)return want;return [...TEAM_IDS].sort((a,b)=>(counts[a]||0)-(counts[b]||0))[0];}
function validToken(token) { return typeof token === 'string' && /^[a-f0-9]{32,128}$/i.test(token); }
function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({
    '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
    '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
    '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon'
  })[ext] || 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); }
  catch { res.writeHead(400, {'content-type':'text/plain; charset=utf-8'}); return res.end('Bad request'); }
  if (!['GET','HEAD'].includes(req.method || 'GET')) { res.writeHead(405, {'allow':'GET, HEAD'}); return res.end('Method not allowed'); }
  if (urlPath === '/health') {
    res.writeHead(200, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' });
    return res.end(JSON.stringify({ ok:true, version:'2.6.0', humans:clients.size, players:players.size, uptime:Math.round(process.uptime()), map:{ width:MAP.width, height:MAP.height }, teams:teamCounts(), perf:{...perfStats} }));
  }
  let relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const publicRoot = path.resolve(PUBLIC_DIR);
  const resolved = path.resolve(PUBLIC_DIR, relative);
  if (resolved !== publicRoot && !resolved.startsWith(publicRoot + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(resolved, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const etag=`W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const headers={
      'content-type':contentType(resolved),
      'cache-control':relative.endsWith('.html') ? 'no-store' : 'public, max-age=60, must-revalidate',
      'etag':etag,'last-modified':stat.mtime.toUTCString(),
      'x-content-type-options':'nosniff','referrer-policy':'no-referrer',
      'permissions-policy':'camera=(), microphone=(), geolocation=()'
    };
    if(req.headers['if-none-match']===etag){res.writeHead(304,headers);return res.end();}
    res.writeHead(200, headers);
    if(req.method==='HEAD') return res.end();
    fs.createReadStream(resolved).pipe(res);
  });
});

const wss = new WebSocketServer({ noServer:true, maxPayload:32 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (pathname !== '/ws') return socket.destroy();
  const origin = req.headers.origin;
  if (origin) {
    let accepted = ALLOWED_ORIGINS.has(origin);
    try { const parsed = new URL(origin); accepted ||= (parsed.host === req.headers.host && ['https:','http:'].includes(parsed.protocol)); } catch {}
    if (!accepted) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

// Connexions temps réel : latence basse et nettoyage des clients fantômes.
server.keepAliveTimeout=5000;server.headersTimeout=10000;server.requestTimeout=15000;
const wsHeartbeat=setInterval(()=>{const now=Date.now();for(const ws of clients.keys()){if(ws.readyState!==WebSocket.OPEN)continue;if(now-(ws.lastPongAt||now)>45000){try{ws.close(4009,'heartbeat timeout');}catch{}continue;}ws.ping?.('pc');}},15000);wsHeartbeat.unref?.();

function send(ws, type, payload = {}) {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  const data=JSON.stringify({ type, ...payload });
  const accepted=ws.send(data);
  if(accepted)perfStats.wsBytesOut+=Buffer.byteLength(data);
  return accepted;
}
function broadcast(type, payload = {}) {
  const data = JSON.stringify({ type, ...payload });
  const bytes=Buffer.byteLength(data);
  for (const ws of clients.keys()) if(ws.readyState===WebSocket.OPEN && ws.bufferedAmount<=MAX_BROADCAST_BACKLOG){
    if(ws.send(data))perfStats.wsBytesOut+=bytes;
  }
}
function teamCounts() {
  const out = {};
  for (const id of TEAM_IDS) out[id] = { humans:0, bots:0, total:0 };
  for (const p of players.values()) {
    const row = out[p.teamId]; if (!row) continue;
    if (p.isBot) row.bots++; else row.humans++;
    row.total++;
  }
  return out;
}
function teamPublicState() {
  const counts = teamCounts();
  return TEAM_IDS.map(id => ({ ...TEAMS[id], score:match.scores[id], ...counts[id] }));
}
function objectivePublic(now) {
  const o = match.objective;
  return {
    x:o.x, y:o.y, radius:o.radius, owner:o.owner, capture:{...o.capture}, contested:o.contested,
    occupants:{...o.occupants}, targetX:o.targetX, targetY:o.targetY, speed:o.speed,
    retargetInMs:Math.max(0,(o.nextTargetAt||now)-now), moving:true
  };
}
function matchPublic(now) {
  return { mode:'pointcontrol', round:match.round, scores:{...match.scores}, scoreLimit:match.scoreLimit, winner:match.winner, prepMs:Math.max(0,(match.prepUntil||0)-now), baseRadius:BASE_RADIUS, teams:teamPublicState(), warZone:{...WAR_ZONE}, warControl:{occupants:{...(match.warControl?.occupants||{})},leader:match.warControl?.leader||null,tied:!!match.warControl?.tied,cycle:Math.max(0,Math.min(1,match.warControl?.cycle||0))}, objective:objectivePublic(now) };
}

function teamSpawn(teamId, jitter = 230) {
  const base = TEAMS[safeTeam(teamId)].spawn;
  for (let i=0;i<25;i++) {
    const a = Math.random()*Math.PI*2, d = 45 + Math.random()*jitter;
    const x=base[0]+Math.cos(a)*d, y=base[1]+Math.sin(a)*d;
    if (canStandAt(x,y,24)) return {x,y};
  }
  return {x:base[0],y:base[1]};
}

function distanceToBase(teamId,x,y){const b=TEAMS[safeTeam(teamId)].spawn;return Math.hypot(x-b[0],y-b[1]);}
function inTeamBase(teamId,x,y,radius=BASE_RADIUS){return distanceToBase(teamId,x,y)<=radius;}
function inOwnBase(p,radius=BASE_RADIUS){return !!p&&inTeamBase(p.teamId,p.x,p.y,radius);}
function inEnemyBase(teamId,x,y,radius=BASE_RADIUS){return TEAM_IDS.some(id=>id!==teamId&&inTeamBase(id,x,y,radius));}
function prepActive(now=Date.now()){return now<(match.prepUntil||0);}
function playerCanStandAt(p,x,y,now=Date.now()){
  if(!canStandAt(x,y,p.radius||24))return false;
  if(inEnemyBase(p.teamId,x,y))return false;
  if(prepActive(now)&&!inTeamBase(p.teamId,x,y,BASE_RADIUS-18))return false;
  return true;
}
function vehicleCanStandAt(v,x,y,now=Date.now()){
  if(!canStandAt(x,y,v.radius||40)||inEnemyBase(v.teamId,x,y,BASE_RADIUS+20))return false;
  if(prepActive(now)&&!inTeamBase(v.teamId,x,y,BASE_RADIUS-30))return false;
  return true;
}
const VEHICLE_SPEED_SCALE=Math.max(.1,Number(process.env.VEHICLE_SPEED_SCALE||1));
const VEHICLE_CONFIG={
  quad:{radius:40,maxHp:220,speed:700*VEHICLE_SPEED_SCALE,passengerCapacity:1,explosionRadius:390,explosionDamage:130},
  jeep:{radius:56,maxHp:430,speed:590*VEHICLE_SPEED_SCALE,passengerCapacity:4,explosionRadius:440,explosionDamage:150}
};
function makeVehicle(type,teamId,x,y,id,pilotSlot=null){
  const cfg=VEHICLE_CONFIG[type],safe=nearestSafeBotPoint(x,y,cfg.radius);
  return{id,type,teamId,pilotSlot,spawnX:safe.x,spawnY:safe.y,x:safe.x,y:safe.y,angle:0,vx:0,vy:0,radius:cfg.radius,hp:cfg.maxHp,maxHp:cfg.maxHp,speed:cfg.speed,
    passengerCapacity:cfg.passengerCapacity,driverId:null,passengerIds:[],reservedPassengerIds:[],reservedPassengerSeats:{},reservedDriverId:null,respawnAt:0,alive:true,lastDamagedAt:0,lastOccupiedAt:0,everUsed:false,burningAt:0,abandonedSince:0,shuttleState:pilotSlot==null?null:'base',shuttleDepartAt:0,
    aiWaypoint:null,aiWaypointUntil:0,aiPath:null,aiPathIndex:0,aiPathUntil:0,aiPathDestX:null,aiPathDestY:null,aiNextPathAt:0,
    aiLastX:safe.x,aiLastY:safe.y,aiNextStuckCheck:0,aiStuckCount:0,aiEscapeUntil:0,aiEscapeX:0,aiEscapeY:0,departAt:0,transportCredited:new Set()};
}
function initializeVehicles(){
  if(vehicles.length)return;
  let q=1,j=1;
  for(const teamId of TEAM_IDS){
    const [bx,by]=TEAMS[teamId].spawn;
    for(const [ox,oy] of [[-210,130],[0,235],[210,130]])vehicles.push(makeVehicle('quad',teamId,bx+ox,by+oy,`quad-${q++}`));
    vehicles.push(makeVehicle('jeep',teamId,bx,by-190,`jeep-${j++}`));
    vehicles.push(makeVehicle('jeep',teamId,bx-250,by-220,`pilot-jeep-${teamId}-1`,0));
    vehicles.push(makeVehicle('jeep',teamId,bx+250,by-220,`pilot-jeep-${teamId}-2`,1));
  }
}
function vehicleOccupantIds(v){return[v.driverId,...(v.passengerIds||[])].filter(Boolean);}
function vehicleHasFreePassenger(v){return (v.passengerIds||[]).length+(v.reservedPassengerIds||[]).length<(v.passengerCapacity||1);}
function vehicleEmpty(v){return !v.driverId&&!(v.passengerIds||[]).length;}
function vehicleSeatPosition(v,seat){
  const ca=Math.cos(v.angle),sa=Math.sin(v.angle),px=-sa,py=ca;let forward=0,side=0;
  if(seat==='driver'){forward=v.type==='jeep'?14:8;side=v.type==='jeep'?-15:-5;}
  else{
    const idx=Math.max(0,Number(String(seat||'passenger0').replace('passenger',''))||0);
    if(v.type==='quad'){forward=-15;side=4;}
    else if(idx===0){forward=13;side=15;}else{forward=-18;side=(idx-2)*19;}
  }
  return{x:v.x+ca*forward+px*side,y:v.y+sa*forward+py*side};
}
function clearVehicleReservation(p){
  if(!p)return;
  for(const v of vehicles){
    if(v.reservedDriverId===p.id)v.reservedDriverId=null;
    v.reservedPassengerIds=(v.reservedPassengerIds||[]).filter(id=>id!==p.id);
    if(v.reservedPassengerSeats)delete v.reservedPassengerSeats[p.id];
  }
  if(p.brain){p.brain.wantedVehicleId=null;p.brain.passengerWaitSince=0;p.brain.vehicleReservedAt=0;}
}
function passengerSpaceFor(v,id){const occupied=(v.passengerIds||[]).length,res=(v.reservedPassengerIds||[]).filter(x=>x!==id).length;return occupied+res<(v.passengerCapacity||1);}
function occupiedPassengerSeats(v){return new Set((v.passengerIds||[]).map(id=>players.get(id)?.vehicleSeat).filter(Boolean));}
function nextPassengerSeat(v,ignoreReservationId=null){
  const used=occupiedPassengerSeats(v);
  for(const [rid,seat] of Object.entries(v.reservedPassengerSeats||{}))if(rid!==String(ignoreReservationId||''))used.add(seat);
  for(let i=0;i<(v.passengerCapacity||1);i++){const seat=`passenger${i}`;if(!used.has(seat))return seat;}
  return null;
}
function reservePassenger(p,v,now=Date.now()){
  if(!p||!v||!passengerSpaceFor(v,p.id))return false;
  const existing=v.reservedPassengerSeats?.[p.id];
  if(existing&&p.brain?.wantedVehicleId===v.id)return true;
  const seat=nextPassengerSeat(v,p.id);if(!seat)return false;
  clearVehicleReservation(p);
  v.reservedPassengerIds=v.reservedPassengerIds||[];v.reservedPassengerSeats=v.reservedPassengerSeats||{};
  if(!v.reservedPassengerIds.includes(p.id))v.reservedPassengerIds.push(p.id);
  v.reservedPassengerSeats[p.id]=seat;
  p.brain.wantedVehicleId=v.id;p.brain.vehicleReservedAt=now;
  return true;
}
function reserveDriver(p,v,now=Date.now()){
  if(!p||!v||v.pilotSlot!=null||v.driverId||(v.reservedDriverId&&v.reservedDriverId!==p.id))return false;
  if(v.reservedDriverId===p.id&&p.brain?.wantedVehicleId===v.id)return true;
  clearVehicleReservation(p);v.reservedDriverId=p.id;p.brain.wantedVehicleId=v.id;p.brain.vehicleReservedAt=now;return true;
}

// Chaque réservation possède un point d'embarquement distinct autour du véhicule. Dans les
// anciennes versions, 4 à 10 bots visaient tous le centre exact d'une jeep : leur répulsion
// mutuelle créait alors un bouchon et une seule place pouvait rester vide pendant très longtemps.
function vehicleBoardingPoint(v,p,mode='passenger'){
  const ca=Math.cos(v.angle),sa=Math.sin(v.angle),px=-sa,py=ca;
  let forward=0,side=0;
  if(mode==='driver'){
    forward=v.type==='jeep'?16:8;side=-(v.radius+44);
  }else{
    const seat=v.reservedPassengerSeats?.[p.id]||p.vehicleSeat||'passenger0';
    const idx=Math.max(0,Number(String(seat).replace('passenger',''))||0);
    if(v.type==='quad'){forward=-12;side=v.radius+38;}
    else if(idx===0){forward=18;side=v.radius+46;}
    else if(idx===1){forward=-24;side=-(v.radius+46);}
    else if(idx===2){forward=-(v.radius+54);side=-24;}
    else{forward=-24;side=v.radius+46;}
  }
  const raw={x:v.x+ca*forward+px*side,y:v.y+sa*forward+py*side};
  return nearestSafeBotPoint(raw.x,raw.y,botNavRadius(p));
}
function nearestVehicle(p,maxDistance=92,mode='any'){
  let best=null,bd=maxDistance;
  for(const v of vehicles){
    if(!v.alive||v.teamId!==p.teamId)continue;
    const usable=mode==='driver'?!v.driverId:mode==='passenger'?!!v.driverId&&vehicleHasFreePassenger(v):(!v.driverId||vehicleHasFreePassenger(v));
    if(!usable)continue;const d=Math.hypot(v.x-p.x,v.y-p.y);if(d<bd){best=v;bd=d;}
  }
  return best;
}
function enterVehicle(p,v,preferPassenger=false,now=Date.now()){
  if(!p?.alive||p.vehicleId||!v?.alive||v.teamId!==p.teamId)return false;
  let seat=null;
  if(v.pilotSlot!=null&&(!p.pilotRole||p.pilotSlot!==v.pilotSlot)&&!v.driverId)return false;
  if(preferPassenger&&v.driverId&&passengerSpaceFor(v,p.id)){
    const reserved=v.reservedPassengerSeats?.[p.id];
    seat=reserved&&!occupiedPassengerSeats(v).has(reserved)?reserved:nextPassengerSeat(v,p.id);
  }
  else if(!v.driverId&&(v.pilotSlot==null||(p.pilotRole&&p.pilotSlot===v.pilotSlot)))seat='driver';
  else if(passengerSpaceFor(v,p.id)){
    const reserved=v.reservedPassengerSeats?.[p.id];
    seat=reserved&&!occupiedPassengerSeats(v).has(reserved)?reserved:nextPassengerSeat(v,p.id);
  }
  if(!seat)return false;
  if(seat==='driver'){v.driverId=p.id;v.reservedDriverId=null;const wait=p.isBot?(p.pilotRole?0:950):150;if(p.isBot)v.departAt=Math.max(v.departAt||0,now+wait);else v.departAt=now+wait;}else{v.passengerIds.push(p.id);v.reservedPassengerIds=(v.reservedPassengerIds||[]).filter(id=>id!==p.id);}
  if(v.reservedPassengerSeats)delete v.reservedPassengerSeats[p.id];
  p.vehicleId=v.id;p.vehicleSeat=seat;p.sprinting=false;p.input.sprint=false;p.dragTargetId&&dropDragged(p);cancelRevive(p);v.everUsed=true;v.abandonedSince=0;v.burningAt=0;v.lastOccupiedAt=now;
  const pos=vehicleSeatPosition(v,seat);p.x=pos.x;p.y=pos.y;return true;
}
function leaveVehicle(p){
  if(!p?.vehicleId)return false;const v=vehicles.find(v=>v.id===p.vehicleId);const oldSeat=p.vehicleSeat;
  if(v){if(String(oldSeat||'').startsWith('passenger'))creditTransportDrop(v,p,Date.now());if(v.driverId===p.id)v.driverId=null;v.passengerIds=(v.passengerIds||[]).filter(id=>id!==p.id);v.reservedPassengerIds=(v.reservedPassengerIds||[]).filter(id=>id!==p.id);if(v.reservedPassengerSeats)delete v.reservedPassengerSeats[p.id];if(v.reservedDriverId===p.id)v.reservedDriverId=null;
    const side=oldSeat==='driver'?-1:1,a=v.angle+Math.PI/2,x=v.x+Math.cos(a)*(v.radius+32)*side,y=v.y+Math.sin(a)*(v.radius+32)*side;
    const safe=nearestSafeBotPoint(x,y,p.radius||24);p.x=safe.x;p.y=safe.y;v.lastOccupiedAt=Date.now();if(vehicleEmpty(v)&&v.everUsed&&!inTeamBase(v.teamId,v.x,v.y,BASE_RADIUS*.85))v.abandonedSince=Date.now();
  }
  p.vehicleId=null;p.vehicleSeat=null;return true;
}
function resetBotNavAfterVehicle(bot,now=Date.now()){
  if(!bot?.isBot||!bot.brain)return;
  const b=bot.brain;b.wantedVehicleId=null;b.passengerWaitSince=0;b.vehicleDriveX=0;b.vehicleDriveY=0;
  b.navWaypoint=null;b.navObstacleKey=null;b.navPath=null;b.navPathIndex=0;b.nextPathAt=0;b.stuckCount=0;
  b.lastX=bot.x;b.lastY=bot.y;b.nextStuckCheck=now+500;b.vehicleWaitUntil=Math.max(b.vehicleWaitUntil||0,now+7000);
}
function disembarkBotInsideWar(bot,v,now=Date.now()){
  if(!bot?.vehicleId||!v)return false;
  leaveVehicle(bot);resetBotNavAfterVehicle(bot,now);
  // Les occupants descendent suffisamment à l'intérieur de la zone pour éviter une boucle
  // descendre -> être replacé juste hors zone -> remonter dans le même véhicule.
  if(!insideWarZoneXY(bot.x,bot.y,-70)){
    const dx=WAR_ZONE.x-v.x,dy=WAR_ZONE.y-v.y,d=Math.hypot(dx,dy)||1,nx=dx/d,ny=dy/d;
    for(const step of [140,230,340,480,650]){
      const safe=nearestSafeBotPoint(v.x+nx*step,v.y+ny*step,botNavRadius(bot));
      if(insideWarZoneXY(safe.x,safe.y,-70)&&canStandAt(safe.x,safe.y,botNavRadius(bot))){bot.x=safe.x;bot.y=safe.y;break;}
    }
  }
  return true;
}
function passengerTakeDriverSeat(p,now=Date.now()){
  if(!p?.alive||!p.vehicleId||!String(p.vehicleSeat||'').startsWith('passenger'))return false;
  const v=vehicles.find(v=>v.id===p.vehicleId);if(!v?.alive)return false;
  const current=v.driverId?players.get(v.driverId):null;
  // Un conducteur humain ou un pilote attitré ne peut jamais être expulsé par son passager.
  if(current&&(!current.isBot||current.pilotRole))return false;
  if(current?.isBot){
    leaveVehicle(current);
    current.brain.vehicleDriveX=0;current.brain.vehicleDriveY=0;current.brain.wantedVehicleId=null;
    current.brain.vehicleWaitUntil=now+4500;
  }
  v.passengerIds=(v.passengerIds||[]).filter(id=>id!==p.id);v.driverId=p.id;p.vehicleSeat='driver';
  v.departAt=0;v.lastOccupiedAt=now;v.abandonedSince=0;v.burningAt=0;
  const pos=vehicleSeatPosition(v,'driver');p.x=pos.x;p.y=pos.y;p.aiming=false;return true;
}
function toggleVehicle(p){
  if(!p.alive)return false;
  if(p.vehicleId){
    if(String(p.vehicleSeat||'').startsWith('passenger')&&passengerTakeDriverSeat(p,Date.now()))return true;
    return leaveVehicle(p);
  }
  const v=nearestVehicle(p,p.isBot?105:96);if(!v)return false;return enterVehicle(p,v,false,Date.now());
}
function kickVehiclePassengers(p,now=Date.now()){
  if(!p?.vehicleId||p.vehicleSeat!=='driver')return false;const v=vehicles.find(v=>v.id===p.vehicleId);if(!v)return false;
  for(const id of [...(v.passengerIds||[])]){const target=players.get(id);if(target)leaveVehicle(target);}v.passengerIds=[];v.lastOccupiedAt=now;return true;
}
function ejectVehicleOccupants(v,now,exploding=false){
  for(const id of vehicleOccupantIds(v)){
    const p=id&&players.get(id);if(!p)continue;p.vehicleId=null;p.vehicleSeat=null;
    const safe=nearestSafeBotPoint(v.x+(Math.random()-.5)*(v.radius*2.8),v.y+(Math.random()-.5)*(v.radius*2.8),p.radius||24);p.x=safe.x;p.y=safe.y;
    if(exploding&&p.alive)applyDamage(p,p,v.type==='jeep'?135:155,now);
  }
  v.driverId=null;v.passengerIds=[];v.reservedPassengerIds=[];v.reservedPassengerSeats={};v.reservedDriverId=null;
}
function destroyVehicle(v,now,attacker=null){
  if(!v.alive)return;const cfg=VEHICLE_CONFIG[v.type]||VEHICLE_CONFIG.quad;v.alive=false;v.hp=0;v.vx=v.vy=0;v.respawnAt=now+12000;v.burningAt=0;v.abandonedSince=0;
  effects.push({id:String(nextEventId++),type:'vehicle_explosion',shooterId:attacker?.id||null,x:v.x,y:v.y,radius:cfg.explosionRadius,vehicleType:v.type,at:now});
  ejectVehicleOccupants(v,now,true);if(attacker)applyExplosionDamage(attacker,v.x,v.y,cfg.explosionRadius,now,cfg.explosionDamage);
}
function applyVehicleDamage(attacker,v,amount,now){
  if(!v?.alive||amount<=0)return;v.hp-=amount;v.lastDamagedAt=now;if(v.hp<=0)destroyVehicle(v,now,attacker);
}
function vehicleDriveTarget(v,target,now){
  const navTarget=resolveVehicleNavigationTarget(v,target,now),dx=navTarget.x-v.x,dy=navTarget.y-v.y,d=Math.hypot(dx,dy)||1;
  return{x:dx/d,y:dy/d};
}
function creditTransportDrop(v,passenger,now){
  if(!v||!passenger||!String(passenger.vehicleSeat||'').startsWith('passenger'))return;
  const driver=v.driverId&&players.get(v.driverId);if(!driver?.alive||driver.teamId!==passenger.teamId||driver.id===passenger.id)return;
  const nearControl=Math.hypot(v.x-match.objective.x,v.y-match.objective.y)<=500;if(!insideWarZoneXY(v.x,v.y)&&!nearControl)return;
  if(driver.isBot)return;
  if(!driver.transportCredits)driver.transportCredits=new Set();const key=`${passenger.id}:${passenger.lifeId||1}`;
  if(!driver.transportCredits.has(key)){driver.transportCredits.add(key);awardXp(driver,TRANSPORT_XP,'TRANSPORT');}
  if(!(passenger.transportSponsorIds instanceof Set))passenger.transportSponsorIds=new Set();passenger.transportSponsorIds.add(driver.id);
}
function awardVehicleTransportXp(v,now){ /* crédit attribué au moment où le passager descend */ }
function resetVehicle(v,now){
  const cfg=VEHICLE_CONFIG[v.type]||VEHICLE_CONFIG.quad;ejectVehicleOccupants(v,now,false);v.x=v.spawnX;v.y=v.spawnY;v.angle=0;v.hp=cfg.maxHp;v.maxHp=cfg.maxHp;v.alive=true;v.respawnAt=0;v.vx=v.vy=0;v.burningAt=0;v.abandonedSince=0;v.everUsed=false;v.aiWaypoint=null;v.aiPath=null;v.aiPathIndex=0;v.aiNextPathAt=0;v.aiStuckCount=0;v.aiEscapeUntil=0;v.aiLastX=v.x;v.aiLastY=v.y;v.transportCredited=new Set();v.reservedPassengerIds=[];v.reservedPassengerSeats={};v.reservedDriverId=null;v.shuttleState=v.pilotSlot==null?null:'base';v.shuttleDepartAt=0;
}
function updateVehicles(dt,now){
  for(const v of vehicles){
    if(!v.alive){if(v.respawnAt&&now>=v.respawnAt)resetVehicle(v,now);continue;}
    const driver=v.driverId&&players.get(v.driverId);if(v.driverId&&(!driver||!driver.alive||driver.vehicleId!==v.id)){v.driverId=null;}
    v.passengerIds=(v.passengerIds||[]).filter(id=>{const p=players.get(id);return !!p&&p.alive&&p.vehicleId===v.id;});
    v.reservedPassengerIds=(v.reservedPassengerIds||[]).filter(id=>{const p=players.get(id);return !!p?.alive&&p.brain?.wantedVehicleId===v.id&&!insideWarZoneXY(p.x,p.y);});
    v.reservedPassengerSeats=v.reservedPassengerSeats||{};
    for(const id of Object.keys(v.reservedPassengerSeats))if(!v.reservedPassengerIds.includes(id))delete v.reservedPassengerSeats[id];
    if(v.reservedDriverId){const r=players.get(v.reservedDriverId);if(!r?.alive||r.brain?.wantedVehicleId!==v.id)v.reservedDriverId=null;}
    if(vehicleEmpty(v)){
      if(v.pilotSlot!=null){v.abandonedSince=0;v.burningAt=0;}else
      if(v.everUsed&&!inTeamBase(v.teamId,v.x,v.y,BASE_RADIUS*.85)){
        if(!v.abandonedSince)v.abandonedSince=now;
        if(!v.burningAt&&now-v.abandonedSince>=20000){v.burningAt=now+5000;effects.push({id:String(nextEventId++),type:'vehicle_burning',x:v.x,y:v.y,vehicleType:v.type,at:now});}
        if(v.burningAt&&now>=v.burningAt){destroyVehicle(v,now,null);continue;}
      }else{v.abandonedSince=0;v.burningAt=0;}
    }else{v.lastOccupiedAt=now;v.abandonedSince=0;v.burningAt=0;}
    // Les véhicules alliés sont réparés automatiquement lorsqu'ils reviennent dans leur base.
    if(inTeamBase(v.teamId,v.x,v.y,BASE_RADIUS*.92)&&v.hp<v.maxHp&&now-(v.lastDamagedAt||0)>900){v.hp=Math.min(v.maxHp,v.hp+v.maxHp*.40*dt);}
    let dx=0,dy=0;
    if(driver){
      if(driver.isBot){dx=driver.brain?.vehicleDriveX||0;dy=driver.brain?.vehicleDriveY||0;}
      else{const sx=(driver.input.right?1:0)-(driver.input.left?1:0),sy=(driver.input.down?1:0)-(driver.input.up?1:0);dx=sx+sy;dy=-sx+sy;}
      const len=Math.hypot(dx,dy);if(len){dx/=len;dy/=len;const desired=Math.atan2(dy,dx);v.angle=normalizeAngle(v.angle+angleDelta(desired,v.angle)*Math.min(1,dt*(v.type==='jeep'?4.2:5.3)));}
      if(now<(v.departAt||0)){dx=0;dy=0;}
    }
    const wantsMove=Math.hypot(dx,dy)>0;const speed=wantsMove?(v.speed||520):0;v.vx=dx*speed;v.vy=dy*speed;
    const nx=v.x+v.vx*dt,ny=v.y+v.vy*dt;
    let blocked=false;if(vehicleCanStandAt(v,nx,v.y,now))v.x=nx;else{v.vx=0;blocked=true;}
    if(vehicleCanStandAt(v,v.x,ny,now))v.y=ny;else{v.vy=0;blocked=true;}
    if(driver?.isBot){if(blocked){clearVehicleNav(v);v.aiNextPathAt=0;}updateVehicleStuckRecovery(v,driver,now,wantsMove);}
    for(const id of vehicleOccupantIds(v)){
      const p=players.get(id);if(!p)continue;const pos=vehicleSeatPosition(v,p.vehicleSeat);p.x=pos.x;p.y=pos.y;p.vx=v.vx;p.vy=v.vy;p.actualSpeed=Math.hypot(v.vx,v.vy);p.sprinting=false;p.aiming=false;
    }
    awardVehicleTransportXp(v,now);
  }
}
function publicVehicle(v,now){const driver=v.driverId&&players.get(v.driverId);const occupants=[];if(driver)occupants.push({id:driver.id,nickname:driver.nickname,seat:'driver',isBot:!!driver.isBot});for(const id of v.passengerIds||[]){const p=players.get(id);if(p)occupants.push({id:p.id,nickname:p.nickname,seat:p.vehicleSeat||'passenger',isBot:!!p.isBot});}return{id:v.id,type:v.type,teamId:v.teamId,x:v.x,y:v.y,angle:v.angle,vx:v.vx,vy:v.vy,hp:Math.max(0,Math.round(v.hp)),maxHp:v.maxHp,radius:v.radius,alive:v.alive,driverId:v.driverId,driverIsBot:!!driver?.isBot,passengerId:v.passengerIds?.[0]||null,passengerIds:[...(v.passengerIds||[])],passengerCapacity:v.passengerCapacity||1,occupants,smoking:v.alive&&v.hp/v.maxHp<=.70,burning:!!v.burningAt,burnMs:v.burningAt?Math.max(0,v.burningAt-now):0,respawnMs:!v.alive?Math.max(0,v.respawnAt-now):0};}

function makeHumanPlayer(ws, profileKey, profile, teamId) {
  const spawn = teamSpawn(teamId);
  const level = levelFromXp(profile.xp || 0);
  normalizeProfileLoadout(profile);
  // Chaque nouvelle vie commence avec le matériel gratuit. Les licences persistent mais le stuff doit être racheté.
  const equipmentIds = [];
  const armor = false;
  const weaponId = 'pistol';
  const accessoryId = 'none';
  const toolId = 'none';
  const accessory = ACCESSORIES[0];
  const medicalId = 'bandage';
  const medical = MEDICAL_ITEMS[0];
  const w = WEAPONS[weaponId] || WEAPONS.pistol;
  return {
    id:String(nextPlayerId++), ws, profileKey, nickname:profile.nickname, isBot:false, botPersonality:null,
    teamId:safeTeam(teamId), x:spawn.x, y:spawn.y, vx:0, vy:0, radius:24, hitRadius:27, angle:0,
    hp:armor ? 125 : 100, maxHp:armor ? 125 : 100, alive:true, downed:false, downedAt:0, downedMeta:null, giveUpAt:0, bleedoutAt:0,
    input:{ up:false, down:false, left:false, right:false, sprint:false },
    aiming:false, sprinting:false, stamina:100, maxStamina:100, staminaRegenAt:0,
    weaponId, equipmentIds, accessoryId, accessoryCharges:accessory.maxCharges||0, toolId, toolReadyAt:0, medicalId, medicalCharges:medical.maxCharges, medicalUseUntil:0,
    healOverTimeUntil:0, nextHealOverTimeAt:0, staminaBuffUntil:0,
    vehicleId:null, vehicleSeat:null, dragTargetId:null, draggedById:null, lifeId:1, lastDamagedAt:0, transportCredits:new Set(),
    ammo:w.mag, reserveAmmo:w.mag*4, reserveMax:w.mag*4, reloadingUntil:0, lastShotAt:0, bloom:0, respawnAt:0, blindedUntil:0,
    reviveTargetId:null, reviveStartedAt:0, reviveDuration:0, beingRevivedById:null,
    lastInputAt:Date.now(), joinedAt:Date.now(), matchKills:0, matchAssists:0, matchDeaths:0, matchMoneyNet:0, damageContrib:new Map(),
    godMode:false,isAdmin:false,squadId:null,warEntryLifeId:0,reviveSponsorIds:new Set(),transportSponsorIds:new Set(),lifeLoadoutPaid:false,
    medicalTargetId:null,beingHealedById:null,healLockUntil:0,
    netEventCursor:nextEventId-1,netNextMetaAt:0,botLevel:level
  };
}
function humanLevelPool(){
  const levels=[...players.values()].filter(p=>!p.isBot&&p.profileKey).map(p=>levelFromXp(profiles[p.profileKey]?.xp||0)).filter(Number.isFinite);
  if(!levels.length)return[1];const min=Math.min(...levels),lo=Math.max(1,min-2),hi=Math.min(50,min+2),pool=[];for(let lv=lo;lv<=hi;lv++)pool.push(lv);return pool;
}
function preferredWeaponCategories(personalityId){
  if(personalityId==='marksman'||personalityId==='cautious')return['sniper','dmr','semi','assault','pistol'];
  if(personalityId==='breacher')return['shotgun','smg','assault','pistol'];
  if(personalityId==='medic'||personalityId==='support')return['smg','assault','semi','pistol'];
  if(personalityId==='flanker'||personalityId==='scout')return['smg','assault','pistol'];
  if(personalityId==='sentinel')return['semi','assault','dmr','pistol'];
  return['assault','smg','semi','pistol'];
}
function pickBotWeapon(level,personalityId){
  // Les bots ont accès à leur niveau simulé, mais utilisent beaucoup plus souvent du matériel courant
  // que les armes très chères/haut niveau. Cela évite d'inonder la partie de DMR/snipers rares.
  let effectiveLevel=level;
  const roll=Math.random();
  if(roll<.42)effectiveLevel=Math.max(1,level-3-Math.floor(Math.random()*2));
  else if(roll<.76)effectiveLevel=Math.max(1,level-1-Math.floor(Math.random()*2));
  const unlocked=Object.values(WEAPONS).filter(w=>w.level<=effectiveLevel);
  const order=preferredWeaponCategories(personalityId);
  for(const category of order){
    let pool=unlocked.filter(w=>w.category===category).sort((a,b)=>b.level-a.level);
    if(['sniper','dmr'].includes(category)&&Math.random()<.70)pool=[];
    if(pool.length){
      const top=pool.slice(0,Math.min(3,pool.length));
      const idx=Math.min(top.length-1,Math.floor(Math.pow(Math.random(),.55)*top.length));
      return top[idx].id;
    }
  }
  const common=unlocked.filter(w=>['pistol','smg','assault','semi','shotgun'].includes(w.category));
  return (common[Math.floor(Math.random()*common.length)]||unlocked.at(-1)||WEAPONS.pistol).id;
}
function chooseBotAccessory(level,personalityId){
  const unlocked=ACCESSORIES.filter(a=>a.level<=level).map(a=>a.id);
  const prefs=personalityId==='marksman'?['proximity','flash','frag','rocket']:
    personalityId==='support'?['flash','frag','proximity','rocket']:
    personalityId==='flanker'?['flash','frag','proximity','rocket']:
    ['frag','flash','rocket','proximity'];
  return prefs.find(id=>unlocked.includes(id))||(unlocked[0]||'none');
}
function chooseBotTool(level,personalityId){
  const unlocked=TOOLS.filter(a=>a.level<=level).map(a=>a.id);
  const prefs=(personalityId==='support'||personalityId==='medic')?['defib','medcrate','ammocrate','healstim','stamstim']:
    personalityId==='marksman'?['ammocrate','healstim','stamstim','medcrate','defib']:
    personalityId==='flanker'?['stamstim','healstim','ammocrate','medcrate','defib']:
    ['healstim','stamstim','ammocrate','medcrate','defib'];
  return prefs.find(id=>unlocked.includes(id))||(unlocked[0]||'none');
}
function chooseBotMedical(level,personalityId){
  const unlocked=MEDICAL_ITEMS.filter(m=>m.level<=level);
  if(!unlocked.length)return MEDICAL_ITEMS[0];
  if(['support','medic','cautious','marksman'].includes(personalityId))return unlocked.at(-1);
  if(unlocked.length>=2&&Math.random()<.42)return unlocked.at(-2);
  return unlocked.at(-1);
}
function chooseBotEquipment(level,personalityId,weaponId){
  const out=[];
  if(level>=4&&(personalityId!=='marksman'||Math.random()<.55))out.push('armor');
  if(level>=6&&(WEAPONS[weaponId]?.automatic||['assault','flanker','support'].includes(personalityId)))out.push('fastreload');
  return out.slice(0,2);
}
function applyBotLevelLoadout(bot,level,resetAmmo=true){
  level=Math.max(1,Math.min(50,Math.round(level||1)));
  const oldMax=bot.maxHp||100,oldHp=bot.hp||oldMax,ratio=oldMax>0?Math.max(0,Math.min(1,oldHp/oldMax)):1;
  bot.botLevel=level;
  bot.weaponId=pickBotWeapon(level,bot.botPersonality);
  bot.equipmentIds=chooseBotEquipment(level,bot.botPersonality,bot.weaponId);
  bot.accessoryId=chooseBotAccessory(level,bot.botPersonality);
  bot.accessoryCharges=(ACCESSORIES.find(a=>a.id===bot.accessoryId)?.maxCharges)||0;
  bot.toolId=chooseBotTool(level,bot.botPersonality);bot.toolReadyAt=0;
  const med=chooseBotMedical(level,bot.botPersonality);bot.medicalId=med.id;bot.medicalCharges=resetAmmo?med.maxCharges:Math.min(bot.medicalCharges||med.maxCharges,med.maxCharges);
  bot.maxHp=playerHasEquipment(bot,'armor')?125:100;
  bot.hp=bot.alive?Math.max(1,Math.round(bot.maxHp*ratio)):Math.min(bot.hp||0,bot.maxHp);
  const w=weaponFor(bot);bot.reserveMax=w.mag*4;
  if(resetAmmo){bot.ammo=w.mag;bot.reserveAmmo=bot.reserveMax;bot.reloadingUntil=0;bot.lastShotAt=0;bot.bloom=0;}
}
function syncBotLoadoutsToHumans(){
  const levels=humanLevelPool();
  for(const teamId of TEAM_IDS){
    const bots=botsForTeam(teamId).sort((a,b)=>Number(a.id)-Number(b.id));
    bots.forEach((bot,i)=>{
      const target=levels[i%levels.length];
      if(bot.botLevel!==target)applyBotLevelLoadout(bot,target,true);
    });
  }
}
function makeBot(teamId) {
  const personalityId = Object.keys(BOT_PERSONALITIES)[Math.floor(Math.random()*Object.keys(BOT_PERSONALITIES).length)];
  const spawn = teamSpawn(teamId);
  const nickname = nextBotName();
  nextBotSerial++;
  const now=Date.now();
  const bot={
    id:String(nextPlayerId++), ws:null, profileKey:null, nickname, isBot:true, botPersonality:personalityId,
    teamId:safeTeam(teamId), x:spawn.x, y:spawn.y, vx:0, vy:0, radius:24, hitRadius:27, angle:Math.random()*Math.PI*2,
    hp:100, maxHp:100, alive:true, downed:false, downedAt:0, downedMeta:null, giveUpAt:0, bleedoutAt:0,
    input:{ up:false, down:false, left:false, right:false, sprint:false },
    aiming:false, sprinting:false, stamina:100, maxStamina:100, staminaRegenAt:0,
    weaponId:'pistol', equipmentIds:[], accessoryId:'none', accessoryCharges:0, toolId:'none', toolReadyAt:0,
    medicalId:'bandage', medicalCharges:3, medicalUseUntil:0, healOverTimeUntil:0, nextHealOverTimeAt:0, staminaBuffUntil:0,
    vehicleId:null, vehicleSeat:null, dragTargetId:null, draggedById:null, lifeId:1, lastDamagedAt:0, transportCredits:new Set(),
    ammo:WEAPONS.pistol.mag, reserveAmmo:WEAPONS.pistol.mag*4, reserveMax:WEAPONS.pistol.mag*4, reloadingUntil:0, lastShotAt:0, bloom:0, respawnAt:0, blindedUntil:0,
    reviveTargetId:null,beingRevivedById:null, reviveStartedAt:0, reviveDuration:0,
    joinedAt:now, matchKills:0, matchAssists:0, matchDeaths:0, matchMoneyNet:0, damageContrib:new Map(), botLevel:1,
    godMode:false,isAdmin:false,squadId:null,warEntryLifeId:0,reviveSponsorIds:new Set(),transportSponsorIds:new Set(),pilotRole:false,pilotSlot:-1,
    medicalTargetId:null,beingHealedById:null,healLockUntil:0,
    brain:{
      nextThinkAt:now+Math.random()*300, targetId:null, targetSeenAt:0, targetAcquiredAt:0,
      aimAngle:Math.random()*Math.PI*2, strafeDir:Math.random()<.5?-1:1, strafeUntil:0,
      burstLeft:0, nextBurstAt:now+400, waypoint:null, flankSide:Math.random()<.5?-1:1,
      stuckAt:null,
      lastKnownX:null,lastKnownY:null,targetLostAt:0,searchUntil:0,
      hesitationUntil:now+300+Math.random()*900, fireDiscipline:.82+Math.random()*.34,
      objectiveAngle:Math.random()*Math.PI*2, objectiveRadiusScale:.85+Math.random()*.35,
      nextRoleShuffleAt:now+9000+Math.random()*11000, buddyId:null, botMoveX:0, botMoveY:0,
      independentRoll:Math.random(), separationBias:.75+Math.random()*.55,
      laneOffset:(Math.random()-.5)*3200,
      navWaypoint:null, navWaypointUntil:0, navObstacleKey:null, stuckCount:0,
      navPath:null, navPathIndex:0, navPathUntil:0, navPathDestX:null, navPathDestY:null, nextPathAt:0,
      lastX:spawn.x, lastY:spawn.y, nextStuckCheck:now+900+Math.random()*350,
      vehicleAffinity:Math.random(), passengerAffinity:Math.random(), vehicleWaitUntil:0, passengerWaitSince:0, vehicleReservedAt:0, wantedVehicleId:null,
      baseWaitAngle:Math.random()*Math.PI*2,baseWaitRadius:390+Math.random()*330,
      combatFocus:Math.random()<.38?'control':'war', warAngle:Math.random()*Math.PI*2, warRadiusScale:.18+Math.random()*.72
    }
  };
  const levels=humanLevelPool();applyBotLevelLoadout(bot,levels[(nextBotSerial-2)%levels.length],true);
  return bot;
}

initializeVehicles();

function humanPlayers(){return[...players.values()].filter(p=>!p.isBot);}
function refreshAdminHost(){
  if(adminHostId&&players.get(adminHostId)&&!players.get(adminHostId).isBot)return;
  for(const p of players.values())p.isAdmin=false;const next=humanPlayers().filter(p=>p.adminVerified).sort((a,b)=>a.joinedAt-b.joinedAt)[0]||null;adminHostId=next?.id||null;if(next){next.isAdmin=true;send(next.ws,'admin_granted',{});}
}
function findSafeVehicleSpawn(teamId,type,x,y,now=Date.now()){
  const cfg=VEHICLE_CONFIG[type]||VEHICLE_CONFIG.quad,probe={teamId,type,radius:cfg.radius};
  if(vehicleCanStandAt(probe,x,y,now))return{x,y};
  for(const r of [100,180,280,400,560])for(let i=0;i<12;i++){const a=i/12*Math.PI*2,cx=x+Math.cos(a)*r,cy=y+Math.sin(a)*r;if(vehicleCanStandAt(probe,cx,cy,now))return{x:cx,y:cy};}
  const b=TEAMS[teamId]?.spawn||TEAMS.alpha.spawn;return{x:b[0],y:b[1]};
}
function handleAdminAction(admin,msg,now){
  if(!admin||admin.id!==adminHostId||!admin.isAdmin)return;const target=players.get(String(msg.targetId||admin.id));
  if(msg.action==='spawn_vehicle'){const type=msg.vehicleType==='jeep'?'jeep':'quad',ref=target&&!target.isBot?target:admin;const a=ref.angle||0,desiredX=ref.x+Math.cos(a)*140,desiredY=ref.y+Math.sin(a)*140,pos=findSafeVehicleSpawn(ref.teamId,type,desiredX,desiredY,now);const v=makeVehicle(type,ref.teamId,pos.x,pos.y,`admin-${type}-${nextEventId++}`);vehicles.push(v);return;}
  if(!target||target.isBot)return;
  if(msg.action==='god'){target.godMode=msg.enabled==null?!target.godMode:!!msg.enabled;send(target.ws,'feed',{text:`Godmode ${target.godMode?'activé':'désactivé'}.`,kind:'join'});return;}
  if(msg.action==='level_delta'&&target.profileKey){const pr=profiles[target.profileKey];const cur=levelFromXp(pr.xp||0),next=Math.max(1,Math.min(50,cur+Math.max(-10,Math.min(10,Math.trunc(Number(msg.delta)||0)))));pr.xp=xpForLevel(next);scheduleSave();botBalanceDirty=true;send(target.ws,'profile',{profile:profileView(pr),xpReason:'ADMIN'});return;}
  if(msg.action==='money_delta'&&target.profileKey){const pr=profiles[target.profileKey];ensureProfileEconomy(pr);const delta=Math.max(-1000000,Math.min(1000000,Math.trunc(Number(msg.delta)||0)));pr.money=Math.max(0,(pr.money||0)+delta);target.matchMoneyNet=(target.matchMoneyNet||0)+delta;scheduleSave();send(target.ws,'profile',{profile:profileView(pr),gainedMoney:delta,xpReason:'ADMIN ARGENT'});return;}
  if(msg.action==='teleport_control'){
    if(target.vehicleId)leaveVehicle(target);const angle=Math.random()*Math.PI*2,r=Math.random()*Math.max(40,match.objective.radius*.38),pos=nearestSafeBotPoint(match.objective.x+Math.cos(angle)*r,match.objective.y+Math.sin(angle)*r,target.radius||24);target.x=pos.x;target.y=pos.y;target.vx=target.vy=0;target.alive=true;target.downed=false;target.hp=Math.max(1,target.hp||target.maxHp);send(target.ws,'feed',{text:'Téléporté dans le Point de contrôle.',kind:'objective'});return;
  }
}
function handleSquadAction(p,msg){
  if(!p||p.isBot)return false;const action=String(msg.action||'');
  if(action==='leave'){p.squadId=null;send(p.ws,'feed',{text:'Tu as quitté ton escouade.',kind:'join'});return true;}
  const id=String(msg.squadId||'');if(action!=='join'||!SQUAD_IDS.includes(id))return false;p.squadId=id;send(p.ws,'feed',{text:`Escouade ${SQUAD_IDS.indexOf(id)+1} rejointe.`,kind:'join'});return true;
}
wss.on('connection', ws => {
  let authenticated = false;
  const helloTimeout = setTimeout(() => { if (!authenticated) ws.close(4001, 'hello timeout'); }, 7000);

  // Une déconnexion réseau brutale (fermeture navigateur, Wi‑Fi coupé, tunnel interrompu)
  // peut produire ECONNRESET sur la socket. Comme SimpleWebSocket hérite d'EventEmitter,
  // l'absence de listener `error` ferait terminer tout le processus Node. Une perte de client
  // ne doit jamais pouvoir faire tomber le serveur entier.
  ws.on('error', () => {});

  ws.on('message', raw => {
    const rateNow=Date.now();
    if(!ws._rateWindowAt||rateNow-ws._rateWindowAt>=1000){ws._rateWindowAt=rateNow;ws._rateCount=0;}
    if(++ws._rateCount>120)return ws.close(4008,'message rate exceeded');
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (!authenticated) {
      if (msg.type !== 'hello' || !validToken(msg.token)) return ws.close(4002, 'invalid hello');
      authenticated = true; clearTimeout(helloTimeout);
      if (clients.size >= MAX_PLAYERS) return ws.close(4003, 'server full');
      const token = msg.token.toLowerCase();
      const profileKey = crypto.createHash('sha256').update(token).digest('hex');
      const nickname = safeNickname(msg.nickname);
      const existing = profiles[profileKey];
      const profile = existing || { nickname, xp:0, money:0, kills:0, assists:0, deaths:0, licenses:{weapon:['pistol'],equipment:[],medical:['bandage'],tool:['none'],accessory:['none']}, createdAt:new Date().toISOString(), lastSeenAt:new Date().toISOString() };
      ensureProfileEconomy(profile);profile.nickname = nickname || profile.nickname;
      profile.lastSeenAt = new Date().toISOString();
      profiles[profileKey] = profile; scheduleSave();

      const joinTeam=availableHumanTeam(msg.teamId);const player = makeHumanPlayer(ws, profileKey, profile, joinTeam);
      player.adminVerified=isValidAdminToken(msg.adminToken);
      clients.set(ws, player); players.set(player.id, player);if(!adminHostId&&player.adminVerified){adminHostId=player.id;player.isAdmin=true;}
      botBalanceDirty=true;
      send(ws, 'welcome', {
        selfId:player.id, map:{...MAP,bases:BASE_SPAWNS,baseRadius:BASE_RADIUS}, weapons:WEAPONS, equipment:EQUIPMENT, medicalItems:MEDICAL_ITEMS, accessories:ACCESSORIES, tools:TOOLS, teams:TEAMS,
        profile:profileView(profile), match:matchPublic(Date.now()), isAdmin:player.isAdmin
      });
      broadcast('feed', { text:`${player.nickname} rejoint ${TEAMS[player.teamId].name}.`, kind:'join' });
      return;
    }

    const p = clients.get(ws); if (!p) return;
    const now = Date.now(); p.lastInputAt = now;
    switch (msg.type) {
      case 'net_ping': {
        const nonce = Number(msg.nonce);
        if(Number.isSafeInteger(nonce)&&nonce>=0&&nonce<1000000000)send(ws,'net_pong',{nonce});
        break;
      }
      case 'input': {
        if (msg.keys && typeof msg.keys === 'object') {
          p.input.up=!!msg.keys.up; p.input.down=!!msg.keys.down; p.input.left=!!msg.keys.left; p.input.right=!!msg.keys.right; p.input.sprint=!!msg.keys.sprint;
        }
        p.aiming=p.vehicleId?false:!!msg.aiming;
        if (Number.isFinite(msg.angle)) p.angle=normalizeAngle(msg.angle);
        break;
      }
      case 'fire': if (Number.isFinite(msg.angle)) p.angle=normalizeAngle(msg.angle); tryFire(p, now); break;
      case 'reload': startReload(p, now); break;
      case 'medical': useMedical(p, now); break;
      case 'respawn': requestRespawn(p, now); break;
      case 'revive_start': startRevive(p, now); break;
      case 'revive_stop': cancelRevive(p); break;
      case 'interact': if(!toggleDrag(p,now))toggleVehicle(p); break;
      case 'kick_passengers': kickVehiclePassengers(p,now); break;
      case 'accessory': if (Number.isFinite(msg.angle)) p.angle=normalizeAngle(msg.angle); useAccessory(p, now); break;
      case 'tool': if (Number.isFinite(msg.angle)) p.angle=normalizeAngle(msg.angle); useTool(p, now); break;
      case 'weapon': /* legacy endpoint intentionally disabled: loadout purchases are authoritative */ break;
      case 'loadout': updateLoadout(p, msg, now); break;
      case 'buy_license': buyLicense(p,String(msg.kind||''),String(msg.id||'')); break;
      case 'admin': handleAdminAction(p,msg,now); break;
      case 'squad': handleSquadAction(p,msg); break;
      case 'team': switchTeam(p, safeTeam(msg.teamId), now); break;
      case 'rename': {
        const name=safeNickname(msg.nickname); p.nickname=name; profiles[p.profileKey].nickname=name; scheduleSave();
        send(ws,'profile',{profile:profileView(profiles[p.profileKey])}); break;
      }
    }
  });

  ws.on('close', () => {
    clearTimeout(helloTimeout);
    const p = clients.get(ws); if (!p) return;
    if(p.vehicleId)leaveVehicle(p);clients.delete(ws); players.delete(p.id);if(adminHostId===p.id)adminHostId=null;refreshAdminHost();botBalanceDirty=true;
    const pr=profiles[p.profileKey]; if (pr) { pr.lastSeenAt=new Date().toISOString(); scheduleSave(); }
    broadcast('feed',{text:`${p.nickname} quitte la zone.`,kind:'leave'});
  });
});

function normalizeAngle(a) {
  if (!Number.isFinite(a)) return 0;
  while (a > Math.PI) a -= Math.PI*2;
  while (a < -Math.PI) a += Math.PI*2;
  return a;
}
function angleDelta(a,b){ return normalizeAngle(a-b); }
function circleRectCollision(x,y,r,rect){
  const cx=Math.max(rect.x,Math.min(x,rect.x+rect.w));
  const cy=Math.max(rect.y,Math.min(y,rect.y+rect.h));
  const dx=x-cx,dy=y-cy; return dx*dx+dy*dy<r*r;
}
var OBSTACLE_INDEX;
function getObstacleIndex(){
  if(OBSTACLE_INDEX&&OBSTACLE_INDEX.count===MAP.obstacles.length)return OBSTACLE_INDEX;
  const cols=Math.ceil(MAP.width/900),rows=Math.ceil(MAP.height/900),buckets=new Map();
  for(const o of MAP.obstacles){
    const minX=Math.max(0,Math.floor(o.x/900)),maxX=Math.min(cols-1,Math.floor((o.x+o.w)/900));
    const minY=Math.max(0,Math.floor(o.y/900)),maxY=Math.min(rows-1,Math.floor((o.y+o.h)/900));
    for(let gy=minY;gy<=maxY;gy++)for(let gx=minX;gx<=maxX;gx++){
      const key=gy*cols+gx;let arr=buckets.get(key);if(!arr)buckets.set(key,arr=[]);arr.push(o);
    }
  }
  OBSTACLE_INDEX={count:MAP.obstacles.length,cols,rows,buckets};return OBSTACLE_INDEX;
}
function obstaclesInBounds(minX,minY,maxX,maxY){
  const idx=getObstacleIndex(),gx0=Math.max(0,Math.floor(minX/900)),gx1=Math.min(idx.cols-1,Math.floor(maxX/900));
  const gy0=Math.max(0,Math.floor(minY/900)),gy1=Math.min(idx.rows-1,Math.floor(maxY/900));
  const out=[],seen=new Set();
  for(let gy=gy0;gy<=gy1;gy++)for(let gx=gx0;gx<=gx1;gx++)for(const o of idx.buckets.get(gy*idx.cols+gx)||[]){if(!seen.has(o)){seen.add(o);out.push(o);}}
  return out;
}
function canStandAt(x,y,r){
  if(x<r||y<r||x>MAP.width-r||y>MAP.height-r)return false;
  return !obstaclesInBounds(x-r,y-r,x+r,y+r).some(o=>circleRectCollision(x,y,r,o));
}
function expandedObstacle(o,pad){return{x:o.x-pad,y:o.y-pad,w:o.w+pad*2,h:o.h+pad*2};}
function segmentBlockingObstacle(x1,y1,x2,y2,clearance=0){
  const dx=x2-x1,dy=y2-y1,len=Math.hypot(dx,dy);if(len<1)return null;const nx=dx/len,ny=dy/len;
  let best=null,bestDist=len+1;
  const candidates=obstaclesInBounds(Math.min(x1,x2)-clearance,Math.min(y1,y2)-clearance,Math.max(x1,x2)+clearance,Math.max(y1,y2)+clearance);
  for(const o of candidates){
    const r=clearance?expandedObstacle(o,clearance):o;
    const d=rayRectDistance(x1,y1,nx,ny,r);
    if(d>=0&&d<=len&&d<bestDist){bestDist=d;best=o;}
  }
  return best?{obstacle:best,distance:bestDist}:null;
}
function segmentClearForBot(x1,y1,x2,y2,r){return !segmentBlockingObstacle(x1,y1,x2,y2,r);}
function nearestSafeBotPoint(x,y,r){
  x=Math.max(r+2,Math.min(MAP.width-r-2,x));y=Math.max(r+2,Math.min(MAP.height-r-2,y));
  if(canStandAt(x,y,r))return{x,y};
  let best=null,bestScore=Infinity;
  for(const radius of [70,110,165,235,320,430]){
    const steps=radius<180?16:24;
    for(let i=0;i<steps;i++){
      const a=i/steps*Math.PI*2,cx=x+Math.cos(a)*radius,cy=y+Math.sin(a)*radius;
      if(!canStandAt(cx,cy,r))continue;
      const score=radius+Math.abs(Math.sin(a*3))*4;
      if(score<bestScore){bestScore=score;best={x:cx,y:cy};}
    }
    if(best)return best;
  }
  return{x,y};
}
function obstacleDetourWaypoint(bot,dest,blocking){
  const o=blocking.obstacle,pad=botNavRadius(bot)+34;
  const corners=[
    {x:o.x-pad,y:o.y-pad,side:-1},{x:o.x+o.w+pad,y:o.y-pad,side:1},
    {x:o.x+o.w+pad,y:o.y+o.h+pad,side:-1},{x:o.x-pad,y:o.y+o.h+pad,side:1}
  ];
  const directX=dest.x-bot.x,directY=dest.y-bot.y;
  let best=null,bestScore=Infinity;
  for(const c of corners){
    if(!canStandAt(c.x,c.y,botNavRadius(bot)))continue;
    if(!segmentClearForBot(bot.x,bot.y,c.x,c.y,botNavRadius(bot)))continue;
    const d1=Math.hypot(c.x-bot.x,c.y-bot.y),d2=Math.hypot(dest.x-c.x,dest.y-c.y);
    const cross=directX*(c.y-bot.y)-directY*(c.x-bot.x);
    const side=Math.sign(cross)||c.side;
    const sidePenalty=side===bot.brain.flankSide?0:90;
    const secondBlocked=segmentBlockingObstacle(c.x,c.y,dest.x,dest.y,botNavRadius(bot));
    const continuationPenalty=secondBlocked&&secondBlocked.obstacle===o?900:secondBlocked?120:0;
    const score=d1+d2+sidePenalty+continuationPenalty;
    if(score<bestScore){bestScore=score;best={x:c.x,y:c.y};}
  }
  return best;
}
function emergencyEscapeWaypoint(bot,dest){
  const b=bot.brain,base=Math.min(520,150+(b.stuckCount||0)*75),toDest=Math.atan2(dest.y-bot.y,dest.x-bot.x);
  let best=null,bestScore=Infinity;
  for(let ring=0;ring<3;ring++){
    const radius=base+ring*90;
    for(let i=0;i<20;i++){
      const a=toDest+(i/20*Math.PI*2)+(b.flankSide<0?-.18:.18),x=bot.x+Math.cos(a)*radius,y=bot.y+Math.sin(a)*radius;
      if(!canStandAt(x,y,botNavRadius(bot))||!segmentClearForBot(bot.x,bot.y,x,y,botNavRadius(bot)))continue;
      const score=Math.hypot(dest.x-x,dest.y-y)+(Math.abs(angleDelta(a,toDest))*70);
      if(score<bestScore){bestScore=score;best={x,y};}
    }
    if(best)break;
  }
  return best;
}
const NAV_CELL=140;
const NAV_CLEARANCE=56;
function botNavRadius(bot){return Math.max(NAV_CLEARANCE,(bot.radius||24)+24);}
let NAV_GRID=null;
function getNavGrid(){
  if(NAV_GRID)return NAV_GRID;
  const cols=Math.ceil(MAP.width/NAV_CELL),rows=Math.ceil(MAP.height/NAV_CELL),blocked=new Uint8Array(cols*rows);
  for(let gy=0;gy<rows;gy++)for(let gx=0;gx<cols;gx++){
    const x=Math.min(MAP.width-30,gx*NAV_CELL+NAV_CELL*.5),y=Math.min(MAP.height-30,gy*NAV_CELL+NAV_CELL*.5);
    if(!canStandAt(x,y,NAV_CLEARANCE))blocked[gy*cols+gx]=1;
  }
  NAV_GRID={cols,rows,blocked};return NAV_GRID;
}
function navIndex(gx,gy,grid){return gy*grid.cols+gx;}
function worldToNav(x,y,grid){return{gx:Math.max(0,Math.min(grid.cols-1,Math.floor(x/NAV_CELL))),gy:Math.max(0,Math.min(grid.rows-1,Math.floor(y/NAV_CELL)))};}
function navToWorld(gx,gy){return{x:Math.min(MAP.width-NAV_CLEARANCE-2,gx*NAV_CELL+NAV_CELL*.5),y:Math.min(MAP.height-NAV_CLEARANCE-2,gy*NAV_CELL+NAV_CELL*.5)};}
function nearestWalkableNavCell(gx,gy,grid){
  if(gx>=0&&gy>=0&&gx<grid.cols&&gy<grid.rows&&!grid.blocked[navIndex(gx,gy,grid)])return{gx,gy};
  for(let r=1;r<=6;r++)for(let oy=-r;oy<=r;oy++)for(let ox=-r;ox<=r;ox++){
    if(Math.max(Math.abs(ox),Math.abs(oy))!==r)continue;const x=gx+ox,y=gy+oy;
    if(x>=0&&y>=0&&x<grid.cols&&y<grid.rows&&!grid.blocked[navIndex(x,y,grid)])return{gx:x,gy:y};
  }
  return null;
}
function heapPush(heap,node){
  heap.push(node);let i=heap.length-1;
  while(i>0){const p=(i-1)>>1;if(heap[p].f<=node.f)break;heap[i]=heap[p];i=p;}heap[i]=node;
}
function heapPop(heap){
  if(!heap.length)return null;const root=heap[0],last=heap.pop();if(heap.length){let i=0;while(true){let l=i*2+1,r=l+1;if(l>=heap.length)break;let c=r<heap.length&&heap[r].f<heap[l].f?r:l;if(heap[c].f>=last.f)break;heap[i]=heap[c];i=c;}heap[i]=last;}return root;
}
function navScratch(total){
  if(!NAV_SCRATCH||NAV_SCRATCH.total!==total)NAV_SCRATCH={total,gScore:new Float64Array(total),parent:new Int32Array(total),closed:new Uint8Array(total)};
  NAV_SCRATCH.gScore.fill(Infinity);NAV_SCRATCH.parent.fill(-1);NAV_SCRATCH.closed.fill(0);return NAV_SCRATCH;
}
function vehicleScratch(key,total){
  let sc=VEHICLE_NAV_SCRATCH.get(key);if(!sc||sc.total!==total){sc={total,gScore:new Float64Array(total),parent:new Int32Array(total),closed:new Uint8Array(total)};VEHICLE_NAV_SCRATCH.set(key,sc);}
  sc.gScore.fill(Infinity);sc.parent.fill(-1);sc.closed.fill(0);return sc;
}
const VEHICLE_NAV_CELL=170;
const VEHICLE_NAV_GRIDS=new Map();
const VEHICLE_NAV_SCRATCH=new Map();
function vehicleNavClearance(v){return (v.radius||40)+42;}
function vehicleNavKey(v){return `${v.type}:${Math.round(vehicleNavClearance(v))}`;}
function getVehicleNavGrid(v){
  const key=vehicleNavKey(v);if(VEHICLE_NAV_GRIDS.has(key))return VEHICLE_NAV_GRIDS.get(key);
  const clearance=vehicleNavClearance(v),cols=Math.ceil(MAP.width/VEHICLE_NAV_CELL),rows=Math.ceil(MAP.height/VEHICLE_NAV_CELL),blocked=new Uint8Array(cols*rows),cellGuard=VEHICLE_NAV_CELL*.5;
  // Une cellule est fermée avant que le centre du véhicule n'arrive au contact d'un mur. La demi-cellule
  // supplémentaire empêche les trajectoires entre deux centres libres de couper un mur fin ou un interstice impossible.
  for(let gy=0;gy<rows;gy++)for(let gx=0;gx<cols;gx++){
    const x=Math.min(MAP.width-clearance-2,gx*VEHICLE_NAV_CELL+VEHICLE_NAV_CELL*.5),y=Math.min(MAP.height-clearance-2,gy*VEHICLE_NAV_CELL+VEHICLE_NAV_CELL*.5),r=clearance+cellGuard;
    if(x<clearance||y<clearance||x>MAP.width-clearance||y>MAP.height-clearance){blocked[gy*cols+gx]=1;continue;}
    // Utilise l'index spatial au lieu de tester ~1000 obstacles pour chacune des >100k cellules.
    // Le premier départ des véhicules ne doit plus geler la simulation plusieurs secondes.
    const nearby=obstaclesInBounds(x-r,y-r,x+r,y+r);
    if(nearby.some(o=>circleRectCollision(x,y,r,o)))blocked[gy*cols+gx]=1;
  }
  const grid={cols,rows,blocked,clearance};VEHICLE_NAV_GRIDS.set(key,grid);return grid;
}
function vehicleWorldToNav(x,y,grid){return{gx:Math.max(0,Math.min(grid.cols-1,Math.floor(x/VEHICLE_NAV_CELL))),gy:Math.max(0,Math.min(grid.rows-1,Math.floor(y/VEHICLE_NAV_CELL)))}};
function vehicleNavToWorld(gx,gy,grid){return{x:Math.min(MAP.width-grid.clearance-2,gx*VEHICLE_NAV_CELL+VEHICLE_NAV_CELL*.5),y:Math.min(MAP.height-grid.clearance-2,gy*VEHICLE_NAV_CELL+VEHICLE_NAV_CELL*.5)}};
function vehicleNavCellAllowed(v,gx,gy,grid){
  if(gx<0||gy<0||gx>=grid.cols||gy>=grid.rows||grid.blocked[gy*grid.cols+gx])return false;
  const p=vehicleNavToWorld(gx,gy,grid);return !inEnemyBase(v.teamId,p.x,p.y,BASE_RADIUS+55);
}
function nearestVehicleNavCell(v,gx,gy,grid){
  if(vehicleNavCellAllowed(v,gx,gy,grid))return{gx,gy};
  for(let r=1;r<=8;r++)for(let oy=-r;oy<=r;oy++)for(let ox=-r;ox<=r;ox++){
    if(Math.max(Math.abs(ox),Math.abs(oy))!==r)continue;const x=gx+ox,y=gy+oy;if(vehicleNavCellAllowed(v,x,y,grid))return{gx:x,gy:y};
  }
  return null;
}
function segmentClearForVehicle(v,x1,y1,x2,y2){
  const clearance=vehicleNavClearance(v);if(segmentBlockingObstacle(x1,y1,x2,y2,clearance))return false;
  const d=Math.hypot(x2-x1,y2-y1),steps=Math.max(2,Math.ceil(d/220));
  for(let i=1;i<=steps;i++){const t=i/steps,x=x1+(x2-x1)*t,y=y1+(y2-y1)*t;if(inEnemyBase(v.teamId,x,y,BASE_RADIUS+55))return false;}
  return true;
}
function findVehicleNavPath(v,dest){
  const grid=getVehicleNavGrid(v),s0=vehicleWorldToNav(v.x,v.y,grid),e0=vehicleWorldToNav(dest.x,dest.y,grid);
  const start=nearestVehicleNavCell(v,s0.gx,s0.gy,grid),end=nearestVehicleNavCell(v,e0.gx,e0.gy,grid);if(!start||!end)return null;
  const total=grid.cols*grid.rows,startI=start.gy*grid.cols+start.gx,endI=end.gy*grid.cols+end.gx;
  const scratch=vehicleScratch(vehicleNavKey(v),total),gScore=scratch.gScore,parent=scratch.parent,closed=scratch.closed,heap=[];gScore[startI]=0;
  const heuristic=(x,y)=>{const dx=Math.abs(end.gx-x),dy=Math.abs(end.gy-y);return Math.max(dx,dy)+(Math.SQRT2-1)*Math.min(dx,dy);};
  heapPush(heap,{i:startI,gx:start.gx,gy:start.gy,f:heuristic(start.gx,start.gy)});
  const dirs=[[1,0,1],[-1,0,1],[0,1,1],[0,-1,1],[1,1,Math.SQRT2],[1,-1,Math.SQRT2],[-1,1,Math.SQRT2],[-1,-1,Math.SQRT2]];
  let expanded=0,found=false;
  while(heap.length&&expanded<18000){
    const cur=heapPop(heap);if(closed[cur.i])continue;closed[cur.i]=1;expanded++;if(cur.i===endI){found=true;break;}
    for(const[dx,dy,cost]of dirs){
      const nx=cur.gx+dx,ny=cur.gy+dy;if(!vehicleNavCellAllowed(v,nx,ny,grid))continue;const ni=ny*grid.cols+nx;if(closed[ni])continue;
      if(dx&&dy&&(!vehicleNavCellAllowed(v,cur.gx+dx,cur.gy,grid)||!vehicleNavCellAllowed(v,cur.gx,cur.gy+dy,grid)))continue;
      const ng=gScore[cur.i]+cost;if(ng>=gScore[ni])continue;gScore[ni]=ng;parent[ni]=cur.i;heapPush(heap,{i:ni,gx:nx,gy:ny,f:ng+heuristic(nx,ny)});
    }
  }
  if(!found)return null;
  const raw=[];let at=endI,guard=0;while(at!==startI&&at>=0&&guard++<900){const gx=at%grid.cols,gy=Math.floor(at/grid.cols);raw.push(vehicleNavToWorld(gx,gy,grid));at=parent[at];}raw.reverse();
  if(!raw.length)return[dest];
  const smooth=[];let anchor={x:v.x,y:v.y},i=0;
  while(i<raw.length){let chosen=-1;for(let j=Math.min(raw.length-1,i+9);j>=i;j--){if(segmentClearForVehicle(v,anchor.x,anchor.y,raw[j].x,raw[j].y)){chosen=j;break;}}if(chosen<0)return null;smooth.push(raw[chosen]);anchor=raw[chosen];i=chosen+1;}
  if(segmentClearForVehicle(v,anchor.x,anchor.y,dest.x,dest.y))smooth.push(dest);return smooth;
}
function clearVehicleNav(v){v.aiWaypoint=null;v.aiPath=null;v.aiPathIndex=0;v.aiPathUntil=0;v.aiNextPathAt=0;}
function resolveVehicleNavigationTarget(v,dest,now){
  const safe=nearestSafeBotPoint(dest.x,dest.y,vehicleNavClearance(v));dest={x:safe.x,y:safe.y};
  if(v.aiEscapeUntil>now)return{x:v.x+v.aiEscapeX*360,y:v.y+v.aiEscapeY*360};
  if(segmentClearForVehicle(v,v.x,v.y,dest.x,dest.y)){clearVehicleNav(v);return dest;}
  if(v.aiPath?.length&&now<v.aiPathUntil&&v.aiPathDestX!=null&&Math.hypot(dest.x-v.aiPathDestX,dest.y-v.aiPathDestY)<900){
    while(v.aiPathIndex<v.aiPath.length-1&&Math.hypot(v.aiPath[v.aiPathIndex].x-v.x,v.aiPath[v.aiPathIndex].y-v.y)<125)v.aiPathIndex++;
    for(let i=Math.min(v.aiPath.length-1,v.aiPathIndex+3);i>v.aiPathIndex;i--){const wp=v.aiPath[i];if(segmentClearForVehicle(v,v.x,v.y,wp.x,wp.y)){v.aiPathIndex=i;break;}}
    const wp=v.aiPath[v.aiPathIndex];if(wp&&canStandAt(wp.x,wp.y,vehicleNavClearance(v)))return wp;clearVehicleNav(v);
  }
  if(now>=(v.aiNextPathAt||0)){
    v.aiNextPathAt=now+900+Math.random()*450;const path=findVehicleNavPath(v,dest);
    if(path?.length){v.aiPath=path;v.aiPathIndex=0;v.aiPathUntil=now+18000;v.aiPathDestX=dest.x;v.aiPathDestY=dest.y;return path[0];}
  }
  // fallback conservateur : recule latéralement plutôt que forcer un interstice trop étroit.
  const targetA=Math.atan2(dest.y-v.y,dest.x-v.x),side=(v.aiStuckCount||0)%2?1:-1;
  return{x:v.x+Math.cos(targetA+side*Math.PI*.55)*420,y:v.y+Math.sin(targetA+side*Math.PI*.55)*420};
}
function updateVehicleStuckRecovery(v,driver,now,wantsMove){
  if(!driver?.isBot)return;
  if(!v.aiNextStuckCheck){v.aiLastX=v.x;v.aiLastY=v.y;v.aiNextStuckCheck=now+850;return;}
  if(now<v.aiNextStuckCheck)return;const moved=Math.hypot(v.x-(v.aiLastX??v.x),v.y-(v.aiLastY??v.y));
  if(wantsMove&&moved<38){
    v.aiStuckCount=(v.aiStuckCount||0)+1;clearVehicleNav(v);
    const a=v.angle+((v.aiStuckCount%2)?Math.PI*.62:-Math.PI*.62);v.aiEscapeX=Math.cos(a);v.aiEscapeY=Math.sin(a);v.aiEscapeUntil=now+650+Math.min(650,v.aiStuckCount*100);
  }else if(moved>80){v.aiStuckCount=Math.max(0,(v.aiStuckCount||0)-1);v.aiEscapeUntil=0;}
  // Si un état rare place le centre trop près d'un décor, replace le véhicule à un point réellement compatible avec son gabarit bots.
  if(!canStandAt(v.x,v.y,vehicleNavClearance(v))){const safe=nearestSafeBotPoint(v.x,v.y,vehicleNavClearance(v));v.x=safe.x;v.y=safe.y;clearVehicleNav(v);v.aiEscapeUntil=0;}
  v.aiLastX=v.x;v.aiLastY=v.y;v.aiNextStuckCheck=now+800+Math.random()*250;
}

function findBotNavPath(bot,dest){
  const grid=getNavGrid(),s0=worldToNav(bot.x,bot.y,grid),e0=worldToNav(dest.x,dest.y,grid);
  const start=nearestWalkableNavCell(s0.gx,s0.gy,grid),end=nearestWalkableNavCell(e0.gx,e0.gy,grid);if(!start||!end)return null;
  const total=grid.cols*grid.rows,startI=navIndex(start.gx,start.gy,grid),endI=navIndex(end.gx,end.gy,grid);
  const scratch=navScratch(total),gScore=scratch.gScore,parent=scratch.parent,closed=scratch.closed,heap=[];gScore[startI]=0;
  const heuristic=(x,y)=>{const dx=Math.abs(end.gx-x),dy=Math.abs(end.gy-y);return Math.max(dx,dy)+(Math.SQRT2-1)*Math.min(dx,dy);};
  heapPush(heap,{i:startI,gx:start.gx,gy:start.gy,f:heuristic(start.gx,start.gy)});
  const dirs=[[1,0,1],[-1,0,1],[0,1,1],[0,-1,1],[1,1,Math.SQRT2],[1,-1,Math.SQRT2],[-1,1,Math.SQRT2],[-1,-1,Math.SQRT2]];
  let expanded=0,found=false;
  while(heap.length&&expanded<12000){
    const cur=heapPop(heap);if(closed[cur.i])continue;closed[cur.i]=1;expanded++;if(cur.i===endI){found=true;break;}
    for(const[dx,dy,cost]of dirs){
      const nx=cur.gx+dx,ny=cur.gy+dy;if(nx<0||ny<0||nx>=grid.cols||ny>=grid.rows)continue;const ni=navIndex(nx,ny,grid);if(grid.blocked[ni]||closed[ni])continue;
      if(dx&&dy){if(grid.blocked[navIndex(cur.gx+dx,cur.gy,grid)]||grid.blocked[navIndex(cur.gx,cur.gy+dy,grid)])continue;}
      const ng=gScore[cur.i]+cost;if(ng>=gScore[ni])continue;gScore[ni]=ng;parent[ni]=cur.i;heapPush(heap,{i:ni,gx:nx,gy:ny,f:ng+heuristic(nx,ny)});
    }
  }
  if(!found)return null;
  const raw=[];let at=endI,guard=0;while(at!==startI&&at>=0&&guard++<600){const gx=at%grid.cols,gy=Math.floor(at/grid.cols);raw.push(navToWorld(gx,gy));at=parent[at];}raw.reverse();
  if(!raw.length)return[dest];
  // Lissage : saute les cellules intermédiaires quand le segment réel est libre pour le rayon du bot.
  const smooth=[];let anchor={x:bot.x,y:bot.y},i=0;
  while(i<raw.length){let chosen=i;for(let j=Math.min(raw.length-1,i+12);j>i;j--){if(segmentClearForBot(anchor.x,anchor.y,raw[j].x,raw[j].y,botNavRadius(bot))){chosen=j;break;}}smooth.push(raw[chosen]);anchor=raw[chosen];i=chosen+1;}
  if(segmentClearForBot(anchor.x,anchor.y,dest.x,dest.y,botNavRadius(bot)))smooth.push(dest);
  return smooth;
}
function resolveBotNavigationTarget(bot,dest,now){
  const b=bot.brain;
  dest=nearestSafeBotPoint(dest.x,dest.y,botNavRadius(bot));

  // Trajet direct redevenu libre : inutile de conserver un détour ancien.
  if(segmentClearForBot(bot.x,bot.y,dest.x,dest.y,botNavRadius(bot))){
    b.navWaypoint=null;b.navObstacleKey=null;b.navPath=null;b.navPathIndex=0;return dest;
  }

  // Un chemin A* déjà calculé traverse les complexes de bâtiments sans oscillation autour d'un même mur.
  if(b.navPath?.length&&now<b.navPathUntil&&b.navPathDestX!=null&&Math.hypot(dest.x-b.navPathDestX,dest.y-b.navPathDestY)<700){
    while(b.navPathIndex<b.navPath.length-1&&Math.hypot(b.navPath[b.navPathIndex].x-bot.x,b.navPath[b.navPathIndex].y-bot.y)<95)b.navPathIndex++;
    // Autorise quelques raccourcis si un angle s'est dégagé.
    for(let i=Math.min(b.navPath.length-1,b.navPathIndex+4);i>b.navPathIndex;i--){const p=b.navPath[i];if(segmentClearForBot(bot.x,bot.y,p.x,p.y,botNavRadius(bot))){b.navPathIndex=i;break;}}
    const wp=b.navPath[b.navPathIndex];if(wp&&canStandAt(wp.x,wp.y,botNavRadius(bot)))return wp;
    b.navPath=null;b.navPathIndex=0;
  }

  if(now>=b.nextPathAt){
    b.nextPathAt=now+1400+Math.random()*650;
    const path=findBotNavPath(bot,dest);
    if(path?.length){b.navPath=path;b.navPathIndex=0;b.navPathUntil=now+12000;b.navPathDestX=dest.x;b.navPathDestY=dest.y;return path[0];}
  }

  // Fallback immédiat entre deux calculs A* : contourne le premier rectangle bloquant.
  if(b.navWaypoint){
    const reached=Math.hypot(b.navWaypoint.x-bot.x,b.navWaypoint.y-bot.y)<72;
    if(reached||now>b.navWaypointUntil||!canStandAt(b.navWaypoint.x,b.navWaypoint.y,botNavRadius(bot))){b.navWaypoint=null;b.navObstacleKey=null;}
    else return b.navWaypoint;
  }
  const blocking=segmentBlockingObstacle(bot.x,bot.y,dest.x,dest.y,botNavRadius(bot));
  const wp=blocking&&(obstacleDetourWaypoint(bot,dest,blocking)||emergencyEscapeWaypoint(bot,dest));
  if(wp){b.navWaypoint=wp;b.navWaypointUntil=now+5000;b.navObstacleKey='detour';return wp;}
  return dest;
}
function updateBotStuckRecovery(bot,dest,now){
  const b=bot.brain;if(now<b.nextStuckCheck)return;
  const moved=Math.hypot(bot.x-b.lastX,bot.y-b.lastY),remaining=Math.hypot(dest.x-bot.x,dest.y-bot.y);
  if(remaining>110&&moved<30){
    b.stuckCount=(b.stuckCount||0)+1;b.flankSide*=-1;b.navPath=null;b.navPathIndex=0;b.nextPathAt=0;
    const escape=emergencyEscapeWaypoint(bot,dest);
    if(escape){b.navWaypoint=escape;b.navWaypointUntil=now+3200;b.navObstacleKey='escape';}
  }else if(moved>55)b.stuckCount=Math.max(0,(b.stuckCount||0)-1);
  // Dernier filet de sécurité : si un déplacement/objectif a coincé le bot au contact d'un décor,
  // on le replace au point libre le plus proche au lieu de le laisser bloqué indéfiniment.
  if(!canStandAt(bot.x,bot.y,botNavRadius(bot))){
    const safe=nearestSafeBotPoint(bot.x,bot.y,botNavRadius(bot));bot.x=safe.x;bot.y=safe.y;b.navWaypoint=null;b.navPath=null;b.navPathIndex=0;b.stuckCount=0;
  }
  b.lastX=bot.x;b.lastY=bot.y;b.nextStuckCheck=now+850+Math.random()*350;
}
function integratePlayer(p,dt,now){
  if(!p.alive){p.sprinting=false;p.actualSpeed=0;return;}
  if(p.vehicleId){p.sprinting=false;p.aiming=false;p.actualSpeed=0;return;}
  let dx=0,dy=0;
  if(p.isBot){
    dx=p.brain?.botMoveX||0;dy=p.brain?.botMoveY||0;
  }else{
    // Contrôles écran : Z/W = haut, S = bas, Q/A = gauche, D = droite malgré la projection isométrique.
    const sx=(p.input.right?1:0)-(p.input.left?1:0),sy=(p.input.down?1:0)-(p.input.up?1:0);
    dx=sx+sy;dy=-sx+sy;
  }
  const healLocked=(p.healLockUntil||0)>now&&!!p.beingHealedById;if(healLocked){dx=0;dy=0;p.sprinting=false;}
  const moving=!!(dx||dy); if(moving){const len=Math.hypot(dx,dy);dx/=len;dy/=len;if(p.reviveTargetId)cancelRevive(p);}
  const canSprint=moving&&p.input.sprint&&!p.aiming&&!p.dragTargetId&&!p.medicalUseUntil&&!healLocked&&p.stamina>0.5;
  p.sprinting=canSprint;
  if((p.staminaBuffUntil||0)>now){p.stamina=p.maxStamina;}
  else if(p.sprinting){p.stamina=Math.max(0,p.stamina-25*dt);p.staminaRegenAt=now+700;if(p.stamina<=0.5)p.sprinting=false;}
  else if(now>=p.staminaRegenAt)p.stamina=Math.min(p.maxStamina,p.stamina+18*dt);
  const baseSpeed=p.sprinting?410:255;let speed=p.dragTargetId?baseSpeed*.68:baseSpeed;if(p.medicalUseUntil>now)speed*=.62;if(healLocked)speed=0; p.vx=dx*speed;p.vy=dy*speed;
  const oldX=p.x,oldY=p.y,nx=p.x+p.vx*dt,ny=p.y+p.vy*dt;
  if(playerCanStandAt(p,nx,p.y,now))p.x=nx;
  if(playerCanStandAt(p,p.x,ny,now))p.y=ny;
  p.actualSpeed=dt>0?Math.hypot(p.x-oldX,p.y-oldY)/dt:0;updateDraggedBody(p);
  const w=weaponFor(p);p.bloom=Math.max(0,p.bloom-w.bloomRecovery*dt);
}
function weaponFor(p){return WEAPONS[p.weaponId]||WEAPONS.pistol;}
function playerLevel(p){return p.isBot?p.botLevel:levelFromXp(profiles[p.profileKey]?.xp||0);}
function startReload(p,now){
  if(!p.alive||p.vehicleId)return false;const w=weaponFor(p);
  if(p.ammo>=w.mag||p.reloadingUntil>now||(p.reserveAmmo||0)<=0)return false;
  const quick=playerHasEquipment(p,'fastreload');
  p.reloadingUntil=now+2000*(quick?.8:1);p.bloom=0;cancelMedicalUse(p);
  effects.push({id:String(nextEventId++),type:'mag',shooterId:p.id,x:p.x,y:p.y,angle:p.angle,weaponId:w.id,at:now});return true;
}
function finishReloadIfNeeded(p,now){
  if(!p.reloadingUntil||now<p.reloadingUntil)return;
  p.reloadingUntil=0;const w=weaponFor(p),need=Math.max(0,w.mag-p.ammo),take=Math.min(need,Math.max(0,p.reserveAmmo||0));
  p.ammo+=take;p.reserveAmmo=Math.max(0,(p.reserveAmmo||0)-take);
}
function setWeapon(p,id){
  if(!p?.isBot)return false;
  const w=WEAPONS[id];if(!w||w.level>playerLevel(p)||p.weaponId===id)return false;
  p.weaponId=id;p.ammo=w.mag;p.reserveMax=w.mag*4;p.reserveAmmo=p.reserveMax;p.reloadingUntil=0;p.lastShotAt=0;p.bloom=0;return true;
}
function medicalFor(p){return MEDICAL_ITEMS.find(m=>m.id===p.medicalId)||MEDICAL_ITEMS[0];}
function cancelMedicalUse(p){
  if(!p)return;const targetId=p.medicalTargetId;const target=targetId?players.get(targetId):null;
  if(target&&target.id!==p.id&&target.beingHealedById===p.id){target.beingHealedById=null;target.healLockUntil=0;}
  p.medicalUseUntil=0;p.medicalTargetId=null;
}
function nearestInjuredFriendlyForMedical(p,maxDistance=86){
  let best=null,bd=maxDistance;for(const t of nearbyActors(p.x,p.y,maxDistance)){
    if(!t.alive||t.downed||t.id===p.id||t.teamId!==p.teamId||t.hp>=t.maxHp)continue;
    const d=Math.hypot(t.x-p.x,t.y-p.y);if(d<bd&&hasLineOfSight(p,t)){best=t;bd=d;}
  }return best;
}
function useMedical(p,now){
  const item=medicalFor(p);if(!p.alive||p.sprinting||(p.medicalCharges||0)<=0||p.medicalUseUntil>now||p.vehicleId)return false;
  let target=p;if(!p.isBot){const ally=nearestInjuredFriendlyForMedical(p,86);if(ally)target=ally;}
  if(target.hp>=target.maxHp)return false;
  if(target!==p&&target.beingHealedById&&target.beingHealedById!==p.id)return false;
  p.medicalTargetId=target.id;p.medicalUseUntil=now+item.useTime;p.aiming=false;p.reloadingUntil=0;
  if(target!==p){target.beingHealedById=p.id;target.healLockUntil=p.medicalUseUntil;target.vx=target.vy=0;target.sprinting=false;}
  effects.push({id:String(nextEventId++),type:'medical_start',shooterId:p.id,targetId:target.id,x:target.x,y:target.y,medicalId:item.id,at:now});
  return true;
}
function finishMedicalUseIfNeeded(p,now){
  if(!p.medicalUseUntil||now<p.medicalUseUntil)return;
  const targetId=p.medicalTargetId||p.id,target=players.get(targetId)||p,item=medicalFor(p);const wasAlly=target.id!==p.id;
  p.medicalUseUntil=0;p.medicalTargetId=null;if(wasAlly&&target.beingHealedById===p.id){target.beingHealedById=null;target.healLockUntil=0;}
  if(!p.alive||!target.alive||target.teamId!==p.teamId||target.hp>=target.maxHp||(p.medicalCharges||0)<=0)return;
  if(wasAlly&&(Math.hypot(target.x-p.x,target.y-p.y)>96||!hasLineOfSight(p,target)))return;
  p.medicalCharges--;const before=target.hp;target.hp=Math.min(target.maxHp,target.hp+item.heal);const healed=Math.max(0,target.hp-before);
  effects.push({id:String(nextEventId++),type:'medical',shooterId:p.id,targetId:target.id,x:target.x,y:target.y,medicalId:item.id,at:now});
  if(wasAlly&&healed>0&&!p.isBot)awardXp(p,25,'SOINS ALLIÉ');
}
function playerHasEquipment(p,id){return Array.isArray(p.equipmentIds)&&p.equipmentIds.includes(id);}
function accessoryFor(p){return ACCESSORIES.find(a=>a.id===p.accessoryId)||ACCESSORIES[0];}
function toolFor(p){return TOOLS.find(a=>a.id===p.toolId)||TOOLS[0];}
function dropDragged(p){
  if(!p?.dragTargetId)return false;const t=players.get(p.dragTargetId);if(t&&t.draggedById===p.id)t.draggedById=null;p.dragTargetId=null;return true;
}
function toggleDrag(p,now=Date.now()){
  if(!p?.alive||p.vehicleId)return false;if(p.dragTargetId)return dropDragged(p);
  let best=null,bd=76;for(const t of nearbyActors(p.x,p.y,76)){if(!t.downed||t.teamId!==p.teamId||t.id===p.id||t.draggedById)continue;const d=Math.hypot(t.x-p.x,t.y-p.y);if(d<bd){best=t;bd=d;}}
  if(!best)return false;p.dragTargetId=best.id;best.draggedById=p.id;cancelRevive(p);return true;
}
function updateDraggedBody(p){
  if(!p?.dragTargetId)return;const t=players.get(p.dragTargetId);if(!t?.downed||t.draggedById!==p.id){dropDragged(p);return;}
  const back=p.angle+Math.PI,tx=p.x+Math.cos(back)*52,ty=p.y+Math.sin(back)*52;
  if(canStandAt(tx,ty,t.radius||24)){t.x=tx;t.y=ty;}t.vx=p.vx;t.vy=p.vy;t.actualSpeed=p.actualSpeed||0;
}
function nearestDownedFriendly(p,maxDistance=78){
  let best=null,bd=maxDistance;
  for(const t of nearbyActors(p.x,p.y,maxDistance)){
    if(!t.downed||t.teamId!==p.teamId||t.id===p.id)continue;
    const d=Math.hypot(t.x-p.x,t.y-p.y);if(d<bd&&hasLineOfSight(p,t)){best=t;bd=d;}
  }
  return best;
}
function reviveStateFor(target,now){
  const reviverId=target?.beingRevivedById;if(!reviverId)return null;
  const p=players.get(reviverId);
  if(!p||p.reviveTargetId!==target.id||!p.reviveDuration){target.beingRevivedById=null;return null;}
  return {by:p.id,progress:Math.max(0,Math.min(1,(now-p.reviveStartedAt)/p.reviveDuration)),fast:p.reviveDuration<=2000};
}
function cancelRevive(p){
  const targetId=p?.reviveTargetId;
  if(targetId){const target=players.get(targetId);if(target?.beingRevivedById===p.id)target.beingRevivedById=null;}
  if(p){p.reviveTargetId=null;p.reviveStartedAt=0;p.reviveDuration=0;}
}
function startRevive(p,now){
  if(!p.alive||p.sprinting||p.vehicleId)return false;if(p.dragTargetId)dropDragged(p);
  const target=nearestDownedFriendly(p,82);if(!target)return false;
  if(target.beingRevivedById&&target.beingRevivedById!==p.id){const current=players.get(target.beingRevivedById);if(current?.alive&&current.reviveTargetId===target.id)return false;target.beingRevivedById=null;}
  const tool=toolFor(p),fast=tool.id==='defib'&&(p.toolReadyAt||0)<=now;
  target.beingRevivedById=p.id;p.reviveTargetId=target.id;p.reviveStartedAt=now;p.reviveDuration=fast?1900:6500;p.aiming=false;cancelMedicalUse(p);
  return true;
}
function completeRevive(reviver,target,now,fast=false){
  target.beingRevivedById=null;
  if(target.draggedById){const d=players.get(target.draggedById);if(d)dropDragged(d);target.draggedById=null;}
  target.alive=true;target.downed=false;target.downedAt=0;target.downedMeta=null;target.giveUpAt=0;target.bleedoutAt=0;target.respawnAt=0;target.hp=Math.max(35,Math.round(target.maxHp*.42));
  target.stamina=Math.min(target.maxStamina,50);target.sprinting=false;target.aiming=false;target.blindedUntil=0;target.damageContrib=new Map();
  target.input={up:false,down:false,left:false,right:false,sprint:false};
  if(fast)reviver.toolReadyAt=now+(toolFor(reviver).cooldown||10000);
  effects.push({id:String(nextEventId++),type:'revive',shooterId:reviver.id,targetId:target.id,x:target.x,y:target.y,fast,at:now});
  if(!(target.reviveSponsorIds instanceof Set))target.reviveSponsorIds=new Set();target.reviveSponsorIds.add(reviver.id);
  if(!reviver.isBot)awardXp(reviver,75,'RÉANIMATION');
  cancelRevive(reviver);
}
function finishReviveIfNeeded(p,now){
  if(!p.reviveTargetId)return;
  const t=players.get(p.reviveTargetId);
  if(!p.alive||!t?.downed||t.teamId!==p.teamId||Math.hypot(t.x-p.x,t.y-p.y)>86||!hasLineOfSight(p,t)){cancelRevive(p);return;}
  if(Math.hypot(p.vx||0,p.vy||0)>18||p.sprinting){cancelRevive(p);return;}
  if(now-p.reviveStartedAt<p.reviveDuration)return;
  const fast=toolFor(p).id==='defib'&&(p.toolReadyAt||0)<=now&&p.reviveDuration<=2000;
  completeRevive(p,t,now,fast);
}
function requestRespawn(p,now){
  if(!p.downed||now<(p.respawnAt||0))return;
  if(reviveStateFor(p,now))return; // impossible d'abandonner pendant qu'un allié est réellement en train de réanimer
  finalizeDeath(p,now,'respawn');respawn(p,now);
}
function resetAccessoryCharges(p){
  const a=accessoryFor(p);p.accessoryCharges=Math.max(0,a.maxCharges||0);
}
function useTool(p,now){
  if(!p.alive||p.sprinting||p.vehicleId)return false;
  const t=toolFor(p);if(!t||t.id==='none'||now<(p.toolReadyAt||0))return false;
  cancelMedicalUse(p);
  if(t.id==='defib')return startRevive(p,now);
  if(t.id==='healstim'){
    p.healOverTimeUntil=now+(t.duration||15000);p.nextHealOverTimeAt=now+750;p.toolReadyAt=now+(t.cooldown||20000);
    effects.push({id:String(nextEventId++),type:'stim',stimType:'heal',shooterId:p.id,x:p.x,y:p.y,at:now});return true;
  }
  if(t.id==='stamstim'){
    p.staminaBuffUntil=now+(t.duration||15000);p.stamina=p.maxStamina;p.toolReadyAt=now+(t.cooldown||22000);
    effects.push({id:String(nextEventId++),type:'stim',stimType:'stamina',shooterId:p.id,x:p.x,y:p.y,at:now});return true;
  }
  if(t.id==='ammocrate'||t.id==='medcrate'){
    const px=p.x+Math.cos(p.angle)*45,py=p.y+Math.sin(p.angle)*45;
    const x=canStandAt(px,py,16)?px:p.x,y=canStandAt(px,py,16)?py:p.y;
    supplyCrates.push({id:String(nextEventId++),type:t.id==='ammocrate'?'ammo':'medical',ownerId:p.id,teamId:p.teamId,x,y,radius:t.radius||145,createdAt:now,expiresAt:now+(t.lifetime||45000),lastServe:new Map(),accessoryServed:new Set(),nextHeal:new Map()});
    p.toolReadyAt=now+(t.cooldown||24000);
    effects.push({id:String(nextEventId++),type:'crate_place',shooterId:p.id,x,y,crateType:t.id,at:now});
    return true;
  }
  return false;
}
function useAccessory(p,now){
  if(!p.alive||p.sprinting||p.vehicleId)return false;
  const a=accessoryFor(p);if(!a||a.id==='none'||(p.accessoryCharges||0)<=0)return false;
  cancelMedicalUse(p);cancelRevive(p);p.accessoryCharges--;
  if(a.id==='rocket'){
    rockets.push({id:String(nextEventId++),ownerId:p.id,teamId:p.teamId,accessoryId:a.id,x:p.x+Math.cos(p.angle)*35,y:p.y+Math.sin(p.angle)*35,z:28,angle:p.angle,speed:a.speed||720,range:a.range||1500,traveled:0,radius:8,createdAt:now});
    effects.push({id:String(nextEventId++),type:'rocket_launch',shooterId:p.id,x:p.x,y:p.y,angle:p.angle,at:now});return true;
  }
  if(a.id==='proximity'){
    const px=p.x+Math.cos(p.angle)*34,py=p.y+Math.sin(p.angle)*34;
    const x=canStandAt(px,py,10)?px:p.x,y=canStandAt(px,py,10)?py:p.y;
    mines.push({id:String(nextEventId++),ownerId:p.id,teamId:p.teamId,accessoryId:a.id,x,y,placedAt:now,armedAt:now+1200,expiresAt:now+(a.lifetime||120000),radius:a.radius||235,triggerRadius:a.triggerRadius||92});
    effects.push({id:String(nextEventId++),type:'mine_place',shooterId:p.id,x,y,at:now});return true;
  }
  const speed=a.id==='flash'?350:330;
  grenades.push({
    id:String(nextEventId++),ownerId:p.id,teamId:p.teamId,accessoryId:a.id,x:p.x+Math.cos(p.angle)*28,y:p.y+Math.sin(p.angle)*28,z:34,
    vx:Math.cos(p.angle)*speed,vy:Math.sin(p.angle)*speed,vz:175,radius:7,createdAt:now,fuseAt:now+a.fuse,bounces:0
  });
  return true;
}
function grenadeLineClear(g,target){
  const dx=target.x-g.x,dy=target.y-g.y,d=Math.hypot(dx,dy);if(d<1)return true;
  return firstObstacleDistance(g.x,g.y,dx/d,dy/d,d)>=d-Math.max(6,target.radius*.5);
}
function applyExplosionDamage(owner,x,y,radius,now,maxDamage=150){
  if(!owner)return;
  const source={x,y};
  for(const target of players.values()){
    if(!target.alive)continue;const d=Math.hypot(target.x-x,target.y-y);
    if(d>radius||!grenadeLineClear(source,target))continue;
    const t=Math.max(0,1-d/radius);applyDamage(owner,target,Math.max(12,Math.round(maxDamage*Math.pow(t,1.16))),now);
  }
  for(const v of vehicles){
    if(!v.alive)continue;const d=Math.hypot(v.x-x,v.y-y);if(d>radius+v.radius)continue;
    const t=Math.max(0,1-d/(radius+v.radius));applyVehicleDamage(owner,v,Math.max(18,Math.round(maxDamage*1.15*Math.pow(t,1.08))),now);
  }
}
function explodeGrenade(g,now){
  const acc=ACCESSORIES.find(a=>a.id===g.accessoryId)||ACCESSORIES[0];
  const owner=players.get(g.ownerId);
  effects.push({id:String(nextEventId++),type:'explosion',shooterId:g.ownerId,x:g.x,y:g.y,accessoryId:g.accessoryId,radius:acc.radius,at:now});
  if(g.accessoryId==='flash'){
    for(const target of players.values()){
      if(!target.alive)continue;
      const d=Math.hypot(target.x-g.x,target.y-g.y);if(d>acc.radius||!grenadeLineClear(g,target))continue;
      target.blindedUntil=Math.max(target.blindedUntil||0,now+2000);
      cancelMedicalUse(target);cancelRevive(target);
      if(target.isBot){target.brain.targetId=null;target.brain.burstLeft=0;target.aiming=false;}
    }
    return;
  }
  applyExplosionDamage(owner,g.x,g.y,acc.radius,now,128);
}
function updateGrenades(dt,now){
  const gravity=310;
  for(let i=grenades.length-1;i>=0;i--){
    const g=grenades[i];
    const nx=g.x+g.vx*dt;if(canStandAt(nx,g.y,g.radius))g.x=nx;else{g.vx=-g.vx*.36;g.vy*=.82;g.bounces++;}
    const ny=g.y+g.vy*dt;if(canStandAt(g.x,ny,g.radius))g.y=ny;else{g.vy=-g.vy*.36;g.vx*=.82;g.bounces++;}
    g.z+=g.vz*dt;g.vz-=gravity*dt;
    if(g.z<=0){g.z=0;if(Math.abs(g.vz)>24)g.vz=-g.vz*.28;else g.vz=0;g.vx*=Math.pow(.34,dt);g.vy*=Math.pow(.34,dt);}
    if(now>=g.fuseAt){explodeGrenade(g,now);grenades.splice(i,1);}
  }
}
function explodeRocket(r,now){
  const a=ACCESSORIES.find(x=>x.id==='rocket')||{radius:270};const owner=players.get(r.ownerId);
  effects.push({id:String(nextEventId++),type:'explosion',shooterId:r.ownerId,x:r.x,y:r.y,accessoryId:'rocket',radius:a.radius||270,at:now});
  applyExplosionDamage(owner,r.x,r.y,a.radius||270,now,175);
}
function updateRockets(dt,now){
  for(let i=rockets.length-1;i>=0;i--){
    const r=rockets[i],step=(r.speed||720)*dt,dx=Math.cos(r.angle),dy=Math.sin(r.angle);
    const wall=firstObstacleDistance(r.x,r.y,dx,dy,step+r.radius);
    let hitDistance=Math.min(step,wall);
    let hit=false;
    for(const p of players.values()){
      if(!p.alive||p.id===r.ownerId)continue;const d=rayCircleDistance(r.x,r.y,dx,dy,p.x,p.y,(p.hitRadius||27)+r.radius);
      if(d<hitDistance){hitDistance=d;hit=true;}
    }
    for(const v of vehicles){
      if(!v.alive)continue;const d=rayCircleDistance(r.x,r.y,dx,dy,v.x,v.y,v.radius+r.radius);
      if(d<hitDistance){hitDistance=d;hit=true;}
    }
    r.x+=dx*hitDistance;r.y+=dy*hitDistance;r.traveled+=hitDistance;
    if(wall<=step+r.radius||hit||r.traveled>=r.range){explodeRocket(r,now);rockets.splice(i,1);}
  }
}
function explodeMine(m,now){
  const owner=players.get(m.ownerId);effects.push({id:String(nextEventId++),type:'explosion',shooterId:m.ownerId,x:m.x,y:m.y,accessoryId:'proximity',radius:m.radius,at:now});
  applyExplosionDamage(owner,m.x,m.y,m.radius,now,150);
}
function updateMines(now){
  for(let i=mines.length-1;i>=0;i--){
    const m=mines[i];if(now>=m.expiresAt){mines.splice(i,1);continue;}if(now<m.armedAt)continue;
    let trigger=false;
    for(const p of players.values()){if(p.alive&&Math.hypot(p.x-m.x,p.y-m.y)<=m.triggerRadius){trigger=true;break;}}
    if(!trigger)for(const v of vehicles){if(v.alive&&Math.hypot(v.x-m.x,v.y-m.y)<=m.triggerRadius+v.radius){trigger=true;break;}}
    if(trigger){explodeMine(m,now);mines.splice(i,1);}
  }
}
function updateStatusEffects(p,now){
  if((p.healOverTimeUntil||0)>now&&p.alive&&now>=(p.nextHealOverTimeAt||0)){p.nextHealOverTimeAt=now+1000;p.hp=Math.min(p.maxHp,p.hp+3);}
  if((p.healOverTimeUntil||0)&&now>=p.healOverTimeUntil)p.healOverTimeUntil=0;
  if((p.staminaBuffUntil||0)>now)p.stamina=p.maxStamina;
}
function updateSupplyCrates(now){
  for(let i=supplyCrates.length-1;i>=0;i--){
    const c=supplyCrates[i];
    if(now>=c.expiresAt){effects.push({id:String(nextEventId++),type:'crate_expire',shooterId:c.ownerId,x:c.x,y:c.y,crateType:c.type,at:now});supplyCrates.splice(i,1);continue;}
    const owner=players.get(c.ownerId);
    for(const target of players.values()){
      if(!target.alive||target.teamId!==c.teamId||Math.hypot(target.x-c.x,target.y-c.y)>c.radius)continue;
      if(c.type==='medical'&&now>=(c.nextHeal.get(target.id)||0)){
        c.nextHeal.set(target.id,now+1000);if(target.hp<target.maxHp)target.hp=Math.min(target.maxHp,target.hp+4);
      }
      const last=c.lastServe.get(target.id)||0;if(now-last<5200)continue;
      let supplied=false;
      if(c.type==='ammo'){
        const before=target.reserveAmmo||0,add=weaponFor(target).mag;
        target.reserveAmmo=Math.min(target.reserveMax||add*4,before+add);supplied=target.reserveAmmo>before;
        if(!c.accessoryServed.has(target.id)){
          const a=accessoryFor(target),max=a.maxCharges||0,beforeCharges=target.accessoryCharges||0;
          if(beforeCharges<max){target.accessoryCharges=max;c.accessoryServed.add(target.id);supplied=true;}
        }
      }else{
        const max=medicalFor(target).maxCharges,before=target.medicalCharges||0;
        target.medicalCharges=Math.min(max,before+1);supplied=target.medicalCharges>before;
      }
      if(!supplied)continue;
      c.lastServe.set(target.id,now);
      effects.push({id:String(nextEventId++),type:c.type==='ammo'?'resupply_ammo':'resupply_medical',shooterId:c.ownerId,targetId:target.id,x:c.x,y:c.y,at:now});
      if(owner&&!owner.isBot&&target.id!==owner.id)awardXp(owner,10,c.type==='ammo'?'RAVITAILLEMENT MUNITIONS':'RAVITAILLEMENT SOINS');
    }
  }
}
function starterLifeLoadout(p){
  p.weaponId='pistol';p.equipmentIds=[];p.accessoryId='none';p.accessoryCharges=0;p.toolId='none';p.toolReadyAt=0;p.medicalId='bandage';p.medicalCharges=MEDICAL_ITEMS[0].maxCharges;
  p.maxHp=100;p.hp=Math.min(p.hp||100,100);const w=WEAPONS.pistol;p.ammo=w.mag;p.reserveMax=w.mag*4;p.reserveAmmo=p.reserveMax;p.reloadingUntil=0;p.bloom=0;p.lifeLoadoutPaid=false;
}
function lifeLoadoutCost(selection){
  let total=0;const add=(kind,id)=>{const item=catalogItem(kind,id);if(item)total+=item.lifeCost||0;};
  add('weapon',selection.weaponId);for(const id of selection.equipmentIds||[])add('equipment',id);add('medical',selection.medicalId);add('tool',selection.toolId);add('accessory',selection.accessoryId);return total;
}
function updateLoadout(p,msg,now){
  if(p.isBot||!p.profileKey)return;
  if(!p.alive||!inOwnBase(p,BASE_RADIUS)){send(p.ws,'loadout_rejected',{reason:'Tu dois être dans ta base pour acheter ou modifier ton équipement.'});return;}
  const profile=profiles[p.profileKey];ensureProfileEconomy(profile);const level=playerLevel(p);
  const allowed=(kind,id)=>{const item=catalogItem(kind,id);return !!item&&item.level<=level&&hasLicense(profile,kind,id);};
  const weaponId=String(msg.weaponId||'pistol');const accessoryId=String(msg.accessoryId||'none'),toolId=String(msg.toolId||'none'),medicalId=String(msg.medicalId||'bandage');
  const equipmentIds=[...new Set((Array.isArray(msg.equipmentIds)?msg.equipmentIds:[]).map(String))].slice(0,2);
  if(!allowed('weapon',weaponId)||!allowed('medical',medicalId)||!allowed('tool',toolId)||!allowed('accessory',accessoryId)||equipmentIds.some(id=>!allowed('equipment',id))){send(p.ws,'loadout_rejected',{reason:'Licence manquante ou niveau insuffisant pour cet équipement.'});return;}
  const selection={weaponId,equipmentIds,accessoryId,toolId,medicalId};const cost=lifeLoadoutCost(selection);
  if((profile.money||0)<cost){send(p.ws,'loadout_rejected',{reason:`Il faut ${cost.toLocaleString('fr-FR')} € pour acheter ce stuff pour cette vie.`});return;}
  profile.money-=cost;p.matchMoneyNet=(p.matchMoneyNet||0)-cost;profile.loadout={...selection,equipmentIds:[...equipmentIds]};scheduleSave();
  p.weaponId=weaponId;p.equipmentIds=[...equipmentIds];p.accessoryId=accessoryId;p.toolId=toolId;p.medicalId=medicalId;p.lifeLoadoutPaid=true;
  const w=WEAPONS[weaponId];p.ammo=w.mag;p.reserveMax=w.mag*4;p.reserveAmmo=p.reserveMax;p.reloadingUntil=0;p.bloom=0;resetAccessoryCharges(p);p.medicalUseUntil=0;p.medicalTargetId=null;p.beingHealedById=null;p.healLockUntil=0;p.medicalCharges=medicalFor(p).maxCharges;
  p.maxHp=playerHasEquipment(p,'armor')?125:100;p.hp=p.maxHp;
  send(p.ws,'profile',{profile:profileView(profile),spentMoney:cost,xpReason:'ACHAT ÉQUIPEMENT'});
}
function currentSpread(p,w){
  const moving=Math.hypot(p.vx,p.vy)>15;const base=p.aiming?w.aimSpread:w.hipSpread;
  const movementPenalty=moving?w.moveSpread*(p.aiming?.45:1):0;return base+movementPenalty+p.bloom;
}
function randomSpread(max){return((Math.random()+Math.random())-1)*max;}
function tryFire(p,now,extraError=0){
  if(!p.alive||p.sprinting||p.vehicleId)return false;finishReloadIfNeeded(p,now);if(p.reloadingUntil>now)return false;
  const w=weaponFor(p);if(p.ammo<=0){startReload(p,now);return false;}
  const minGap=1000/w.fireRate;if(now-p.lastShotAt<minGap)return false;
  p.lastShotAt=now;cancelMedicalUse(p);cancelRevive(p);p.ammo--;const spread=currentSpread(p,w)+extraError;const groupId=String(nextEventId++);
  let enemyHit=false;const firedShots=[];
  for(let i=0;i<w.pellets;i++){
    const angle=normalizeAngle(p.angle+randomSpread(spread));const trace=resolveHitscan(p,angle,w,now);
    if(trace.targetId){const hit=players.get(trace.targetId);if(hit&&hit.teamId!==p.teamId)enemyHit=true;}
    const shot={id:String(nextEventId++),groupId,pelletIndex:i,shooterId:p.id,x:p.x,y:p.y,angle,range:trace.distance,at:now,weaponId:w.id,tracer:!!w.tracer,muzzleVelocity:w.muzzleVelocity||7000};shots.push(shot);firedShots.push(shot);
  }
  // Une seule confirmation par coup, même pour un fusil à pompe qui touche avec plusieurs plombs.
  if(enemyHit)effects.push({id:String(nextEventId++),type:'hit_confirm',shooterId:p.id,at:now});
  sendShotBatch(firedShots,now);
  if(w.automatic)p.bloom=Math.min(w.maxBloom,p.bloom+w.bloomPerShot);
  if(p.ammo<=0)startReload(p,now);return true;
}
function rayCircleDistance(ox,oy,dx,dy,cx,cy,r){
  const lx=cx-ox,ly=cy-oy,tca=lx*dx+ly*dy;if(tca<0)return Infinity;const d2=lx*lx+ly*ly-tca*tca;if(d2>r*r)return Infinity;
  return Math.max(0,tca-Math.sqrt(Math.max(0,r*r-d2)));
}
function rayRectDistance(ox,oy,dx,dy,rect){
  let tmin=-Infinity,tmax=Infinity;const axes=[[ox,dx,rect.x,rect.x+rect.w],[oy,dy,rect.y,rect.y+rect.h]];
  for(const[o,d,min,max]of axes){if(Math.abs(d)<1e-9){if(o<min||o>max)return Infinity;continue;}let t1=(min-o)/d,t2=(max-o)/d;if(t1>t2)[t1,t2]=[t2,t1];tmin=Math.max(tmin,t1);tmax=Math.min(tmax,t2);if(tmax<tmin)return Infinity;}
  if(tmax<0)return Infinity;return tmin>=0?tmin:tmax;
}
function firstObstacleDistance(ox,oy,dx,dy,maxDistance=Infinity){
  let best=maxDistance;
  const finite=Number.isFinite(maxDistance)?maxDistance:Math.hypot(MAP.width,MAP.height);
  const ex=ox+dx*finite,ey=oy+dy*finite;
  for(const o of obstaclesInBounds(Math.min(ox,ex),Math.min(oy,ey),Math.max(ox,ex),Math.max(oy,ey))){const d=rayRectDistance(ox,oy,dx,dy,o);if(d>=0&&d<best)best=d;}
  return best;
}
function friendlyInFireLane(shooter,angle,maxDistance){
  const dx=Math.cos(angle),dy=Math.sin(angle),wall=firstObstacleDistance(shooter.x,shooter.y,dx,dy,maxDistance);
  const limit=Math.min(maxDistance,wall);
  for(const p of players.values()){
    if(!p.alive||p.id===shooter.id||p.teamId!==shooter.teamId)continue;
    const d=rayCircleDistance(shooter.x,shooter.y,dx,dy,p.x,p.y,p.radius+9);
    if(d<limit-.001)return true;
  }
  return false;
}
function ballisticDamageMultiplier(weapon,distance){
  const full=Math.max(1,Number(weapon?.range)||1);
  if(distance<=full)return 1;
  if(distance>=full*2)return 0;
  // Après la portée nominale, les dégâts chutent linéairement jusqu'à 0 au double de la portée.
  return Math.max(0,Math.min(1,2-distance/full));
}
function resolveHitscan(shooter,angle,weapon,now){
  const dx=Math.cos(angle),dy=Math.sin(angle),ballisticRange=Math.max(1,weapon.range)*2;
  const wallDistance=firstObstacleDistance(shooter.x,shooter.y,dx,dy,ballisticRange);
  let target=null,targetVehicle=null,endDistance=Math.min(ballisticRange,wallDistance);
  for(const p of players.values()){
    if(!p.alive||p.id===shooter.id)continue;
    const d=rayCircleDistance(shooter.x,shooter.y,dx,dy,p.x,p.y,p.hitRadius||27);
    if(d<endDistance-.001){endDistance=d;target=p;targetVehicle=null;}
  }
  for(const v of vehicles){
    if(!v.alive||v.id===shooter.vehicleId)continue;
    const d=rayCircleDistance(shooter.x,shooter.y,dx,dy,v.x,v.y,v.radius);
    if(d<endDistance-.001){endDistance=d;target=null;targetVehicle=v;}
  }
  const damageMultiplier=ballisticDamageMultiplier(weapon,endDistance);
  const damage=weapon.damage*damageMultiplier;
  if(target&&damage>0)applyDamage(shooter,target,damage,now);
  else if(targetVehicle&&damage>0)applyVehicleDamage(shooter,targetVehicle,damage,now);
  return{distance:Math.max(0,endDistance),targetId:target?.id||null,vehicleId:targetVehicle?.id||null,wallHit:!target&&!targetVehicle&&wallDistance<ballisticRange,damageMultiplier};
}
function buildDownedMeta(attacker,victim,now,friendly,selfDamage){
  const assists=[];
  if(!friendly&&!selfDamage){
    for(const [aid,hit] of victim.damageContrib){
      if(aid===attacker.id||now-hit.at>8000)continue;
      const helper=players.get(aid);
      if(!helper||helper.teamId!==attacker.teamId||helper.teamId===victim.teamId)continue;
      assists.push({id:helper.id,profileKey:helper.profileKey||null,isBot:!!helper.isBot,teamId:helper.teamId,nickname:helper.nickname});
    }
  }
  return{
    attackerId:attacker.id,attackerProfileKey:attacker.profileKey||null,attackerNickname:attacker.nickname,
    attackerTeamId:attacker.teamId,attackerIsBot:!!attacker.isBot,friendly:!!friendly,selfDamage:!!selfDamage,
    downedAt:now,weaponId:attacker.weaponId||'pistol',weaponName:weaponFor(attacker).name,assists
  };
}
function awardLinkedAssistsForKill(killer){
  if(!killer)return;const ids=new Set([...(killer.reviveSponsorIds instanceof Set?killer.reviveSponsorIds:[]),...(killer.transportSponsorIds instanceof Set?killer.transportSponsorIds:[])]);
  for(const id of ids){const sponsor=players.get(id);if(!sponsor||sponsor.id===killer.id||sponsor.teamId!==killer.teamId)continue;sponsor.matchAssists=(sponsor.matchAssists||0)+1;if(!sponsor.isBot&&sponsor.profileKey&&profiles[sponsor.profileKey]){profiles[sponsor.profileKey].assists=(profiles[sponsor.profileKey].assists||0)+1;awardXp(sponsor,50,'ASSISTANCE SOUTIEN');}}
}
function scoreDowning(victim,meta){
  if(!victim||!meta||meta.scored)return false;
  meta.scored=true;
  victim.matchDeaths=(victim.matchDeaths||0)+1;
  if(!victim.isBot&&victim.profileKey&&profiles[victim.profileKey]){
    const v=profiles[victim.profileKey];v.deaths=(v.deaths||0)+1;scheduleSave();send(victim.ws,'profile',{profile:profileView(v)});
  }
  const attacker=players.get(meta.attackerId);
  if(!meta.friendly&&!meta.selfDamage){
    if(attacker){
      attacker.matchKills=(attacker.matchKills||0)+1;
      if(!attacker.isBot&&attacker.profileKey&&profiles[attacker.profileKey]){
        const a=profiles[attacker.profileKey];a.kills=(a.kills||0)+1;awardXp(attacker,100,'ÉLIMINATION');
      }
      awardLinkedAssistsForKill(attacker);
      broadcast('feed',{text:`${attacker.nickname} a tué ${victim.nickname} (${meta.weaponName||weaponFor(attacker).name})`,kind:'kill'});
    }
    for(const saved of meta.assists||[]){
      const helper=players.get(saved.id);if(!helper||helper.teamId!==meta.attackerTeamId||helper.teamId===victim.teamId)continue;
      helper.matchAssists=(helper.matchAssists||0)+1;
      if(!helper.isBot&&helper.profileKey&&profiles[helper.profileKey]){
        const hp=profiles[helper.profileKey];hp.assists=(hp.assists||0)+1;awardXp(helper,50,'ASSISTANCE');
      }
    }
  }else if(meta.friendly&&!meta.selfDamage&&attacker){
    attacker.matchTeamKills=(attacker.matchTeamKills||0)+1;if(!attacker.isBot)awardXp(attacker,-100,'TIR ALLIÉ');
    broadcast('feed',{text:`${attacker.nickname} a tué ${victim.nickname} (${meta.weaponName||weaponFor(attacker).name})`,kind:'kill'});
  }else if(meta.selfDamage&&attacker){
    broadcast('feed',{text:`${attacker.nickname} a tué ${victim.nickname} (${meta.weaponName||weaponFor(attacker).name})`,kind:'kill'});
  }
  return true;
}
function finalizeDeath(victim,now,reason='bleedout'){
  if(!victim?.downed)return false;
  const meta=victim.downedMeta;
  // Les statistiques et l'XP sont déjà attribuées à la mise au sol.
  if(meta&&!meta.scored)scoreDowning(victim,meta);
  victim.downed=false;victim.downedMeta=null;victim.downedAt=0;victim.giveUpAt=0;victim.bleedoutAt=0;victim.damageContrib=new Map();
  return true;
}
function applyDamage(attacker,victim,amount,now){
  if(!attacker||!victim.alive||amount<=0)return;if(victim.godMode||inOwnBase(victim,BASE_RADIUS))return;
  const friendly=attacker.teamId===victim.teamId;
  const selfDamage=attacker.id===victim.id;
  cancelMedicalUse(victim);if(victim.beingHealedById){const healer=players.get(victim.beingHealedById);if(healer)cancelMedicalUse(healer);victim.beingHealedById=null;victim.healLockUntil=0;}cancelRevive(victim);victim.lastDamagedAt=now;
  effects.push({id:String(nextEventId++),type:'damage_direction',shooterId:attacker.id,targetId:victim.id,x:attacker.x,y:attacker.y,at:now});
  if(!(victim.damageContrib instanceof Map))victim.damageContrib=new Map();
  const prev=victim.damageContrib.get(attacker.id)||{damage:0,at:0};victim.damageContrib.set(attacker.id,{damage:prev.damage+amount,at:now});
  victim.hp-=amount;if(victim.hp>0)return;
  // Une attaque létale met au sol et compte immédiatement comme une mort. Le killer et les assistants sont crédités dès cette mise au sol.
  victim.hp=0;if(victim.vehicleId)leaveVehicle(victim);if(victim.dragTargetId)dropDragged(victim);if(victim.draggedById){const d=players.get(victim.draggedById);if(d)dropDragged(d);}victim.alive=false;victim.downed=true;victim.downedAt=now;victim.respawnAt=now+4000;victim.bleedoutAt=victim.isBot?now+20000:0;
  victim.giveUpAt=victim.isBot?now+8000+Math.random()*4500:0;
  victim.downedMeta=buildDownedMeta(attacker,victim,now,friendly,selfDamage);
  scoreDowning(victim,victim.downedMeta);victim.reviveSponsorIds=new Set();
  victim.input={up:false,down:false,left:false,right:false,sprint:false};victim.sprinting=false;victim.aiming=false;victim.vx=0;victim.vy=0;victim.actualSpeed=0;
}
function respawn(p,now){
  if(p.vehicleId)leaveVehicle(p);if(p.dragTargetId)dropDragged(p);if(p.draggedById){const d=players.get(p.draggedById);if(d)dropDragged(d);}p.lifeId=(p.lifeId||0)+1;
  const spawn=teamSpawn(p.teamId);p.x=spawn.x;p.y=spawn.y;p.alive=true;p.downed=false;p.downedAt=0;p.downedMeta=null;p.beingRevivedById=null;p.giveUpAt=0;p.bleedoutAt=0;p.respawnAt=0;
  if(p.isBot){
    const levels=humanLevelPool(),bots=botsForTeam(p.teamId).sort((a,b)=>Number(a.id)-Number(b.id)),idx=Math.max(0,bots.findIndex(b=>b.id===p.id));
    applyBotLevelLoadout(p,levels[idx%levels.length],false);
  }else starterLifeLoadout(p);
  p.transportSponsorIds=new Set();p.reviveSponsorIds=new Set();p.warEntryLifeId=0;
  p.maxHp=playerHasEquipment(p,'armor')?125:100;p.hp=p.maxHp;p.stamina=p.maxStamina;p.sprinting=false;p.aiming=false;p.bloom=0;
  const w=weaponFor(p);p.ammo=w.mag;p.reserveMax=w.mag*4;p.reserveAmmo=p.reserveMax;p.reloadingUntil=0;p.lastShotAt=0;p.blindedUntil=0;p.damageContrib=new Map();
  p.medicalUseUntil=0;p.medicalTargetId=null;p.beingHealedById=null;p.healLockUntil=0;p.medicalCharges=medicalFor(p).maxCharges;p.healOverTimeUntil=0;p.staminaBuffUntil=0;resetAccessoryCharges(p);cancelRevive(p);
  if(p.isBot){p.brain.targetId=null;p.brain.targetAcquiredAt=0;p.brain.nextBurstAt=now+500+Math.random()*600;p.brain.navWaypoint=null;p.brain.navObstacleKey=null;p.brain.navPath=null;p.brain.navPathIndex=0;p.brain.nextPathAt=0;p.brain.stuckCount=0;p.brain.lastX=p.x;p.brain.lastY=p.y;p.brain.nextStuckCheck=now+900;p.brain.vehicleDriveX=0;p.brain.vehicleDriveY=0;p.brain.vehicleWaitUntil=0;p.brain.passengerWaitSince=0;p.brain.wantedVehicleId=null;}
  if(p.isBot&&p.pilotRole){const v=assignedPilotVehicle(p);if(v){resetVehicle(v,now);p.x=v.x;p.y=v.y;enterVehicle(p,v,false,now);v.shuttleState='base';v.shuttleDepartAt=now+5000;}}
}
function switchTeam(p,teamId,now){
  teamId=safeTeam(teamId);if(p.teamId===teamId)return;const counts=humansPerTeam();if(!p.isBot&&(counts[teamId]||0)>=MAX_HUMANS_PER_TEAM){send(p.ws,'feed',{text:`${TEAMS[teamId].name} est complète.`,kind:'join'});return;}if(p.vehicleId)leaveVehicle(p);
  const from=p.teamId;p.teamId=teamId;p.squadId=null;p.alive=false;p.downed=false;p.downedAt=0;p.downedMeta=null;p.beingRevivedById=null;p.giveUpAt=0;p.bleedoutAt=0;p.respawnAt=now+600;p.damageContrib=new Map();p.input={up:false,down:false,left:false,right:false,sprint:false};p.sprinting=false;cancelRevive(p);
  botBalanceDirty=true;broadcast('feed',{text:`${p.nickname} passe de ${TEAMS[from].name} à ${TEAMS[teamId].name}.`,kind:'join'});
}

function visionFov(p){const w=weaponFor(p);if(p.sprinting)return 110*Math.PI/180;if(p.aiming&&w.category==='sniper')return 72*Math.PI/180;if(p.aiming&&w.category==='dmr')return 92*Math.PI/180;return Math.PI;}
function isInVisionCone(viewer,target){const angleTo=Math.atan2(target.y-viewer.y,target.x-viewer.x);return Math.abs(normalizeAngle(angleTo-viewer.angle))<=visionFov(viewer)/2;}
function hasLineOfSight(viewer,target){
  const vx=target.x-viewer.x,vy=target.y-viewer.y,distance=Math.hypot(vx,vy);if(distance<1)return true;
  const dx=vx/distance,dy=vy/distance,wall=firstObstacleDistance(viewer.x,viewer.y,dx,dy,distance);
  return wall>=distance-Math.max(8,target.radius*.7);
}
function isVisibleTo(viewer,target){if(viewer.id===target.id)return true;if((viewer.blindedUntil||0)>Date.now())return false;return isInVisionCone(viewer,target)&&hasLineOfSight(viewer,target);}
function publicPlayer(p,now){
  const w=weaponFor(p),revive=reviveStateFor(p,now);return{
    id:p.id,nickname:p.nickname,isBot:p.isBot,botPersonality:p.botPersonality,teamId:p.teamId,squadId:p.squadId||null,
    x:Math.round(p.x*10)/10,y:Math.round(p.y*10)/10,vx:Math.round(p.vx),vy:Math.round(p.vy),moveSpeed:Math.round(p.actualSpeed||0),angle:p.angle,
    hp:Math.max(0,Math.round(p.hp)),maxHp:p.maxHp,alive:p.alive,downed:!!p.downed,hitRadius:p.hitRadius||27,
    respawnMs:p.downed?Math.max(0,(p.respawnAt||now)-now):(!p.alive?Math.max(0,(p.respawnAt||now)-now):0),
    bleedoutMs:p.downed?Math.max(0,(p.bleedoutAt||now)-now):0,
    beingRevivedBy:revive?.by||null,beingRevivedProgress:revive?.progress||0,beingRevivedFast:!!revive?.fast,
    weaponId:p.weaponId,equipmentIds:[...(p.equipmentIds||[])],accessoryId:p.accessoryId||'none',accessoryCharges:p.accessoryCharges||0,accessoryMax:accessoryFor(p).maxCharges||0,
    toolId:p.toolId||'none',toolCooldownMs:Math.max(0,(p.toolReadyAt||0)-now),toolReady:(p.toolReadyAt||0)<=now,
    medicalId:p.medicalId||'bandage',medicalCharges:p.medicalCharges||0,medicalUseMs:Math.max(0,(p.medicalUseUntil||0)-now),medicalTargetId:p.medicalTargetId||null,beingHealedById:p.beingHealedById||null,healLockMs:Math.max(0,(p.healLockUntil||0)-now),
    healStimMs:Math.max(0,(p.healOverTimeUntil||0)-now),staminaStimMs:Math.max(0,(p.staminaBuffUntil||0)-now),
    vehicleId:p.vehicleId||null,vehicleSeat:p.vehicleSeat||null,dragTargetId:p.dragTargetId||null,draggedById:p.draggedById||null,lifeId:p.lifeId||1,
    ammo:p.ammo,mag:w.mag,reserveAmmo:p.reserveAmmo||0,reserveMax:p.reserveMax||w.mag*4,reloadingMs:Math.max(0,p.reloadingUntil-now),blindedMs:Math.max(0,(p.blindedUntil||0)-now),
    reviveTargetId:p.reviveTargetId||null,reviveProgress:p.reviveTargetId&&p.reviveDuration?Math.max(0,Math.min(1,(now-p.reviveStartedAt)/p.reviveDuration)):0,
    level:playerLevel(p),aiming:p.aiming,sprinting:p.sprinting,stamina:Math.round(p.stamina*10)/10,maxStamina:p.maxStamina,
    spread:currentSpread(p,w),fov:visionFov(p),matchKills:p.matchKills||0,matchAssists:p.matchAssists||0,matchDeaths:p.matchDeaths||0,matchMoneyNet:p.matchMoneyNet||0,isAdmin:!!p.isAdmin,godMode:!!p.godMode,pilotRole:!!p.pilotRole,pilotCountdownMs:p.pilotRole&&p.vehicleId?Math.max(0,((vehicles.find(v=>v.id===p.vehicleId)?.shuttleDepartAt)||0)-now):0
  };
}
function publicRemotePlayer(p,now){
  // Etat strictement nécessaire au rendu d'un autre combattant. Le HUD, l'économie,
  // les cooldowns et les stats détaillées ne sont jamais dupliqués pour 98 autres entités.
  const revive=reviveStateFor(p,now);return{
    id:p.id,nickname:p.nickname,isBot:!!p.isBot,teamId:p.teamId,squadId:p.squadId||null,
    x:Math.round(p.x),y:Math.round(p.y),vx:Math.round(p.vx||0),vy:Math.round(p.vy||0),moveSpeed:Math.round(p.actualSpeed||0),angle:Math.round((p.angle||0)*1000)/1000,
    hp:Math.max(0,Math.round(p.hp)),maxHp:p.maxHp,alive:!!p.alive,downed:!!p.downed,
    beingRevivedBy:revive?.by||null,beingRevivedProgress:revive?.progress||0,beingRevivedFast:!!revive?.fast,
    weaponId:p.weaponId,reloadingMs:Math.max(0,(p.reloadingUntil||0)-now),medicalUseMs:Math.max(0,(p.medicalUseUntil||0)-now),medicalTargetId:p.medicalTargetId||null,
    vehicleId:p.vehicleId||null,vehicleSeat:p.vehicleSeat||null,dragTargetId:p.dragTargetId||null,draggedById:p.draggedById||null,
    aiming:!!p.aiming,sprinting:!!p.sprinting,pilotRole:!!p.pilotRole,pilotCountdownMs:p.pilotRole&&p.vehicleId?Math.max(0,((vehicles.find(v=>v.id===p.vehicleId)?.shuttleDepartAt)||0)-now):0
  };
}
function publicRemotePlayerWire(p,now){
  const revive=reviveStateFor(p,now);return[
    p.id,p.nickname,p.isBot?1:0,p.teamId,p.squadId||null,Math.round(p.x),Math.round(p.y),Math.round(p.vx||0),Math.round(p.vy||0),Math.round(p.actualSpeed||0),Math.round((p.angle||0)*1000)/1000,
    Math.max(0,Math.round(p.hp)),p.maxHp,p.alive?1:0,p.downed?1:0,revive?.by||null,Math.round((revive?.progress||0)*100)/100,revive?.fast?1:0,p.weaponId,Math.max(0,(p.reloadingUntil||0)-now),
    p.medicalId||'bandage',Math.max(0,(p.medicalUseUntil||0)-now),p.vehicleId||null,p.vehicleSeat||null,p.aiming?1:0,p.sprinting?1:0,p.pilotRole?1:0,p.pilotRole&&p.vehicleId?Math.max(0,((vehicles.find(v=>v.id===p.vehicleId)?.shuttleDepartAt)||0)-now):0,
    p.beingHealedById||null,Math.max(0,(p.healLockUntil||0)-now),p.dragTargetId||null,p.draggedById||null
  ];
}
function publicVehicleForViewer(v,viewer,now){
  const near=Math.hypot(v.x-viewer.x,v.y-viewer.y)<260||viewer.vehicleId===v.id;
  const base={id:v.id,type:v.type,teamId:v.teamId,x:Math.round(v.x),y:Math.round(v.y),angle:Math.round((v.angle||0)*1000)/1000,vx:Math.round(v.vx||0),vy:Math.round(v.vy||0),hp:Math.max(0,Math.round(v.hp)),maxHp:v.maxHp,alive:!!v.alive,smoking:v.alive&&v.hp/v.maxHp<=.70,burning:!!v.burningAt,burnMs:v.burningAt?Math.max(0,v.burningAt-now):0,respawnMs:!v.alive?Math.max(0,v.respawnAt-now):0,passengerCapacity:v.passengerCapacity||1};
  if(near){const driver=v.driverId&&players.get(v.driverId);base.driverId=v.driverId||null;base.driverIsBot=!!driver?.isBot;base.passengerIds=[...(v.passengerIds||[])];base.occupants=[];if(driver)base.occupants.push({id:driver.id,nickname:driver.nickname,seat:'driver',isBot:!!driver.isBot});for(const id of v.passengerIds||[]){const p=players.get(id);if(p)base.occupants.push({id:p.id,nickname:p.nickname,seat:p.vehicleSeat||'passenger',isBot:!!p.isBot});}}
  return base;
}
function updateTeamSpots(now){
  if(now<nextSpotUpdateAt)return;nextSpotUpdateAt=now+180;
  for(const id of TEAM_IDS){for(const [enemyId,spot] of teamSpots[id])if(spot.until<=now||!players.get(enemyId)?.alive)teamSpots[id].delete(enemyId);}

  // Les bots font déjà leurs propres calculs de cible/LOS. Réutiliser ce résultat évite
  // un second scan O(N²) de ~100 combattants juste pour la minimap.
  for(const viewer of players.values()){
    if(!viewer.alive||(viewer.blindedUntil||0)>now)continue;
    if(viewer.isBot){
      const target=viewer.brain?.targetId?players.get(viewer.brain.targetId):null;
      if(target?.alive&&target.teamId!==viewer.teamId&&(viewer.brain?.targetSeenAt||0)>now-1200){
        teamSpots[viewer.teamId].set(target.id,{id:target.id,x:target.x,y:target.y,teamId:target.teamId,until:now+4200});
      }
      continue;
    }
    // Les vrais joueurs conservent un repérage exact des ennemis qu'ils voient autour d'eux.
    for(const target of nearbyActors(viewer.x,viewer.y,1750)){
      if(!target.alive||target.teamId===viewer.teamId||target.id===viewer.id)continue;
      const dx=target.x-viewer.x,dy=target.y-viewer.y;
      if(isVisibleTo(viewer,target))teamSpots[viewer.teamId].set(target.id,{id:target.id,x:target.x,y:target.y,teamId:target.teamId,until:now+4200});
    }
  }
}
function radarStateFor(viewer,now){
  // Format compact : les noms de champs répétés 30+ fois représentaient une part importante du trafic radar.
  const allies=[];
  for(const p of players.values())if(p.teamId===viewer.teamId&&(p.alive||p.downed))allies.push([p.id,p.nickname,Math.round(p.x),Math.round(p.y),Math.round((p.angle||0)*1000)/1000,p.isBot?1:0,p.downed?1:0,p.squadId||null]);
  const spottedEnemies=[];
  for(const spot of teamSpots[viewer.teamId].values())if(spot.until>now)spottedEnemies.push([spot.id,Math.round(spot.x),Math.round(spot.y),spot.teamId,Math.max(0,spot.until-now)]);
  const audible=[];
  for(const p of nearbyActors(viewer.x,viewer.y,1250)){
    if(!p.alive||p.id===viewer.id)continue;
    const speed=p.actualSpeed||0;if(speed<80)continue;
    const hearing=p.sprinting?1250:720,dx=p.x-viewer.x,dy=p.y-viewer.y,d2=dx*dx+dy*dy;if(d2>hearing*hearing)continue;
    audible.push([p.id,Math.round(p.x/35)*35,Math.round(p.y/35)*35,p.sprinting?1:0]);
  }
  const teamVehicles=vehicles.filter(v=>v.teamId===viewer.teamId).map(v=>[v.id,v.type,Math.round(v.x),Math.round(v.y),v.alive?1:0]);
  return{packed:1,allies,spottedEnemies,audible,vehicles:teamVehicles};
}
function snapshotPlayerRelevant(viewer,p){
  if(p.id===viewer.id)return true;
  const dx=p.x-viewer.x,dy=p.y-viewer.y;if(dx*dx+dy*dy>REMOTE_PLAYER_RADIUS*REMOTE_PLAYER_RADIUS)return false;
  return isVisibleTo(viewer,p);
}
function shotRelevantToViewer(viewer,s,visibleIds){
  if(s.shooterId===viewer.id||visibleIds.has(s.shooterId))return true;
  const shooter=players.get(s.shooterId);
  if(shooter?.teamId===viewer.teamId){const dx=shooter.x-viewer.x,dy=shooter.y-viewer.y;if(dx*dx+dy*dy<=SHOT_REPLICATION_RADIUS*SHOT_REPLICATION_RADIUS)return true;}
  return distancePointToShot(viewer.x,viewer.y,s)<=SHOT_REPLICATION_RADIUS;
}
function sendShotBatch(batch,serverTime){
  if(!batch?.length)return;
  for(const [ws,viewer] of clients){
    if(ws.readyState!==WebSocket.OPEN)continue;
    if((ws.bufferedAmount||0)>MAX_SNAPSHOT_BACKLOG*2&&!batch.some(s=>s.shooterId===viewer.id))continue;
    const visibleIds=new Set([viewer.id]);
    // Pas de scan LOS ici : la distance au segment suffit pour les tirs proches et évite
    // de refaire des raycasts coûteux pour chaque balle de chaque rafale.
    const relevant=batch.filter(s=>shotRelevantToViewer(viewer,s,visibleIds));
    if(relevant.length){send(ws,'shot_batch',{serverTime,shots:relevant});perfStats.shotPackets++;}
  }
}
function sendSnapshotTo(ws,viewer,now){
  // Contrôle de congestion : WebSocket classique n'a pas de backpressure automatique.
  // Si un client/tunnel accumule des octets, on réduit provisoirement la cadence de CE client
  // au lieu de laisser grossir une file qui créerait plusieurs secondes de retard.
  const backlog=ws.bufferedAmount||0;
  if(backlog>MAX_SNAPSHOT_BACKLOG){perfStats.snapshotsSkipped++;return false;}
  const minGap=backlog>96*1024?200:backlog>48*1024?100:0;
  if(minGap&&now<(viewer.netNextCongestedSnapshotAt||0)){perfStats.snapshotsSkipped++;return false;}
  if(minGap)viewer.netNextCongestedSnapshotAt=now+minGap;

  const visiblePlayers=[publicPlayer(viewer,now)],remotePlayers=[],visibleIds=new Set([viewer.id]);
  const interestRadius=backlog>96*1024?2200:backlog>48*1024?2800:REMOTE_PLAYER_RADIUS;
  for(const p of nearbyActors(viewer.x,viewer.y,interestRadius))if(p.id!==viewer.id&&snapshotPlayerRelevant(viewer,p)){
    remotePlayers.push(publicRemotePlayerWire(p,now));visibleIds.add(p.id);
  }

  const previousCursor=Number(viewer.netEventCursor||0),eventCursor=nextEventId-1;
  const newEffects=effects.filter(e=>Number(e.id)>previousCursor&&(e.shooterId===viewer.id||e.targetId===viewer.id||visibleIds.has(e.shooterId)||(Math.hypot((e.x||0)-viewer.x,(e.y||0)-viewer.y)<2300&&['explosion','vehicle_explosion','crate_place','crate_expire','resupply_ammo','resupply_medical','revive','medical','medical_start','stim','rocket_launch','mine_place','vehicle_burning','damage_direction'].includes(e.type))));
  const visibleGrenades=grenades.filter(g=>g.ownerId===viewer.id||Math.hypot(g.x-viewer.x,g.y-viewer.y)<1850).map(g=>({id:g.id,accessoryId:g.accessoryId,x:g.x,y:g.y,z:g.z,teamId:g.teamId,fuseMs:Math.max(0,g.fuseAt-now)}));
  const visibleRockets=rockets.filter(r=>r.ownerId===viewer.id||Math.hypot(r.x-viewer.x,r.y-viewer.y)<3000).map(r=>({id:r.id,x:r.x,y:r.y,z:r.z,angle:r.angle,teamId:r.teamId,ownerId:r.ownerId}));
  const visibleMines=mines.filter(m=>m.teamId===viewer.teamId||Math.hypot(m.x-viewer.x,m.y-viewer.y)<650).map(m=>({id:m.id,x:m.x,y:m.y,teamId:m.teamId,armed:now>=m.armedAt,remainingMs:Math.max(0,m.expiresAt-now)}));
  const visibleCrates=supplyCrates.filter(c=>c.teamId===viewer.teamId||Math.hypot(c.x-viewer.x,c.y-viewer.y)<1600).map(c=>({id:c.id,type:c.type,teamId:c.teamId,x:c.x,y:c.y,radius:c.radius,remainingMs:Math.max(0,c.expiresAt-now)}));
  const visibleVehicles=vehicles.filter(v=>viewer.vehicleId===v.id||Math.hypot(v.x-viewer.x,v.y-viewer.y)<2800).map(v=>publicVehicleForViewer(v,viewer,now));
  const includeMeta=now>=(viewer.netNextMetaAt||0);if(includeMeta)viewer.netNextMetaAt=now+200;
  const accepted=send(ws,'snapshot',{serverTime:now,players:visiblePlayers,remotePlayers,effects:newEffects,grenades:visibleGrenades,rockets:visibleRockets,mines:visibleMines,vehicles:visibleVehicles,crates:visibleCrates,match:includeMeta?matchPublicCached(now):undefined,radar:includeMeta?radarStateFor(viewer,now):undefined});
  if(!accepted){perfStats.snapshotsSkipped++;return false;}
  viewer.netEventCursor=eventCursor;perfStats.snapshotsSent++;return true;
}
function distancePointToShot(px,py,s){
  const ex=s.x+Math.cos(s.angle)*s.range,ey=s.y+Math.sin(s.angle)*s.range,vx=ex-s.x,vy=ey-s.y,wx=px-s.x,wy=py-s.y;
  const len2=vx*vx+vy*vy||1,t=Math.max(0,Math.min(1,(wx*vx+wy*vy)/len2)),cx=s.x+vx*t,cy=s.y+vy*t;return Math.hypot(px-cx,py-cy);
}

function humansPerTeam(){
  const c={alpha:0,bravo:0,charlie:0};for(const p of players.values())if(!p.isBot)c[p.teamId]++;return c;
}
function botsForTeam(teamId){return[...players.values()].filter(p=>p.isBot&&p.teamId===teamId);}
function assignedPilotVehicle(bot){return bot?.pilotRole?vehicles.find(v=>v.teamId===bot.teamId&&v.pilotSlot===bot.pilotSlot):null;}
function assignPilotRoles(now=Date.now()){
  for(const teamId of TEAM_IDS){const bots=botsForTeam(teamId).sort((a,b)=>Number(a.id)-Number(b.id));for(const b of bots){b.pilotRole=false;b.pilotSlot=-1;}
    for(let i=0;i<Math.min(2,bots.length);i++){const b=bots[i];b.pilotRole=true;b.pilotSlot=i;b.brain.combatFocus='war';const v=assignedPilotVehicle(b);if(v?.alive&&!b.vehicleId){b.x=v.x;b.y=v.y;enterVehicle(b,v,false,now);v.departAt=0;v.shuttleState='base';v.shuttleDepartAt=0;}}
  }
}
function rebalanceBots(now){
  if(!botBalanceDirty&&now<nextBotBalanceAt)return;
  botBalanceDirty=false;nextBotBalanceAt=now+1200;
  const humans=humansPerTeam();
  for(const teamId of TEAM_IDS){
    // Chaque équipe vise TEAM_TARGET_SIZE combattants : les humains remplacent les bots.
    const need=Math.max(PILOTS_PER_TEAM,TEAM_TARGET_SIZE-humans[teamId]);let bots=botsForTeam(teamId);
    while(bots.length<need){const bot=makeBot(teamId);players.set(bot.id,bot);bots.push(bot);}
    while(bots.length>need){const bot=bots.pop();players.delete(bot.id);}
  }
  // Chaque équipe bots reproduit la distribution de niveaux des humains actuellement connectés.
  // Un joueur seul niv. 1 affronte donc des bots niv. 1 ; plusieurs joueurs de niveaux différents créent la même distribution dans les 3 équipes.
  syncBotLoadoutsToHumans();assignPilotRoles(now);
}

function chooseBotTarget(bot,now){
  const personality=BOT_PERSONALITIES[bot.botPersonality];
  const enemies=[];
  for(const p of nearbyActors(bot.x,bot.y,1350)){
    if(!p.alive||p.teamId===bot.teamId||p.id===bot.id)continue;
    const d=Math.hypot(p.x-bot.x,p.y-bot.y);
    const los=hasLineOfSight(bot,p);if(!los)continue;
    const angleTo=Math.atan2(p.y-bot.y,p.x-bot.x);
    // Ils ne voient pas magiquement derrière eux, mais réagissent à un ennemi très proche.
    const front=Math.abs(angleDelta(angleTo,bot.angle))<Math.PI*.70;
    if(front||d<330)enemies.push({p,d});
  }
  enemies.sort((a,b)=>a.d-b.d);
  let chosen=enemies[0]?.p||null;

  // Conserve parfois la cible actuelle : évite l'effet "aimbot" qui saute instantanément d'une cible à l'autre.
  if(bot.brain.targetId){
    const cur=players.get(bot.brain.targetId);
    if(cur?.alive&&cur.teamId!==bot.teamId&&hasLineOfSight(bot,cur)&&Math.hypot(cur.x-bot.x,cur.y-bot.y)<1450){
      if(Math.random()<.78)chosen=cur;
    }
  }

  if(chosen){
    bot.brain.lastKnownX=chosen.x;bot.brain.lastKnownY=chosen.y;bot.brain.targetSeenAt=now;
    bot.brain.targetLostAt=0;bot.brain.searchUntil=now+1300+Math.random()*1800;
    if(bot.brain.targetId!==chosen.id){
      bot.brain.targetId=chosen.id;
      const [r0,r1]=personality.reaction;
      bot.brain.targetAcquiredAt=now+(r0+Math.random()*(r1-r0))*bot.brain.fireDiscipline;
      bot.brain.burstLeft=0;bot.brain.nextBurstAt=bot.brain.targetAcquiredAt+120+Math.random()*180;
      bot.brain.hesitationUntil=bot.brain.targetAcquiredAt;
    }
  } else if(bot.brain.targetId){
    if(!bot.brain.targetLostAt)bot.brain.targetLostAt=now;
    // Mémoire courte de la dernière position vue : le bot va vérifier le coin au lieu d'oublier immédiatement.
    if(now>bot.brain.searchUntil)bot.brain.targetId=null;
  }
}
function nearestFriendly(bot){
  let best=null,bd=1600;
  for(const p of nearbyActors(bot.x,bot.y,1600)){
    if(!p.alive||p.teamId!==bot.teamId||p.id===bot.id)continue;
    const d=Math.hypot(p.x-bot.x,p.y-bot.y);if(d<bd){bd=d;best=p;}
  }
  return best?{p:best,d:bd}:null;
}
function botRoleDestination(bot,now){
  const personality=BOT_PERSONALITIES[bot.botPersonality],o=match.objective,b=bot.brain;
  if(now>=b.nextRoleShuffleAt){b.objectiveAngle=normalizeAngle(b.objectiveAngle+(Math.random()-.5)*1.9);b.warAngle=normalizeAngle((b.warAngle||0)+(Math.random()-.5)*1.25);b.warRadiusScale=.15+Math.random()*.78;b.objectiveRadiusScale=.72+Math.random()*.62;b.independentRoll=Math.random();b.nextRoleShuffleAt=now+8500+Math.random()*14500;b.buddyId=null;}
  let tx,ty,angle=b.objectiveAngle;
  if(b.combatFocus==='control'){
    const [r0,r1]=personality.objectiveRing;let radius=o.radius*(r0+(r1-r0)*(.2+.8*((Number(bot.id)*.61803398875)%1)))*b.objectiveRadiusScale;
    if(bot.botPersonality==='flanker'||bot.botPersonality==='scout')angle+=b.flankSide*.55;tx=o.x+Math.cos(angle)*radius;ty=o.y+Math.sin(angle)*radius;
  }else{
    const rr=WAR_ZONE.radius*(b.warRadiusScale||.55);angle=b.warAngle||angle;tx=WAR_ZONE.x+Math.cos(angle)*rr;ty=WAR_ZONE.y+Math.sin(angle)*rr;
  }
  if(!insideWarZoneXY(bot.x,bot.y,250)){
    const base=TEAMS[bot.teamId].spawn,dx=WAR_ZONE.x-base[0],dy=WAR_ZONE.y-base[1],dl=Math.hypot(dx,dy)||1,nx=dx/dl,ny=dy/dl,lane=bot.brain.laneOffset*.55;
    tx=WAR_ZONE.x-nx*(WAR_ZONE.radius*.68)+(-ny)*lane;ty=WAR_ZONE.y-ny*(WAR_ZONE.radius*.68)+(nx)*lane;
  }
  const coordinated=b.independentRoll<personality.coordination;
  if(coordinated&&['support','medic','tactical','rookie'].includes(bot.botPersonality)){
    let buddy=b.buddyId?players.get(b.buddyId):null;if(!buddy?.alive||buddy.teamId!==bot.teamId||buddy.id===bot.id){buddy=nearestFriendly(bot)?.p||null;b.buddyId=buddy?.id||null;}
    if(buddy){const bd=Math.hypot(buddy.x-bot.x,buddy.y-bot.y);if(bd>230&&bd<1450){const off=(bot.botPersonality==='support'||bot.botPersonality==='medic')?185:240;tx=buddy.x+Math.cos(angle+Math.PI/2)*off;ty=buddy.y+Math.sin(angle+Math.PI/2)*off;}}
  }
  tx=Math.max(180,Math.min(MAP.width-180,tx));ty=Math.max(180,Math.min(MAP.height-180,ty));return{x:tx,y:ty};
}
function botDesiredDestination(bot,now,target){
  const personality=BOT_PERSONALITIES[bot.botPersonality];
  let tx,ty;
  if(target){
    const dx=target.x-bot.x,dy=target.y-bot.y,d=Math.hypot(dx,dy)||1,nx=dx/d,ny=dy/d;
    const low=bot.hp/bot.maxHp<personality.retreat;
    const preferred=bot.weaponId==='dmr'?690:bot.weaponId==='smg'?320:470;
    if(low){tx=bot.x-nx*430;ty=bot.y-ny*430;}
    else if(d>preferred+150){tx=target.x-nx*preferred;ty=target.y-ny*preferred;}
    else if(d<preferred-130){tx=bot.x-nx*230;ty=bot.y-ny*230;}
    else {
      const side=bot.brain.strafeDir;tx=bot.x+(-ny*side)*185;ty=bot.y+(nx*side)*185;
      if(now>bot.brain.strafeUntil){bot.brain.strafeDir=Math.random()<.5?-1:1;bot.brain.strafeUntil=now+650+Math.random()*1250;}
    }
    if(Math.random()<personality.flank*.10){const side=bot.brain.flankSide;tx=target.x-nx*preferred+(-ny*side)*280;ty=target.y-ny*preferred+(nx*side)*280;}
  } else if(bot.brain.lastKnownX!=null&&now<bot.brain.searchUntil){
    tx=bot.brain.lastKnownX;ty=bot.brain.lastKnownY;
  } else {
    return botRoleDestination(bot,now);
  }
  return{x:tx,y:ty};
}
function setBotMoveToward(bot,dest,target,now){
  const finalDest=nearestSafeBotPoint(dest.x,dest.y,botNavRadius(bot));
  updateBotStuckRecovery(bot,finalDest,now);
  const navDest=resolveBotNavigationTarget(bot,finalDest,now);
  let dx=navDest.x-bot.x,dy=navDest.y-bot.y,d=Math.hypot(dx,dy);
  if(d<16){bot.brain.botMoveX=0;bot.brain.botMoveY=0;bot.input.sprint=false;return;}
  dx/=d;dy/=d;

  // Répulsion douce entre alliés : ils gardent leurs distances sans casser le chemin de contournement.
  let sepX=0,sepY=0,near=0;
  for(const p of nearbyActors(bot.x,bot.y,210)){
    if(!p.alive||p.id===bot.id||p.teamId!==bot.teamId)continue;
    const ax=bot.x-p.x,ay=bot.y-p.y,ad=Math.hypot(ax,ay);if(ad<=0)continue;
    const w=(210-ad)/210;sepX+=ax/ad*w;sepY+=ay/ad*w;near++;
  }
  if(near){
    // À proximité d'un véhicule réservé, une répulsion trop forte empêchait parfois
    // plusieurs passagers d'atteindre leurs portes respectives. On conserve une légère
    // séparation pour éviter le chevauchement, mais elle devient beaucoup plus faible.
    const boarding=!!bot.brain.wantedVehicleId;
    const separationStrength=boarding ? .16 : .72;
    dx+=sepX*separationStrength*bot.brain.separationBias;dy+=sepY*separationStrength*bot.brain.separationBias;
    const l=Math.hypot(dx,dy)||1;dx/=l;dy/=l;
  }

  // Sonde très proche en complément des waypoints : utile dans les coins et entre deux caisses.
  const probe=70,px=bot.x+dx*probe,py=bot.y+dy*probe;
  if(!canStandAt(px,py,botNavRadius(bot))){
    const left={x:-dy,y:dx},right={x:dy,y:-dx};
    const lOk=canStandAt(bot.x+left.x*probe,bot.y+left.y*probe,botNavRadius(bot)),rOk=canStandAt(bot.x+right.x*probe,bot.y+right.y*probe,botNavRadius(bot));
    if(lOk||rOk){
      const preferred=bot.brain.flankSide<0?left:right,fallback=bot.brain.flankSide<0?right:left;
      const v=(preferred===left?lOk:rOk)?preferred:fallback;dx=v.x;dy=v.y;
    }
  }
  bot.brain.botMoveX=dx;bot.brain.botMoveY=dy;
  bot.input.up=bot.input.down=bot.input.left=bot.input.right=false;
  const distDest=Math.hypot(finalDest.x-bot.x,finalDest.y-bot.y);
  bot.input.sprint=!target&&distDest>780&&bot.stamina>28;
}
function botHasVisibleEnemy(bot,maxDistance=1050){
  const now=Date.now();
  if((bot.blindedUntil||0)>now)return false;
  const b=bot.brain||(bot.brain={});
  // La détection de menace est volontairement mise en cache quelques millisecondes.
  // Avec ~100 combattants, recalculer plusieurs lignes de vue par tick 60 Hz coûtait
  // énormément de CPU sans améliorer perceptiblement leur temps de réaction.
  const cached=b.threatCache;
  if(cached&&now<cached.until&&cached.scanRange>=maxDistance)return cached.nearest<=maxDistance;
  const scanRange=Math.max(1700,maxDistance),scanRangeSq=scanRange*scanRange;
  let nearest=Infinity;
  for(const p of nearbyActors(bot.x,bot.y,scanRange)){
    if(!p.alive||p.teamId===bot.teamId||p.id===bot.id)continue;
    const vx=p.x-bot.x,vy=p.y-bot.y,d2=vx*vx+vy*vy;
    const d=Math.sqrt(d2),angleTo=Math.atan2(vy,vx);
    if(Math.abs(angleDelta(angleTo,bot.angle))>Math.PI*.72&&d>220)continue;
    if(hasLineOfSight(bot,p)&&d<nearest)nearest=d;
  }
  b.threatCache={nearest,scanRange,until:now+140+Math.random()*55};
  return nearest<=maxDistance;
}
function botImmediateDanger(bot,now=Date.now()){
  if(!bot?.alive)return true;
  const w=weaponFor(bot),dangerRange=Math.max(520,Math.min(1050,(w?.range||650)*1.15));
  if(botHasVisibleEnemy(bot,dangerRange))return true;
  if((bot.lastDamagedAt||0)>now-2600)return true;
  if((bot.brain?.targetSeenAt||0)>now-1800)return true;
  return false;
}

function validBotVehicleReservation(bot){
  const id=bot?.brain?.wantedVehicleId;if(!id)return null;
  const v=vehicles.find(x=>x.id===id);if(!v?.alive||v.teamId!==bot.teamId||insideWarZoneXY(bot.x,bot.y,-40)){clearVehicleReservation(bot);return null;}
  if(v.reservedDriverId===bot.id&&!v.driverId)return{v,mode:'driver'};
  if((v.reservedPassengerIds||[]).includes(bot.id)&&v.driverId&&passengerSpaceFor(v,bot.id))return{v,mode:'passenger'};
  clearVehicleReservation(bot);return null;
}
function approachReservedVehicle(bot,reservation,now){
  const {v,mode}=reservation;
  const point=vehicleBoardingPoint(v,bot,mode),d=Math.hypot(point.x-bot.x,point.y-bot.y);
  // Si le véhicule a commencé à quitter la base, libère immédiatement la réservation.
  if(!inTeamBase(bot.teamId,v.x,v.y,BASE_RADIUS+460)){clearVehicleReservation(bot);return false;}
  if(d<=58){
    bot.brain.botMoveX=0;bot.brain.botMoveY=0;bot.input.sprint=false;
    if(!bot.brain.passengerWaitSince)bot.brain.passengerWaitSince=now;
    const wait=mode==='driver'?120:90;
    if(now-bot.brain.passengerWaitSince>=wait){
      const ok=enterVehicle(bot,v,mode==='passenger',now);
      if(ok){bot.brain.passengerWaitSince=0;clearVehicleReservation(bot);return true;}
    }
    return true;
  }
  bot.brain.passengerWaitSince=0;
  // Sécurité anti-bouchon : un bot qui a déjà atteint la zone immédiate du véhicule depuis
  // plus de 1,8 s est embarqué dès qu'il existe une place réservée. Visuellement il est déjà
  // à côté du véhicule, mais on évite qu'un autre bot le repousse indéfiniment de 10-20 px.
  const reservedFor=Math.max(0,now-(bot.brain.vehicleReservedAt||now));
  const centerDist=Math.hypot(v.x-bot.x,v.y-bot.y);
  if(reservedFor>1800&&centerDist<=v.radius+150){
    if(enterVehicle(bot,v,mode==='passenger',now)){clearVehicleReservation(bot);return true;}
  }
  setBotMoveToward(bot,point,null,now);bot.angle=Math.atan2(point.y-bot.y,point.x-bot.x);return true;
}
function preferredPassengerVehicle(bot){
  let best=null,bestScore=-Infinity;
  for(const v of vehicles){
    if(!v.alive||v.teamId!==bot.teamId||!v.driverId||!inTeamBase(bot.teamId,v.x,v.y,BASE_RADIUS+460)||!passengerSpaceFor(v,bot.id))continue;
    const filled=(v.passengerIds||[]).length+(v.reservedPassengerIds||[]).length;
    // On remplit d'abord une navette déjà commencée au lieu de répartir quatre bots sur
    // quatre véhicules différents. Cela déclenche beaucoup plus vite les rotations.
    const shuttleBonus=v.pilotSlot!=null?100000:0;
    const fillBonus=filled*9000;
    const dist=Math.hypot(v.x-bot.x,v.y-bot.y);
    const score=shuttleBonus+fillBonus-dist;
    if(score>bestScore){bestScore=score;best=v;}
  }
  return best;
}
function preferredDriverVehicle(bot){
  let best=null,bd=Infinity;
  for(const v of vehicles){
    if(!v.alive||v.teamId!==bot.teamId||v.pilotSlot!=null||v.driverId||!inTeamBase(bot.teamId,v.x,v.y,BASE_RADIUS+300)||(v.reservedDriverId&&v.reservedDriverId!==bot.id))continue;
    const d=Math.hypot(v.x-bot.x,v.y-bot.y);if(d<bd){best=v;bd=d;}
  }
  return best;
}
function botBaseWaitingPoint(bot){
  const base=TEAMS[bot.teamId].spawn,b=bot.brain;
  // Les combattants sans place attendent sur un anneau autour de la base au lieu de tous
  // s'empiler au point de spawn et de bloquer les portes des véhicules.
  for(let i=0;i<6;i++){
    const a=(b.baseWaitAngle||0)+i*.61,r=(b.baseWaitRadius||520)+i*26;
    const p=nearestSafeBotPoint(base[0]+Math.cos(a)*r,base[1]+Math.sin(a)*r,botNavRadius(bot));
    if(inTeamBase(bot.teamId,p.x,p.y,BASE_RADIUS*.86))return p;
  }
  return{x:base[0],y:base[1]};
}
function pilotVehicleBehavior(bot,now){
  if(!bot.pilotRole)return false;const v=assignedPilotVehicle(bot);bot.brain.vehicleDriveX=0;bot.brain.vehicleDriveY=0;
  if(!v||!v.alive){if(bot.vehicleId)leaveVehicle(bot);const base=TEAMS[bot.teamId].spawn;setBotMoveToward(bot,{x:base[0],y:base[1]},null,now);return true;}
  if(bot.vehicleId!==v.id){if(bot.vehicleId)leaveVehicle(bot);const d=Math.hypot(v.x-bot.x,v.y-bot.y);if(d>100){setBotMoveToward(bot,{x:v.x,y:v.y},null,now);return true;}enterVehicle(bot,v,false,now);v.shuttleState='base';v.shuttleDepartAt=0;}
  if(bot.vehicleSeat!=='driver')return true;
  const base=TEAMS[bot.teamId].spawn;
  if(v.shuttleState==='base'){
    if(Math.hypot(v.x-base[0],v.y-base[1])>330){v.shuttleState='return';}
    else{
      const full=(v.passengerIds||[]).length>=(v.passengerCapacity||1);
      // Les deux pilotes-navettes attendent un véhicule complet avant chaque rotation.
      if(!full){v.shuttleDepartAt=0;bot.brain.vehicleDriveX=0;bot.brain.vehicleDriveY=0;return true;}
      if(!v.shuttleDepartAt)v.shuttleDepartAt=now+1200;
      if(prepActive(now))v.shuttleDepartAt=Math.max(v.shuttleDepartAt,match.prepUntil+250);
      if(now<v.shuttleDepartAt)return true;
      v.shuttleState='outbound';v.shuttleDepartAt=0;clearVehicleNav(v);
    }
  }
  if(v.shuttleState==='outbound'){
    // On entre franchement dans la zone avant de décharger. Cela évite aux passagers
    // d'être replacés juste derrière la frontière et de vouloir remonter immédiatement.
    if(insideWarZoneXY(v.x,v.y,-360)){
      for(const id of [...(v.passengerIds||[])]){const pp=players.get(id);if(pp)disembarkBotInsideWar(pp,v,now);}
      clearVehicleNav(v);v.shuttleState='return';
    }
    else{const a=Math.atan2(WAR_ZONE.y-base[1],WAR_ZONE.x-base[0]),target={x:WAR_ZONE.x-Math.cos(a)*(WAR_ZONE.radius*.62),y:WAR_ZONE.y-Math.sin(a)*(WAR_ZONE.radius*.62)};const vec=vehicleDriveTarget(v,target,now);bot.brain.vehicleDriveX=vec.x;bot.brain.vehicleDriveY=vec.y;bot.angle=v.angle;return true;}
  }
  if(v.shuttleState==='return'){
    const d=Math.hypot(v.x-base[0],v.y-base[1]);if(d<220){clearVehicleNav(v);v.shuttleState='base';v.shuttleDepartAt=0;return true;}const vec=vehicleDriveTarget(v,{x:base[0],y:base[1]},now);bot.brain.vehicleDriveX=vec.x;bot.brain.vehicleDriveY=vec.y;bot.angle=v.angle;return true;
  }
  return true;
}
function botVehicleBehavior(bot,now){
  if(bot.pilotRole)return pilotVehicleBehavior(bot,now);
  const inWar=insideWarZoneXY(bot.x,bot.y,-40);
  if(bot.vehicleId){
    const v=vehicles.find(x=>x.id===bot.vehicleId);if(!v?.alive){bot.vehicleId=null;bot.vehicleSeat=null;clearVehicleReservation(bot);resetBotNavAfterVehicle(bot,now);return false;}
    const safelyInside=insideWarZoneXY(v.x,v.y,-330);
    if(safelyInside||(v.lastDamagedAt||0)>now-1300||(bot.lastDamagedAt||0)>now-1300){
      if(safelyInside)disembarkBotInsideWar(bot,v,now);else{leaveVehicle(bot);resetBotNavAfterVehicle(bot,now);}
      clearVehicleReservation(bot);bot.brain.vehicleDriveX=0;bot.brain.vehicleDriveY=0;return false;
    }
    if(bot.vehicleSeat==='driver'){
      if(now<(v.departAt||0)){bot.brain.vehicleDriveX=0;bot.brain.vehicleDriveY=0;return true;}
      const base=TEAMS[bot.teamId].spawn,a=Math.atan2(WAR_ZONE.y-base[1],WAR_ZONE.x-base[0]),target={x:WAR_ZONE.x-Math.cos(a)*(WAR_ZONE.radius*.61),y:WAR_ZONE.y-Math.sin(a)*(WAR_ZONE.radius*.61)};
      const vec=vehicleDriveTarget(v,target,now);bot.brain.vehicleDriveX=vec.x;bot.brain.vehicleDriveY=vec.y;bot.angle=v.angle;return true;
    }
    bot.brain.vehicleDriveX=0;bot.brain.vehicleDriveY=0;return true;
  }
  bot.brain.vehicleDriveX=0;bot.brain.vehicleDriveY=0;const b=bot.brain;
  if(inWar){clearVehicleReservation(bot);return false;}
  // Un combat à proximité ou un allié au sol reste prioritaire sur l'attente d'un transport.
  const localThreat=botHasVisibleEnemy(bot,980);
  if(localThreat||nearestDownedFriendly(bot,520))return false;
  const existingReservation=validBotVehicleReservation(bot);
  if(existingReservation)return approachReservedVehicle(bot,existingReservation,now);
  const prepRemain=Math.max(0,(match.prepUntil||0)-now);
  if(prepRemain<=8000&&now>=(b.vehicleWaitUntil||0)){
    // Les places passager sont prioritaires, en particulier celles des navettes dédiées.
    // Cela évite que les bots se dispersent entre tous les véhicules et laisse les deux
    // navettes à moitié vides pendant une longue période.
    const passengerVehicle=preferredPassengerVehicle(bot);
    if(passengerVehicle&&reservePassenger(bot,passengerVehicle,now)){
      const r=validBotVehicleReservation(bot);if(r)return approachReservedVehicle(bot,r,now);
    }
    // Une minorité de profils prend le volant d'un véhicule libre une fois les navettes
    // occupées/réservées. La réservation est stable jusqu'à l'embarquement.
    if(b.vehicleAffinity<.26){
      const driverVehicle=preferredDriverVehicle(bot);
      if(driverVehicle&&reserveDriver(bot,driverVehicle,now)){
        const r=validBotVehicleReservation(bot);if(r)return approachReservedVehicle(bot,r,now);
      }
    }
  }
  // Aucun transport disponible : le combattant reste dans la zone d'attente de sa base
  // au lieu de commencer les plusieurs kilomètres de trajet à pied jusqu'à la zone de guerre.
  // Chaque bot possède cependant son propre point d'attente afin de ne plus former un amas
  // au centre de la base ou devant les jeeps.
  clearVehicleReservation(bot);const wait=botBaseWaitingPoint(bot),waitDist=Math.hypot(bot.x-wait.x,bot.y-wait.y);
  if(waitDist>70){setBotMoveToward(bot,wait,null,now);bot.angle=Math.atan2(wait.y-bot.y,wait.x-bot.x);}
  else{bot.brain.botMoveX=0;bot.brain.botMoveY=0;bot.input.sprint=false;bot.aiming=false;}
  return true;
}
function updateBot(bot,dt,now){
  if(!bot.alive)return;
  finishReloadIfNeeded(bot,now);
  if(botVehicleBehavior(bot,now))return;
  if(bot.medicalUseUntil>now){
    const threatened=botHasVisibleEnemy(bot,Math.max(520,weaponFor(bot).range*1.08))||(bot.lastDamagedAt||0)>now-2200;
    if(threatened)cancelMedicalUse(bot);
    else{bot.brain.botMoveX=0;bot.brain.botMoveY=0;bot.input.sprint=false;bot.aiming=false;return;}
  }
  if(bot.reviveTargetId){
    if(botImmediateDanger(bot,now)){cancelRevive(bot);}else{bot.brain.botMoveX=0;bot.brain.botMoveY=0;bot.input.sprint=false;bot.aiming=false;return;}
  }
  const botCombatUnsafe=botImmediateDanger(bot,now);
  if(!botCombatUnsafe&&bot.hp<48&&(bot.medicalCharges||0)>0&&['support','cautious','marksman'].includes(bot.botPersonality)){
    bot.brain.botMoveX=0;bot.brain.botMoveY=0;bot.input.sprint=false;if(useMedical(bot,now))return;
  }
  // Réanimation opportuniste : si aucun danger immédiat n'est détecté, une bots peut interrompre
  // sa progression pour relever un allié proche. Les profils médicaux/soutien le font presque
  // systématiquement, les profils très indépendants seulement une partie du temps.
  const reviveCandidate=!botImmediateDanger(bot,now)?nearestDownedFriendly(bot,760):null;
  if(reviveCandidate){
    const personality=BOT_PERSONALITIES[bot.botPersonality]||BOT_PERSONALITIES.tactical;
    const medicBias=['medic','support','tactical','rookie'].includes(bot.botPersonality)?.95:Math.max(.28,personality.coordination||0);
    const committed=bot.brain.reviveIntentId===reviveCandidate.id&&now<(bot.brain.reviveIntentUntil||0);
    if(committed||Math.random()<medicBias){
      bot.brain.reviveIntentId=reviveCandidate.id;bot.brain.reviveIntentUntil=now+5200;
      const rd=Math.hypot(reviveCandidate.x-bot.x,reviveCandidate.y-bot.y);
      if(rd<=78){bot.brain.botMoveX=0;bot.brain.botMoveY=0;bot.input.sprint=false;startRevive(bot,now);return;}
      setBotMoveToward(bot,{x:reviveCandidate.x,y:reviveCandidate.y},null,now);bot.angle=Math.atan2(reviveCandidate.y-bot.y,reviveCandidate.x-bot.x);return;
    }
  }else{bot.brain.reviveIntentId=null;bot.brain.reviveIntentUntil=0;}
  if((bot.blindedUntil||0)>now){
    bot.brain.targetId=null;bot.brain.burstLeft=0;bot.aiming=false;bot.input.sprint=false;
    const dest=botDesiredDestination(bot,now,null);setBotMoveToward(bot,dest,null,now);
    bot.angle=normalizeAngle(bot.angle+0.35*dt*bot.brain.flankSide);
    return;
  }
  if(now>=bot.brain.nextThinkAt){
    chooseBotTarget(bot,now);bot.brain.nextThinkAt=now+190+Math.random()*190;
  }
  let target=bot.brain.targetId?players.get(bot.brain.targetId):null;
  let hasTarget=false;
  if(target?.alive&&target.teamId!==bot.teamId){
    const b=bot.brain;
    if(b.targetLosId===target.id&&now<(b.targetLosUntil||0))hasTarget=!!b.targetLosValue;
    else{
      hasTarget=hasLineOfSight(bot,target);
      b.targetLosId=target.id;b.targetLosValue=hasTarget;b.targetLosUntil=now+75+Math.random()*35;
    }
  }
  if(hasTarget){
    const desired=Math.atan2(target.y-bot.y,target.x-bot.x);const personality=BOT_PERSONALITIES[bot.botPersonality];
    const dist=Math.hypot(target.x-bot.x,target.y-bot.y);
    bot.brain.lastKnownX=target.x;bot.brain.lastKnownY=target.y;bot.brain.targetSeenAt=now;bot.brain.searchUntil=now+1300+Math.random()*1800;
    const lead=Math.min(.15,dist/8500);const leadAngle=Math.atan2((target.y+target.vy*lead)-bot.y,(target.x+target.vx*lead)-bot.x);
    // Wobble faible mais permanent : même un bon bot n'est jamais parfaitement verrouillé au centre du joueur.
    const wobble=Math.sin(now*.004+Number(bot.id)*.73)*personality.aimError*.24;
    const desiredAim=normalizeAngle(leadAngle+wobble+(Math.random()-.5)*personality.aimError*.18);
    bot.brain.aimAngle=normalizeAngle(bot.brain.aimAngle+angleDelta(desiredAim,bot.brain.aimAngle)*Math.min(1,dt*(1.90+personality.aggression*1.30)));
    bot.angle=bot.brain.aimAngle;bot.aiming=now>=bot.brain.targetAcquiredAt&&dist>225;bot.input.sprint=false;
    const dest=botDesiredDestination(bot,now,target);setBotMoveToward(bot,dest,target,now);
    if(bot.ammo<=Math.max(1,Math.floor(weaponFor(bot).mag*.18))&&now>bot.brain.nextBurstAt){startReload(bot,now);bot.brain.nextBurstAt=now+750+Math.random()*350;}
    const aimErr=Math.abs(angleDelta(desired,bot.angle));
    if(now>=bot.brain.targetAcquiredAt&&now>=bot.brain.hesitationUntil&&aimErr<.22&&dist<weaponFor(bot).range*.95&&bot.reloadingUntil<=now){
      if(bot.brain.burstLeft<=0&&now>=bot.brain.nextBurstAt){
        const [b0,b1]=personality.burst;bot.brain.burstLeft=Math.floor(b0+Math.random()*(b1-b0+1));
        // Des pauses irrégulières entre les rafales donnent un rythme moins robotique.
        if(Math.random()<.13)bot.brain.hesitationUntil=now+180+Math.random()*420;
      }
      if(bot.brain.burstLeft>0&&now>=bot.brain.hesitationUntil){
        const difficultyError=(personality.aimError+(dist/weaponFor(bot).range)*.048)*(1.18+bot.brain.fireDiscipline*.30);
        // Avec le tir allié actif, une bots raisonnable retient volontairement son feu si un allié coupe directement sa ligne de tir.
        if(friendlyInFireLane(bot,bot.angle,Math.min(dist,weaponFor(bot).range*2))){bot.brain.burstLeft=0;bot.brain.nextBurstAt=now+160+Math.random()*320;}
        else if(tryFire(bot,now,difficultyError)){bot.brain.burstLeft--;if(bot.brain.burstLeft<=0)bot.brain.nextBurstAt=now+360+Math.random()*980;}
      }
    }
  } else {
    bot.aiming=false;
    if(target&&!target.alive)bot.brain.targetId=null;
    const dest=botDesiredDestination(bot,now,null);const moveAngle=Math.atan2(dest.y-bot.y,dest.x-bot.x);
    bot.angle=normalizeAngle(bot.angle+angleDelta(moveAngle,bot.angle)*Math.min(1,dt*2.25));setBotMoveToward(bot,dest,null,now);
    if(bot.brain.lastKnownX!=null&&Math.hypot(bot.x-bot.brain.lastKnownX,bot.y-bot.brain.lastKnownY)<95){bot.brain.lastKnownX=null;bot.brain.lastKnownY=null;}
    if(bot.ammo<weaponFor(bot).mag*.45&&bot.reloadingUntil<=now)startReload(bot,now);
  }
}

function pickObjectiveTarget(fromX,fromY){
  const maxR=Math.max(1200,WAR_ZONE.radius-match.objective.radius-650);
  for(let i=0;i<120;i++){const a=Math.random()*Math.PI*2,r=Math.sqrt(Math.random())*maxR,x=WAR_ZONE.x+Math.cos(a)*r,y=WAR_ZONE.y+Math.sin(a)*r;if(Math.hypot(x-fromX,y-fromY)<2200)continue;if(canStandAt(x,y,110))return{x,y};}
  return{x:WAR_ZONE.x,y:WAR_ZONE.y};
}
function moveObjective(o,dt,now){
  const dx=o.targetX-o.x,dy=o.targetY-o.y,d=Math.hypot(dx,dy);if(d<90||now>=o.nextTargetAt){const target=pickObjectiveTarget(o.x,o.y);o.targetX=target.x;o.targetY=target.y;o.nextTargetAt=now+36000+Math.random()*28000;return;}const step=Math.min(d,o.speed*dt);o.x+=dx/d*step;o.y+=dy/d*step;
}
function warControlState(weighted,now){
  const ordered=TEAM_IDS.map(id=>({id,n:weighted[id]||0})).sort((a,b)=>b.n-a.n);
  const top=ordered[0],second=ordered[1];
  const tied=!!top&&top.n>0&&second&&top.n===second.n;
  const leader=top&&top.n>0&&!tied?top.id:null;
  const elapsed=Math.max(0,now-(match.lastWarScoreAt||now));
  return{occupants:{...weighted},leader,tied,cycle:Math.max(0,Math.min(1,elapsed/10000))};
}
function updateObjective(now){
  const o=match.objective;if(match.winner)return;
  if(prepActive(now)){
    match.lastObjectiveTickAt=now;match.lastWarScoreAt=now;match.lastZoneXpAt=now;
    match.warControl={occupants:{alpha:0,bravo:0,charlie:0},leader:null,tied:false,cycle:0};return;
  }
  const dt=Math.min(.25,(now-match.lastObjectiveTickAt)/1000);match.lastObjectiveTickAt=now;moveObjective(o,dt,now);
  const pointOcc={alpha:0,bravo:0,charlie:0},weighted={alpha:0,bravo:0,charlie:0};
  for(const p of players.values()){
    if(!p.alive)continue;const inWar=insideWarZoneXY(p.x,p.y),inPoint=inWar&&Math.hypot(p.x-o.x,p.y-o.y)<=o.radius;
    if(inWar)weighted[p.teamId]+=1;if(inPoint){pointOcc[p.teamId]++;weighted[p.teamId]+=1;}
    if(!p.isBot&&inWar&&p.warEntryLifeId!==(p.lifeId||1)){p.warEntryLifeId=p.lifeId||1;awardXp(p,WAR_ENTRY_XP,'ENTRÉE ZONE DE GUERRE');}
  }
  o.occupants=pointOcc;const pointTeams=TEAM_IDS.filter(id=>pointOcc[id]>0);o.contested=pointTeams.length>1;o.owner=pointTeams.length===1?pointTeams[0]:null;
  for(const id of TEAM_IDS)o.capture[id]=o.owner===id?100:0;
  match.warControl=warControlState(weighted,now);
  if(now-(match.lastZoneXpAt||0)>=5000){const ticks=Math.floor((now-(match.lastZoneXpAt||0))/5000);match.lastZoneXpAt=(match.lastZoneXpAt||now)+ticks*5000;for(const p of players.values())if(!p.isBot&&p.alive&&insideWarZoneXY(p.x,p.y))awardXp(p,WAR_PRESENCE_XP*ticks,'PRÉSENCE ZONE DE GUERRE');}
  if(now-(match.lastWarScoreAt||0)>=10000){
    const ticks=Math.floor((now-(match.lastWarScoreAt||0))/10000);match.lastWarScoreAt=(match.lastWarScoreAt||now)+ticks*10000;
    for(let t=0;t<ticks&&!match.winner;t++){
      // À égalité pour la première place (2 ou 3 équipes), personne ne marque ce cycle.
      const state=warControlState(weighted,match.lastWarScoreAt);if(!state.leader)continue;
      match.scores[state.leader]++;
      if(match.scores[state.leader]>=match.scoreLimit){match.scores[state.leader]=match.scoreLimit;match.winner=state.leader;match.resetAt=now+9000;for(const p of players.values())if(!p.isBot&&p.teamId===match.winner)awardXp(p,300,'VICTOIRE');broadcast('feed',{text:`${TEAMS[match.winner].name} remporte la manche !`,kind:'kill'});}
    }
    // Le tick vient de repartir à zéro, tout en conservant le leader courant et les effectifs.
    const state=warControlState(weighted,now);state.cycle=0;match.warControl=state;
  }
}
function resetRound(now){
  match.round++;match.scores={alpha:0,bravo:0,charlie:0};match.warControl={occupants:{alpha:0,bravo:0,charlie:0},leader:null,tied:false,cycle:0};match.winner=null;match.resetAt=0;match.prepUntil=now+ROUND_PREP_MS;match.lastScoreAt=now;match.lastWarScoreAt=now;match.lastZoneXpAt=now;resetRoundBotNames((now^match.round)>>>0);
  const o=match.objective;const start=pickObjectiveTarget(MAP.width*.18,MAP.height*.18);o.x=start.x;o.y=start.y;o.owner=null;o.capture={alpha:0,bravo:0,charlie:0};o.contested=false;o.occupants={alpha:0,bravo:0,charlie:0};
  const target=pickObjectiveTarget(o.x,o.y);o.targetX=target.x;o.targetY=target.y;o.nextTargetAt=now+42000;
  grenades.length=0;rockets.length=0;mines.length=0;supplyCrates.length=0;
  for(const v of vehicles)resetVehicle(v,now);
  for(const p of players.values()){if(p.isBot)p.nickname=nextBotName();p.matchKills=0;p.matchAssists=0;p.matchDeaths=0;p.matchMoneyNet=0;p.warEntryLifeId=0;p.reviveSponsorIds=new Set();p.transportSponsorIds=new Set();p.alive=false;p.downed=false;p.downedAt=0;p.downedMeta=null;p.beingRevivedById=null;p.giveUpAt=0;p.bleedoutAt=0;p.respawnAt=now+600;p.damageContrib=new Map();p.dragTargetId=null;p.draggedById=null;cancelRevive(p);}
}

function runGeometrySelfTests(){
  const assert=require('assert');const testWall={x:100,y:-50,w:40,h:100};const wallDist=rayRectDistance(0,0,1,0,testWall);assert(Math.abs(wallDist-100)<.001);
  const playerDist=rayCircleDistance(0,0,1,0,200,0,20);assert(playerDist>wallDist);
  const v={id:'v',x:0,y:0,angle:0,sprinting:false},front={id:'f',x:100,y:0,radius:24},rear={id:'r',x:-100,y:0,radius:24};assert(isInVisionCone(v,front));assert(!isInVisionCone(v,rear));
  v.sprinting=true;assert(!isInVisionCone(v,{id:'s',x:100,y:150,radius:24}));
  const realWall=MAP.obstacles[0],wallViewer={id:'wv',x:realWall.x-500,y:realWall.y+realWall.h/2,angle:0,sprinting:false,radius:24},behindWall={id:'bw',x:realWall.x+realWall.w+120,y:realWall.y+realWall.h/2,radius:24};
  assert(!hasLineOfSight(wallViewer,behindWall));assert(MAP.width*MAP.height>=2400*1600*100);assert(canStandAt(match.objective.x,match.objective.y,110));

  // Balistique v2.3 : dégâts pleins jusqu'à la portée nominale, puis chute linéaire jusqu'à 0 au double.
  const testWeapon={range:1000};
  assert.strictEqual(ballisticDamageMultiplier(testWeapon,500),1,'Damage was reduced before nominal range');
  assert.strictEqual(ballisticDamageMultiplier(testWeapon,1000),1,'Nominal range must keep full damage');
  assert(Math.abs(ballisticDamageMultiplier(testWeapon,1500)-.5)<1e-9,'Damage falloff at 1.5x range is incorrect');
  assert.strictEqual(ballisticDamageMultiplier(testWeapon,2000),0,'Damage must be zero at double range');
  assert.strictEqual(ballisticDamageMultiplier(testWeapon,2500),0,'Damage must stay zero past double range');

  // Tir allié : balles, frag et flash doivent aussi affecter un membre de la même équipe.
  const ffNow=Date.now(),ffBaseX=match.objective.x,ffBaseY=match.objective.y;
  const ffOwner={id:'ff-owner',nickname:'Owner',isBot:true,teamId:'alpha',x:ffBaseX,y:ffBaseY,radius:24,hp:100,maxHp:100,alive:true,input:{},sprinting:false,matchKills:0,matchDeaths:0,damageContrib:new Map(),brain:{targetId:null,burstLeft:0}};
  const ffMate={id:'ff-mate',nickname:'Mate',isBot:true,teamId:'alpha',x:ffBaseX+180,y:ffBaseY,radius:24,hp:100,maxHp:100,alive:true,input:{},sprinting:false,matchKills:0,matchDeaths:0,damageContrib:new Map(),blindedUntil:0,brain:{targetId:'x',burstLeft:2}};
  applyDamage(ffOwner,ffMate,20,ffNow);assert.strictEqual(ffMate.hp,80,'Friendly-fire bullet damage was ignored');ffMate.hp=100;ffMate.damageContrib=new Map();
  players.set(ffOwner.id,ffOwner);players.set(ffMate.id,ffMate);const effectsBefore=effects.length;
  explodeGrenade({ownerId:ffOwner.id,teamId:'alpha',accessoryId:'flash',x:ffBaseX,y:ffBaseY},ffNow);assert(ffMate.blindedUntil>=ffNow+2000,'Friendly flash was ignored');
  ffOwner.alive=true;ffOwner.hp=100;ffOwner.damageContrib=new Map();ffMate.alive=true;ffMate.hp=100;ffMate.damageContrib=new Map();
  explodeGrenade({ownerId:ffOwner.id,teamId:'alpha',accessoryId:'frag',x:ffBaseX,y:ffBaseY},ffNow);assert(ffMate.hp<100,'Friendly frag damage was ignored');
  players.delete(ffOwner.id);players.delete(ffMate.id);effects.splice(effectsBefore);

  // Soin manuel : aucun regen automatique, une charge est consommée uniquement à la fin de l'application.
  const medTester={id:'med-test',isBot:true,teamId:'alpha',x:ffBaseX,y:ffBaseY,radius:24,hp:20,maxHp:100,alive:true,sprinting:false,medicalId:'bandage',medicalCharges:3,medicalUseUntil:0,reloadingUntil:0,aiming:false};
  assert(useMedical(medTester,ffNow),'Medical item did not start');finishMedicalUseIfNeeded(medTester,ffNow+3000);
  assert.strictEqual(medTester.hp,55,'Bandage healing amount is wrong');assert.strictEqual(medTester.medicalCharges,2,'Bandage charge was not consumed');

  // Réanimation normale / défibrillateur.
  const reviver={id:'reviver-test',nickname:'Medic',isBot:true,teamId:'bravo',x:ffBaseX,y:ffBaseY,radius:24,hp:100,maxHp:100,alive:true,downed:false,sprinting:false,vx:0,vy:0,accessoryId:'frag',accessoryCharges:1,toolId:'defib',toolReadyAt:0,medicalId:'bandage',medicalCharges:3,input:{},stamina:100,maxStamina:100};
  const downed={id:'downed-test',nickname:'Downed',isBot:true,teamId:'bravo',x:ffBaseX+40,y:ffBaseY,radius:24,hp:0,maxHp:100,alive:false,downed:true,bleedoutAt:ffNow+20000,respawnAt:ffNow+4000,input:{},damageContrib:new Map(),stamina:0,maxStamina:100};
  players.set(reviver.id,reviver);players.set(downed.id,downed);assert(startRevive(reviver,ffNow),'Defib revive did not start');finishReviveIfNeeded(reviver,ffNow+2000);
  assert(downed.alive&&!downed.downed,'Defib revive did not complete');assert(reviver.toolReadyAt>=ffNow+9900,'Defib cooldown was not applied');
  players.delete(reviver.id);players.delete(downed.id);

  // Une cible ne peut être réanimée que par un seul joueur à la fois : évite double complétion / double XP.
  const reviveA={...reviver,id:'revive-a',toolId:'none',toolReadyAt:0,reviveTargetId:null,reviveStartedAt:0,reviveDuration:0};
  const reviveB={...reviver,id:'revive-b',toolId:'none',toolReadyAt:0,reviveTargetId:null,reviveStartedAt:0,reviveDuration:0};
  const reviveTarget={...downed,id:'revive-target',alive:false,downed:true,hp:0,beingRevivedById:null};
  players.set(reviveA.id,reviveA);players.set(reviveB.id,reviveB);players.set(reviveTarget.id,reviveTarget);
  assert(startRevive(reviveA,ffNow),'First revive did not start');assert.strictEqual(startRevive(reviveB,ffNow+10),false,'Two players could revive the same target simultaneously');
  cancelRevive(reviveA);assert(startRevive(reviveB,ffNow+20),'Revive lock was not released after cancellation');cancelRevive(reviveB);
  players.delete(reviveA.id);players.delete(reviveB.id);players.delete(reviveTarget.id);

  // Mort / réanimation : chaque mise au sol compte immédiatement comme un kill/mort. Une réanimation ne retire pas ces stats et la mort définitive ne recompte rien.
  const deathAttacker={id:'death-atk',nickname:'Attacker',isBot:true,teamId:'alpha',x:ffBaseX,y:ffBaseY,radius:24,hp:100,maxHp:100,alive:true,downed:false,input:{},sprinting:false,matchKills:0,matchAssists:0,matchDeaths:0,damageContrib:new Map(),brain:{targetId:null,burstLeft:0}};
  const deathHelper={id:'death-helper',nickname:'Helper',isBot:true,teamId:'alpha',x:ffBaseX-20,y:ffBaseY,radius:24,hp:100,maxHp:100,alive:true,downed:false,input:{},sprinting:false,matchKills:0,matchAssists:0,matchDeaths:0,damageContrib:new Map(),brain:{targetId:null,burstLeft:0}};
  const deathVictim={id:'death-vic',nickname:'Victim',isBot:true,teamId:'bravo',x:ffBaseX+45,y:ffBaseY,radius:24,hp:35,maxHp:100,alive:true,downed:false,input:{},sprinting:false,matchKills:0,matchAssists:0,matchDeaths:0,damageContrib:new Map(),medicalId:'bandage',medicalCharges:3,stamina:100,maxStamina:100};
  players.set(deathAttacker.id,deathAttacker);players.set(deathHelper.id,deathHelper);players.set(deathVictim.id,deathVictim);
  applyDamage(deathHelper,deathVictim,10,ffNow-1000);deathVictim.hp=35;
  applyDamage(deathAttacker,deathVictim,60,ffNow);assert(deathVictim.downed&&!deathVictim.alive,'Lethal hit did not enter downed state');
  assert.strictEqual(deathAttacker.matchKills,1,'Downing did not award a kill immediately');assert.strictEqual(deathHelper.matchAssists,1,'Downing did not award the assist immediately');assert.strictEqual(deathVictim.matchDeaths,1,'Downing did not count a death immediately');
  completeRevive(deathAttacker,deathVictim,ffNow+7000,false);assert(deathVictim.alive&&!deathVictim.downed,'Revive did not restore victim');assert.strictEqual(deathAttacker.matchKills,1,'Revive incorrectly removed or duplicated the kill');assert.strictEqual(deathVictim.matchDeaths,1,'Revive incorrectly removed or duplicated the death');
  deathVictim.hp=35;applyDamage(deathAttacker,deathVictim,60,ffNow+8000);assert(deathVictim.downed,'Second lethal hit did not down victim');assert.strictEqual(deathAttacker.matchKills,2,'Second downing did not award a second kill');assert.strictEqual(deathVictim.matchDeaths,2,'Second downing did not count a second death');
  finalizeDeath(deathVictim,ffNow+13000,'test');assert.strictEqual(deathAttacker.matchKills,2,'Final death duplicated the kill');assert.strictEqual(deathVictim.matchDeaths,2,'Final death duplicated the death');
  assert.strictEqual(finalizeDeath(deathVictim,ffNow+13001,'duplicate'),false,'Death could be finalized twice');
  players.delete(deathAttacker.id);players.delete(deathHelper.id);players.delete(deathVictim.id);

  // Caisse de munitions : donne réellement des réserves et ne crée pas de munitions au-delà du maximum.
  const ammoOwner={id:'crate-owner-test',nickname:'Support',isBot:true,teamId:'charlie',x:ffBaseX,y:ffBaseY,radius:24,hp:100,maxHp:100,alive:true,weaponId:'rifle',reserveAmmo:120,reserveMax:120,medicalId:'bandage',medicalCharges:3};
  const ammoTarget={id:'crate-target-test',nickname:'Rifleman',isBot:true,teamId:'charlie',x:ffBaseX+30,y:ffBaseY,radius:24,hp:100,maxHp:100,alive:true,weaponId:'rifle',reserveAmmo:0,reserveMax:120,medicalId:'bandage',medicalCharges:3};
  players.set(ammoOwner.id,ammoOwner);players.set(ammoTarget.id,ammoTarget);
  ammoTarget.accessoryId='frag';ammoTarget.accessoryCharges=0;
  supplyCrates.push({id:'crate-test',type:'ammo',ownerId:ammoOwner.id,teamId:'charlie',x:ffBaseX,y:ffBaseY,radius:125,expiresAt:ffNow+45000,lastServe:new Map(),accessoryServed:new Set(),nextHeal:new Map()});updateSupplyCrates(ffNow);
  assert(ammoTarget.reserveAmmo>0&&ammoTarget.reserveAmmo<=ammoTarget.reserveMax,'Ammo crate did not resupply correctly');
  assert.strictEqual(ammoTarget.accessoryCharges,1,'Ammo crate did not restore accessory stock');
  ammoTarget.accessoryCharges=0;updateSupplyCrates(ffNow+6000);assert.strictEqual(ammoTarget.accessoryCharges,0,'Same ammo crate replenished accessory more than once');
  supplyCrates.push({id:'crate-test-2',type:'ammo',ownerId:ammoOwner.id,teamId:'charlie',x:ffBaseX,y:ffBaseY,radius:125,expiresAt:ffNow+45000,lastServe:new Map(),accessoryServed:new Set(),nextHeal:new Map()});updateSupplyCrates(ffNow+6001);
  assert.strictEqual(ammoTarget.accessoryCharges,1,'A different ammo crate could not replenish accessory stock');
  players.delete(ammoOwner.id);players.delete(ammoTarget.id);supplyCrates.splice(0,supplyCrates.length);

  // Navigation bots : ajoute temporairement un long mur dans une zone vide et vérifie qu'un bot le contourne.
  let testArea=null;
  for(let y=1800;y<MAP.height-1800&&!testArea;y+=900){
    for(let x=1800;x<MAP.width-1800;x+=900){
      const clear=!MAP.obstacles.some(o=>!(o.x+o.w<x-700||o.x>x+700||o.y+o.h<y-700||o.y>y+700));
      if(clear){testArea={x,y};break;}
    }
  }
  if(testArea){
    const navWall={x:testArea.x-45,y:testArea.y-360,w:90,h:720,height:70,kind:'wall'};MAP.obstacles.push(navWall);
    const now0=Date.now(),bot={id:'navtest',isBot:true,teamId:'alpha',x:testArea.x-420,y:testArea.y,vx:0,vy:0,radius:24,angle:0,hp:100,maxHp:100,alive:true,input:{up:false,down:false,left:false,right:false,sprint:false},aiming:false,sprinting:false,stamina:100,maxStamina:100,staminaRegenAt:0,weaponId:'rifle',ammo:25,reloadingUntil:0,lastShotAt:0,bloom:0,brain:{botMoveX:0,botMoveY:0,flankSide:1,separationBias:1,navWaypoint:null,navWaypointUntil:0,navObstacleKey:null,stuckCount:0,lastX:testArea.x-420,lastY:testArea.y,nextStuckCheck:now0+900}};
    const dest={x:testArea.x+420,y:testArea.y};
    for(let i=0;i<700&&Math.hypot(dest.x-bot.x,dest.y-bot.y)>70;i++){
      const now=now0+i*50;setBotMoveToward(bot,dest,null,now);const dx=bot.brain.botMoveX||0,dy=bot.brain.botMoveY||0,speed=255,dt=.05;
      const nx=bot.x+dx*speed*dt,ny=bot.y+dy*speed*dt;if(canStandAt(nx,bot.y,bot.radius))bot.x=nx;if(canStandAt(bot.x,ny,bot.radius))bot.y=ny;
    }
    MAP.obstacles.pop();
    assert(Math.hypot(dest.x-bot.x,dest.y-bot.y)<110,'bot navigation failed to route around test wall');
  }

  // Arsenal / outils / véhicules v1.5.
  assert(WEAPONS.shotgun.damage*5>=125,'Shotgun no longer has close-range one-shot potential against armor');
  assert(WEAPONS.dmr.tracer&&WEAPONS.bolt.tracer&&WEAPONS.heavybolt.tracer,'DMR/sniper tracer regression');
  assert(WEAPONS.bolt.fireRate<=0.40&&WEAPONS.heavybolt.fireRate<=0.28,'Bolt-action sniper fire-rate regression');
  assert(WEAPONS.pistol.range<=500&&WEAPONS.rifle.range<=720&&WEAPONS.heavybolt.range<=1450,'Weapon range nerf regression');
  assert.strictEqual(TOOLS.find(t=>t.id==='defib').cooldown,10000,'Defib cooldown regression');
  assert.strictEqual(ACCESSORIES.find(a=>a.id==='flash').maxCharges,2,'Flash stock regression');
  for(const teamId of TEAM_IDS){const fleet=vehicles.filter(v=>v.teamId===teamId);assert.strictEqual(fleet.length,6,`Expected 6 vehicles for ${teamId}`);assert.strictEqual(fleet.filter(v=>v.type==='quad').length,3,`Expected 3 quads for ${teamId}`);assert.strictEqual(fleet.filter(v=>v.type==='jeep').length,3,`Expected 3 jeeps for ${teamId}`);assert.strictEqual(fleet.filter(v=>v.pilotSlot!=null).length,2,`Expected 2 dedicated shuttle jeeps for ${teamId}`);}

  // Navigation véhicule : le chemin tient compte du gabarit élargi et contourne un vrai obstacle au lieu de forcer un interstice.
  let vehiclePathChecked=false;
  for(const o of MAP.obstacles){
    const clearance=VEHICLE_CONFIG.jeep.radius+42,cy=o.y+o.h/2,start={x:o.x-clearance-360,y:cy},dest={x:o.x+o.w+clearance+360,y:cy};
    if(start.x<clearance||dest.x>MAP.width-clearance||!canStandAt(start.x,start.y,clearance)||!canStandAt(dest.x,dest.y,clearance)||inEnemyBase('alpha',start.x,start.y,BASE_RADIUS+55)||inEnemyBase('alpha',dest.x,dest.y,BASE_RADIUS+55))continue;
    const tv={id:'veh-nav-test',type:'jeep',teamId:'alpha',x:start.x,y:start.y,radius:VEHICLE_CONFIG.jeep.radius,aiPath:null,aiPathIndex:0,aiNextPathAt:0,aiStuckCount:0};
    if(!segmentBlockingObstacle(start.x,start.y,dest.x,dest.y,vehicleNavClearance(tv)))continue;
    const path=findVehicleNavPath(tv,dest);if(!path?.length)continue;
    let a=start,safePath=true;for(const wp of path){if(!segmentClearForVehicle(tv,a.x,a.y,wp.x,wp.y)){safePath=false;break;}a=wp;}if(!safePath)continue;
    vehiclePathChecked=true;break;
  }
  assert(vehiclePathChecked,'No suitable vehicle navigation test obstacle found');

  // Un passager humain peut prendre le volant à une bots, mais jamais expulser un conducteur humain.
  const takeV=makeVehicle('quad','alpha',ffBaseX+650,ffBaseY+650,'takeover-test');
  const takeBot={id:'take-bot',nickname:'BotDriver',isBot:true,teamId:'alpha',x:takeV.x,y:takeV.y,radius:24,hp:100,maxHp:100,alive:true,input:{sprint:false},brain:{vehicleDriveX:0,vehicleDriveY:0,wantedVehicleId:null}};
  const takeHuman={id:'take-human',nickname:'Human',isBot:false,teamId:'alpha',x:takeV.x,y:takeV.y,radius:24,hp:100,maxHp:100,alive:true,input:{sprint:false},aiming:false};
  const takeHuman2={id:'take-human2',nickname:'Human2',isBot:false,teamId:'alpha',x:takeV.x,y:takeV.y,radius:24,hp:100,maxHp:100,alive:true,input:{sprint:false},aiming:false};
  players.set(takeBot.id,takeBot);players.set(takeHuman.id,takeHuman);players.set(takeHuman2.id,takeHuman2);vehicles.push(takeV);
  assert(enterVehicle(takeBot,takeV,false,ffNow),'bot driver could not enter takeover test vehicle');assert(enterVehicle(takeHuman,takeV,true,ffNow),'Human passenger could not enter takeover test vehicle');
  assert(passengerTakeDriverSeat(takeHuman,ffNow+100),'Human passenger could not take wheel from bot');assert.strictEqual(takeV.driverId,takeHuman.id);assert.strictEqual(takeBot.vehicleId,null);
  assert(enterVehicle(takeHuman2,takeV,true,ffNow+200),'Second human could not enter as passenger');assert.strictEqual(passengerTakeDriverSeat(takeHuman2,ffNow+300),false,'Passenger incorrectly expelled a human driver');assert.strictEqual(takeV.driverId,takeHuman.id);
  players.delete(takeBot.id);players.delete(takeHuman.id);players.delete(takeHuman2.id);vehicles.splice(vehicles.indexOf(takeV),1);

  // Équilibrage bots : aucun élément de loadout ne doit dépasser le niveau simulé.
  const aiLoadoutTest={id:'loadout-test',isBot:true,botPersonality:'support',alive:true,hp:100,maxHp:100,weaponId:'pistol',equipmentIds:[],accessoryId:'frag',accessoryCharges:1,toolId:'ammocrate',toolReadyAt:0,medicalId:'bandage',medicalCharges:3,ammo:15,reserveAmmo:60,reserveMax:60,reloadingUntil:0,lastShotAt:0,bloom:0};
  for(const lvl of [1,4,7,13]){
    applyBotLevelLoadout(aiLoadoutTest,lvl,true);
    assert(WEAPONS[aiLoadoutTest.weaponId].level<=lvl,'bot weapon above player-equivalent level');
    assert(aiLoadoutTest.equipmentIds.every(id=>(EQUIPMENT.find(e=>e.id===id)?.level||99)<=lvl),'bot equipment above player-equivalent level');
    assert((ACCESSORIES.find(a=>a.id===aiLoadoutTest.accessoryId)?.level||99)<=lvl,'bot accessory above player-equivalent level');
    assert((TOOLS.find(t=>t.id===aiLoadoutTest.toolId)?.level||99)<=lvl,'bot tool above player-equivalent level');
    assert((MEDICAL_ITEMS.find(m=>m.id===aiLoadoutTest.medicalId)?.level||99)<=lvl,'bot medical item above player-equivalent level');
  }
  // Hitbox joueur légèrement plus généreuse que le sprite central et navigation : un passage plus étroit que 2x le rayon bots est considéré impraticable.
  assert(rayCircleDistance(0,0,1,0,200,26,27)<Infinity,'Player hitbox regression');
  const narrowGapLeft={x:-90,y:-120,w:60,h:240},narrowGapRight={x:30,y:-120,w:60,h:240};
  assert(circleRectCollision(0,0,NAV_CLEARANCE,narrowGapLeft)||circleRectCollision(0,0,NAV_CLEARANCE,narrowGapRight),'bot clearance no longer rejects too-narrow gaps');
  assert(match.objective.radius===950,'Control point radius regression');assert(match.scoreLimit===100,'Point Control score limit regression');assert(WAR_ZONE.radius===12500,'War zone radius regression');

  // XP : tout gain positif est doublé si le joueur se trouve dans la zone au moment exact du gain ; les pénalités restent inchangées.
  const xpKey='__v16_xp_test__',xpProfile={nickname:'XPTest',xp:500,kills:0,assists:0,deaths:0,createdAt:new Date().toISOString(),lastSeenAt:new Date().toISOString(),loadout:{weaponId:'pistol',equipmentIds:[],accessoryId:'none',toolId:'none',medicalId:'bandage'}};
  profiles[xpKey]=xpProfile;const xpWs={readyState:WebSocket.OPEN,send(){}};const xpTester={id:'xp-test',nickname:'XPTest',isBot:false,profileKey:xpKey,ws:xpWs,teamId:'alpha',alive:true,x:match.objective.x,y:match.objective.y,weaponId:'pistol',equipmentIds:[],accessoryId:'none',toolId:'none',medicalId:'bandage'};
  awardXp(xpTester,10,'TEST');assert.strictEqual(xpProfile.xp,520,'XP inside zone was not doubled');xpTester.x=match.objective.x+match.objective.radius+50;awardXp(xpTester,10,'TEST');assert.strictEqual(xpProfile.xp,530,'XP outside zone was incorrectly doubled');xpTester.x=match.objective.x;awardXp(xpTester,-100,'TEAMKILL');assert.strictEqual(xpProfile.xp,430,'Negative XP penalty was incorrectly doubled');delete profiles[xpKey];
  // Sécurité gameplay : aucun occupant de véhicule (conducteur ou passager) ne peut utiliser arme, outil ou accessoire.
  const vehLock=makeVehicle('quad','alpha',ffBaseX+900,ffBaseY+900,'vehicle-lock-test');vehicles.push(vehLock);
  const locked={id:'vehicle-lock-player',nickname:'Locked',isBot:true,teamId:'alpha',x:vehLock.x,y:vehLock.y,radius:24,hitRadius:27,hp:100,maxHp:100,alive:true,sprinting:false,vehicleId:null,vehicleSeat:null,weaponId:'pistol',ammo:15,reserveAmmo:60,reserveMax:60,reloadingUntil:0,lastShotAt:0,bloom:0,angle:0,equipmentIds:[],accessoryId:'frag',accessoryCharges:1,toolId:'ammocrate',toolReadyAt:0,medicalId:'bandage',medicalCharges:3,input:{},brain:{}};
  players.set(locked.id,locked);assert(enterVehicle(locked,vehLock,true,ffNow),'Vehicle lock test passenger failed to enter');
  const ammoBefore=locked.ammo,accessoryBefore=locked.accessoryCharges,crateBefore=supplyCrates.length;
  assert.strictEqual(tryFire(locked,ffNow+5000),false,'Passenger fired a weapon from a vehicle');assert.strictEqual(locked.ammo,ammoBefore,'Passenger weapon consumed ammo');
  assert.strictEqual(startReload(locked,ffNow+5000),false,'Passenger started reload in a vehicle');
  assert.strictEqual(useAccessory(locked,ffNow+5000),false,'Passenger used accessory in a vehicle');assert.strictEqual(locked.accessoryCharges,accessoryBefore,'Passenger accessory charge changed');
  assert.strictEqual(useTool(locked,ffNow+5000),false,'Passenger used tool in a vehicle');assert.strictEqual(supplyCrates.length,crateBefore,'Passenger placed a supply crate from a vehicle');
  leaveVehicle(locked);players.delete(locked.id);vehicles.splice(vehicles.indexOf(vehLock),1);

  // v2.1 : le contrôle global utilise le poids de présence, et une égalité ne donne aucun leader.
  const wcUnique=warControlState({alpha:8,bravo:5,charlie:2},ffNow+5000);assert.strictEqual(wcUnique.leader,'alpha','War-zone leader detection failed');assert.strictEqual(wcUnique.tied,false,'Unique war-zone lead marked as tie');
  const wcTie=warControlState({alpha:7,bravo:7,charlie:3},ffNow+5000);assert.strictEqual(wcTie.leader,null,'Tie incorrectly produced a scoring team');assert.strictEqual(wcTie.tied,true,'Tie state was not exposed');

  // Hors de la zone de guerre, sans transport immédiat, une bots attend à la base au lieu de partir à pied.
  const waitBot=makeBot('alpha');waitBot.pilotRole=false;waitBot.x=TEAMS.alpha.spawn[0];waitBot.y=TEAMS.alpha.spawn[1];waitBot.brain.botMoveX=1;waitBot.brain.botMoveY=1;waitBot.brain.vehicleWaitUntil=ffNow+10000;
  assert.strictEqual(botVehicleBehavior(waitBot,ffNow),true,'Bot did not stay in transport-wait mode outside war zone');const waitPoint=botBaseWaitingPoint(waitBot);assert(inTeamBase('alpha',waitPoint.x,waitPoint.y,BASE_RADIUS*.9),'Bot waiting point escaped the team base');assert.strictEqual(waitBot.brain.wantedVehicleId,null,'Bot kept a stale vehicle reservation while waiting');

  // Une descente de véhicule au front doit laisser l'bots franchement dans la zone et nettoyer son ancien chemin.
  const dv=makeVehicle('quad','alpha',WAR_ZONE.x-WAR_ZONE.radius+520,WAR_ZONE.y,'disembark-test');vehicles.push(dv);
  const db=makeBot('alpha');db.id='disembark-bot-test';db.x=dv.x;db.y=dv.y;db.vehicleId=dv.id;db.vehicleSeat='driver';db.brain.navPath=[{x:1,y:1}];dv.driverId=db.id;players.set(db.id,db);
  disembarkBotInsideWar(db,dv,ffNow);assert(!db.vehicleId,'Disembarking bot remained attached to vehicle');assert(insideWarZoneXY(db.x,db.y,-60),'Disembarking bot was placed outside war zone');assert.strictEqual(db.brain.navPath,null,'Old navigation path survived vehicle disembark');
  players.delete(db.id);vehicles.splice(vehicles.indexOf(dv),1);

  // Navette dédiée : elle reste à la base tant que toutes les places passager ne sont pas réellement occupées.
  const oldPrepUntil=match.prepUntil;match.prepUntil=ffNow-1000;
  const shuttle=makeVehicle('jeep','alpha',TEAMS.alpha.spawn[0],TEAMS.alpha.spawn[1],'shuttle-full-test',99);vehicles.push(shuttle);
  const pilot=makeBot('alpha');pilot.id='pilot-full-test';pilot.pilotRole=true;pilot.pilotSlot=99;pilot.x=shuttle.x;pilot.y=shuttle.y;players.set(pilot.id,pilot);assert(enterVehicle(pilot,shuttle,false,ffNow),'Pilot could not enter shuttle test jeep');shuttle.shuttleState='base';shuttle.shuttleDepartAt=0;
  pilotVehicleBehavior(pilot,ffNow+100);assert.strictEqual(shuttle.shuttleDepartAt,0,'Pilot started departure countdown before shuttle was full');
  const shuttlePassengers=[];for(let i=0;i<shuttle.passengerCapacity;i++){const q=makeBot('alpha');q.id=`shuttle-pass-${i}`;q.pilotRole=false;q.x=shuttle.x;q.y=shuttle.y;players.set(q.id,q);assert(enterVehicle(q,shuttle,true,ffNow+200+i),'Shuttle test passenger could not board');shuttlePassengers.push(q);}
  pilotVehicleBehavior(pilot,ffNow+500);assert(shuttle.shuttleDepartAt>ffNow+500,'Full shuttle did not start departure countdown');
  for(const q of shuttlePassengers)players.delete(q.id);players.delete(pilot.id);vehicles.splice(vehicles.indexOf(shuttle),1);match.prepUntil=oldPrepUntil;

  // Embarquement bots : chaque passager obtient une porte/position différente et peut monter
  // sans devoir atteindre le centre exact de la jeep. C'est le cas qui causait les bouchons base.
  const boardV=makeVehicle('jeep','alpha',TEAMS.alpha.spawn[0]+120,TEAMS.alpha.spawn[1]+90,'boarding-flow-test',77);vehicles.push(boardV);
  const boardPilot=makeBot('alpha');boardPilot.id='boarding-pilot';boardPilot.pilotRole=true;boardPilot.pilotSlot=77;boardPilot.x=boardV.x;boardPilot.y=boardV.y;players.set(boardPilot.id,boardPilot);assert(enterVehicle(boardPilot,boardV,false,ffNow),'Boarding-flow pilot failed to enter');
  const boardingBots=[],boardingSeats=new Set(),boardingPoints=[];
  for(let i=0;i<4;i++){
    const q=makeBot('alpha');q.id=`boarding-pass-${i}`;q.pilotRole=false;players.set(q.id,q);assert(reservePassenger(q,boardV,ffNow+i),'Could not reserve shuttle passenger');
    const seat=boardV.reservedPassengerSeats[q.id];assert(seat&&!boardingSeats.has(seat),'Two bots received the same reserved jeep seat');boardingSeats.add(seat);
    const bp=vehicleBoardingPoint(boardV,q,'passenger');boardingPoints.push(bp);q.x=bp.x;q.y=bp.y;q.brain.passengerWaitSince=ffNow-200;
    assert(approachReservedVehicle(q,validBotVehicleReservation(q),ffNow+300+i),'Reserved bot did not process boarding');assert.strictEqual(q.vehicleId,boardV.id,'Bot reached its boarding door but did not enter');boardingBots.push(q);
  }
  for(let i=0;i<boardingPoints.length;i++)for(let j=i+1;j<boardingPoints.length;j++)assert(Math.hypot(boardingPoints[i].x-boardingPoints[j].x,boardingPoints[i].y-boardingPoints[j].y)>35,'Two jeep boarding points overlap and can recreate a traffic jam');
  assert.strictEqual(boardV.passengerIds.length,4,'Shuttle did not fill after four independent boarding paths');
  for(const q of boardingBots)players.delete(q.id);players.delete(boardPilot.id);vehicles.splice(vehicles.indexOf(boardV),1);

  // Réparation automatique à la base.
  const repairV=makeVehicle('quad','alpha',TEAMS.alpha.spawn[0]+80,TEAMS.alpha.spawn[1]+80,'repair-test');repairV.hp=80;repairV.lastDamagedAt=ffNow-5000;vehicles.push(repairV);const hpRepairBefore=repairV.hp;updateVehicles(.5,ffNow);assert(repairV.hp>hpRepairBefore,'Vehicle did not repair inside its own base');vehicles.splice(vehicles.indexOf(repairV),1);

  // Escouades humaines : rejoindre / quitter sans modifier l'équipe.
  const squadHuman={id:'squad-human',nickname:'Squad',isBot:false,teamId:'alpha',squadId:null,ws:null};assert(handleSquadAction(squadHuman,{action:'join',squadId:'squad2'}),'Squad join rejected');assert.strictEqual(squadHuman.squadId,'squad2');assert(handleSquadAction(squadHuman,{action:'leave'}),'Squad leave rejected');assert.strictEqual(squadHuman.squadId,null);

  // Rechargement : toutes les armes doivent émettre un chargeur tombant ; le client masque le chargeur porté tant que reloadingMs > 0.
  for(const wid of Object.keys(WEAPONS)){
    const rw=WEAPONS[wid],rp={id:`reload-${wid}`,nickname:'ReloadTest',isBot:true,teamId:'alpha',x:ffBaseX+1100,y:ffBaseY+1100,radius:24,hitRadius:27,hp:100,maxHp:100,alive:true,sprinting:false,vehicleId:null,weaponId:wid,ammo:Math.max(0,rw.mag-1),reserveAmmo:rw.mag*2,reserveMax:rw.mag*4,reloadingUntil:0,lastShotAt:0,bloom:0,angle:0,equipmentIds:[],medicalUseUntil:0,medicalTargetId:null,reviveTargetId:null,input:{},brain:{}};
    const beforeEffects=effects.length;assert(startReload(rp,ffNow+7000),`Reload did not start for ${wid}`);
    const magFx=effects.slice(beforeEffects).find(e=>e.type==='mag'&&e.weaponId===wid);assert(magFx,`No magazine drop event for ${wid}`);assert(rp.reloadingUntil>ffNow+7000,`Reload duration missing for ${wid}`);
  }

  console.log('ProjectPC v2.6 self-test: OK (murs, hitbox, arsenal, tracers, tir allié, outils, véhicules, bases, soins, réanimation, économie, zone de guerre, point de contrôle, navigation).');
}
if(process.env.PROJECTPC_VERIFY_GEOMETRY==='1'||process.env.ISOFRONT_VERIFY_GEOMETRY==='1'){runGeometrySelfTests();if(process.env.PROJECTPC_VERIFY_ONLY==='1')process.exit(0);}

let snapshotAccumulator=0;
rebuildActorIndex();
const stopMainLoop=startFixedLoop({
  hz:SIM_HZ,
  maxCatchUpSteps:2,
  onMetrics:m=>{perfStats.avgTickCostMs=Math.round(m.avgTickCostMs*100)/100;perfStats.avgLoopLagMs=Math.round(m.avgLagMs*100)/100;perfStats.maxLoopLagMs=Math.round(m.maxLagMs*100)/100;},
  onTick:(dt,now)=>{
    // Les décisions bots utilisent l'index construit à la fin du tick précédent (au plus 33 ms ancien).
    // Cela évite de reconstruire deux fois le même index par tick.
    rebalanceBots(now);
    for(const p of players.values()){
      finishReloadIfNeeded(p,now);finishMedicalUseIfNeeded(p,now);finishReviveIfNeeded(p,now);updateStatusEffects(p,now);
      if(!p.alive){
        const reviveState=p.downed?reviveStateFor(p,now):null;
        if(p.downed&&reviveState){
          p.bleedoutAt=Math.max(p.bleedoutAt||0,now+1200);if(p.isBot)p.giveUpAt=Math.max(p.giveUpAt||0,now+1200);
        }else if(p.isBot&&p.downed&&((p.bleedoutAt&&now>=p.bleedoutAt)||(p.giveUpAt&&now>=p.giveUpAt))){finalizeDeath(p,now,p.bleedoutAt&&now>=p.bleedoutAt?'bleedout':'bot_giveup');respawn(p,now);}
        else if(!p.downed&&p.respawnAt&&now>=p.respawnAt)respawn(p,now);
      }
      if(p.isBot){
        const brain=p.brain||(p.brain={});
        if(!brain.nextAiAt)brain.nextAiAt=now+Math.random()*(1000/AI_HZ);
        if(now>=brain.nextAiAt){const aiDt=Math.min(.1,(now-(brain.lastAiAt||now-1000/AI_HZ))/1000);brain.lastAiAt=now;brain.nextAiAt=now+1000/AI_HZ;updateBot(p,aiDt,now);}
      }
      integratePlayer(p,dt,now);
    }
    updateVehicles(dt,now);updateGrenades(dt,now);updateRockets(dt,now);updateMines(now);updateSupplyCrates(now);updateObjective(now);
    // Positions à jour pour snapshots/radar.
    rebuildActorIndex(now);
    updateTeamSpots(now);if(match.winner&&match.resetAt&&now>=match.resetAt)resetRound(now);
    while(shots.length&&now-shots[0].at>320)shots.shift();while(effects.length&&now-effects[0].at>7000)effects.shift();
    snapshotAccumulator+=dt;if(snapshotAccumulator>=1/SNAPSHOT_HZ){snapshotAccumulator%=1/SNAPSHOT_HZ;for(const[ws,viewer]of clients)if(ws.readyState===WebSocket.OPEN)sendSnapshotTo(ws,viewer,now);}
  }
});

const leaderboardTimer=setInterval(()=>{
  const list=[...players.values()].map(p=>({id:p.id,nickname:p.nickname,isBot:p.isBot,teamId:p.teamId,kills:p.matchKills||0,assists:p.matchAssists||0,deaths:p.matchDeaths||0,level:playerLevel(p),moneyNet:p.matchMoneyNet||0,godMode:!!p.godMode,squadId:p.squadId||null})).sort((a,b)=>b.moneyNet-a.moneyNet||b.kills-a.kills||b.assists-a.assists||a.deaths-b.deaths);
  broadcast('leaderboard',{players:list,match:matchPublic(Date.now())});
},1800);leaderboardTimer.unref?.();

server.listen(PORT,HOST,()=>{
  console.log('');console.log('============================================================');console.log(' ProjectPC v2.6 - POINT CONTROL');
  console.log(' Code administrateur (privé, ne jamais partager) : '+ADMIN_TOKEN);
  console.log(` Local : http://localhost:${PORT}`);console.log(` Santé : http://localhost:${PORT}/health`);console.log(' Tunnel: cloudflared tunnel --url http://localhost:'+PORT);
  console.log(` Carte : ${MAP.width} x ${MAP.height} (${MAP.obstacles.length} obstacles)`);console.log(` Équipes: ${TEAM_TARGET_SIZE} combattants par équipe · jusqu’à ${MAX_HUMANS_PER_TEAM} joueurs humains + ${PILOTS_PER_TEAM} navettes`);console.log('============================================================');console.log('');
});
function shutdown(){try{stopMainLoop?.();clearInterval(wsHeartbeat);clearInterval(leaderboardTimer);}catch{}profileStore.flushSync(profiles);process.exit(0);}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
