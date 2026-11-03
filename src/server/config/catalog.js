'use strict';

const WEAPONS = {
  pistol: { id:'pistol', name:'Pistolet 9 mm', category:'pistol', level:1, damage:30, fireRate:4.0, range:500, mag:15, reload:2.0, pellets:1, automatic:false, hipSpread:0.052, aimSpread:0.015, moveSpread:0.018, bloomPerShot:0, maxBloom:0, bloomRecovery:0.20, tracer:false, muzzleVelocity:3800 },
  smg: { id:'smg', name:'PM compact 9 mm', category:'smg', level:2, damage:17, fireRate:10.5, range:430, mag:30, reload:2.0, pellets:1, automatic:true, hipSpread:0.084, aimSpread:0.029, moveSpread:0.022, bloomPerShot:0.012, maxBloom:0.115, bloomRecovery:0.105, tracer:false, muzzleVelocity:4300 },
  mp5: { id:'mp5', name:'PM 9 mm intégral', category:'smg', level:3, damage:18, fireRate:13.0, range:470, mag:30, reload:2.0, pellets:1, automatic:true, hipSpread:0.078, aimSpread:0.024, moveSpread:0.021, bloomPerShot:0.011, maxBloom:0.105, bloomRecovery:0.115, tracer:false, muzzleVelocity:4500 },
  carbine: { id:'carbine', name:'Carabine d’assaut 5.56', category:'assault', level:3, damage:22, fireRate:9.0, range:650, mag:30, reload:2.0, pellets:1, automatic:true, hipSpread:0.062, aimSpread:0.014, moveSpread:0.019, bloomPerShot:0.012, maxBloom:0.092, bloomRecovery:0.12, tracer:false, muzzleVelocity:7600 },
  rifle: { id:'rifle', name:'Fusil d’assaut 5.56', category:'assault', level:4, damage:25, fireRate:7.4, range:720, mag:30, reload:2.0, pellets:1, automatic:true, hipSpread:0.064, aimSpread:0.013, moveSpread:0.020, bloomPerShot:0.014, maxBloom:0.095, bloomRecovery:0.115, tracer:false, muzzleVelocity:7900 },
  akm: { id:'akm', name:'Fusil d’assaut 7.62', category:'assault', level:5, damage:31, fireRate:6.2, range:680, mag:30, reload:2.0, pellets:1, automatic:true, hipSpread:0.074, aimSpread:0.017, moveSpread:0.023, bloomPerShot:0.017, maxBloom:0.12, bloomRecovery:0.10, tracer:false, muzzleVelocity:7000 },
  shotgun: { id:'shotgun', name:'Fusil à pompe', category:'shotgun', level:5, damage:28, fireRate:1.25, range:300, mag:8, reload:2.0, pellets:8, automatic:false, hipSpread:0.160, aimSpread:0.090, moveSpread:0.018, bloomPerShot:0, maxBloom:0, bloomRecovery:0.20, tracer:false, muzzleVelocity:3300 },
  vector: { id:'vector', name:'PM haute cadence .45', category:'smg', level:6, damage:20, fireRate:16.0, range:410, mag:25, reload:2.0, pellets:1, automatic:true, hipSpread:0.090, aimSpread:0.032, moveSpread:0.024, bloomPerShot:0.014, maxBloom:0.135, bloomRecovery:0.13, tracer:false, muzzleVelocity:4000 },
  semi556: { id:'semi556', name:'Carabine semi-auto 5.56', category:'semi', level:6, damage:36, fireRate:4.2, range:780, mag:20, reload:2.0, pellets:1, automatic:false, hipSpread:0.056, aimSpread:0.010, moveSpread:0.021, bloomPerShot:0, maxBloom:0, bloomRecovery:0.20, tracer:false, muzzleVelocity:7900 },
  semi762: { id:'semi762', name:'Fusil semi-auto 7.62', category:'semi', level:7, damage:46, fireRate:3.0, range:860, mag:20, reload:2.0, pellets:1, automatic:false, hipSpread:0.052, aimSpread:0.008, moveSpread:0.024, bloomPerShot:0, maxBloom:0, bloomRecovery:0.20, tracer:false, muzzleVelocity:8200 },
  dmr: { id:'dmr', name:'DMR 7.62', category:'dmr', level:8, damage:58, fireRate:2.3, range:1020, mag:12, reload:2.0, pellets:1, automatic:false, hipSpread:0.045, aimSpread:0.0055, moveSpread:0.022, bloomPerShot:0, maxBloom:0, bloomRecovery:0.20, tracer:true, muzzleVelocity:8600 },
  bolt: { id:'bolt', name:'Fusil à verrou .308', category:'sniper', level:10, damage:102, fireRate:0.40, range:1250, mag:5, reload:2.0, pellets:1, automatic:false, hipSpread:0.075, aimSpread:0.0032, moveSpread:0.032, bloomPerShot:0, maxBloom:0, bloomRecovery:0.20, tracer:true, muzzleVelocity:8900 },
  heavybolt: { id:'heavybolt', name:'Fusil à verrou Magnum', category:'sniper', level:13, damage:128, fireRate:0.28, range:1450, mag:5, reload:2.0, pellets:1, automatic:false, hipSpread:0.092, aimSpread:0.0025, moveSpread:0.038, bloomPerShot:0, maxBloom:0, bloomRecovery:0.20, tracer:true, muzzleVelocity:9400 }
};

const EQUIPMENT = [
  { id:'armor', name:'Plaque balistique', level:4, description:'+25 PV maximum en permanence.' },
  { id:'fastreload', name:'Chargeur tactique', level:6, description:'Rechargement 20 % plus rapide.' }
];

const MEDICAL_ITEMS = [
  { id:'bandage', name:'Bandage', level:1, heal:35, useTime:2600, maxCharges:3, description:'3 bandages sont nécessaires pour récupérer presque toute une barre de vie.' },
  { id:'fielddressing', name:'Pansement compressif', level:4, heal:58, useTime:1950, maxCharges:3, description:'Soin rapide et efficace.' },
  { id:'ifak', name:'IFAK', level:7, heal:82, useTime:1350, maxCharges:3, description:'Kit individuel très performant.' },
  { id:'traumakit', name:'Kit trauma', level:11, heal:110, useTime:950, maxCharges:4, description:'Soin haut niveau extrêmement efficace.' }
];

const TOOLS = [
  { id:'none', name:'Aucun outil', level:1, description:'Aucun outil équipé.', cooldown:0 },
  { id:'ammocrate', name:'Caisse de munitions', level:3, description:'A/Q : pose une zone de ravitaillement. Rend munitions et 1 recharge d’accessoire par caisse.', cooldown:18000, radius:155, lifetime:45000 },
  { id:'medcrate', name:'Caisse de soins', level:4, description:'A/Q : pose une zone médicale. Rend des soins et soigne lentement les alliés présents.', cooldown:19000, radius:155, lifetime:45000 },
  { id:'healstim', name:'Seringue de soins', level:5, description:'A/Q : régénère progressivement 45 PV pendant 15 s.', cooldown:16000, duration:15000 },
  { id:'stamstim', name:'Seringue d’endurance', level:7, description:'A/Q : endurance illimitée pendant 15 s.', cooldown:17000, duration:15000 },
  { id:'defib', name:'Défibrillateur', level:9, description:'Réanimation rapide avec F sur un allié au sol.', cooldown:10000 }
];

const ACCESSORIES = [
  { id:'none', name:'Aucun accessoire', level:1, description:'Aucun accessoire équipé.', maxCharges:0 },
  { id:'frag', name:'Grenade à fragmentation', level:2, description:'G : grenade explosive. Une charge.', maxCharges:1, fuse:2800, radius:230 },
  { id:'flash', name:'Grenade flash', level:3, description:'G : aveugle pendant 2 s. Deux charges.', maxCharges:2, fuse:2200, radius:430 },
  { id:'rocket', name:'Lance-roquette', level:6, description:'G : roquette explosive à impact. Une charge.', maxCharges:1, radius:270, range:1500, speed:720 },
  { id:'proximity', name:'Mine de proximité', level:8, description:'G : mine armée après 1,2 s. Une charge.', maxCharges:1, radius:235, triggerRadius:92, lifetime:120000 }
];


function catalogLicenseCost(kind,item){
  if(!item||item.id==='none'||item.id==='pistol'||item.id==='bandage')return 0;
  const lv=Math.max(1,item.level||1);
  // v2.1 : licences nettement moins chères ; le prix par vie reste une petite fraction de la licence.
  const base={weapon:3000,equipment:2700,medical:2100,tool:2600,accessory:2400}[kind]||2400;
  if(kind==='weapon'&&item.id==='smg')return 5000;
  return Math.round((base+lv*950+(kind==='weapon'?lv*220:0))/250)*250;
}
function decorateCatalog(kind,list){
  for(const item of list){item.licenseCost=catalogLicenseCost(kind,item);item.lifeCost=item.licenseCost?Math.max(250,Math.round(item.licenseCost*.10/50)*50):0;}
}
decorateCatalog('weapon',Object.values(WEAPONS));decorateCatalog('equipment',EQUIPMENT);decorateCatalog('medical',MEDICAL_ITEMS);decorateCatalog('tool',TOOLS);decorateCatalog('accessory',ACCESSORIES);

const BOT_PERSONALITIES = {
  assault:  { label:'Assaut', aggression:0.84, flank:0.28, retreat:0.20, aimError:0.115, reaction:[440,720], burst:[3,8], preferred:'rifle', coordination:.20, objectiveRing:[.05,.62] },
  tactical: { label:'Tactique', aggression:0.60, flank:0.70, retreat:0.37, aimError:0.098, reaction:[500,790], burst:[3,6], preferred:'rifle', coordination:.72, objectiveRing:[.55,1.10] },
  cautious: { label:'Prudent', aggression:0.36, flank:0.44, retreat:0.68, aimError:0.105, reaction:[570,920], burst:[1,4], preferred:'dmr', coordination:.28, objectiveRing:[1.20,2.05] },
  support:  { label:'Soutien', aggression:0.46, flank:0.24, retreat:0.48, aimError:0.128, reaction:[550,900], burst:[3,6], preferred:'smg', coordination:.86, objectiveRing:[.75,1.25] },
  flanker:  { label:'Flanqueur', aggression:0.67, flank:0.92, retreat:0.31, aimError:0.140, reaction:[500,830], burst:[3,7], preferred:'smg', coordination:.12, objectiveRing:[1.25,2.10] },
  rookie:   { label:'Volontaire', aggression:0.55, flank:0.24, retreat:0.37, aimError:0.175, reaction:[680,1080], burst:[3,7], preferred:'rifle', coordination:.62, objectiveRing:[.35,.95] },
  marksman: { label:'Tireur', aggression:0.40, flank:0.48, retreat:0.55, aimError:0.082, reaction:[620,990], burst:[1,2], preferred:'dmr', coordination:.22, objectiveRing:[1.75,2.80] },
  breacher:  { label:'Percée', aggression:0.90, flank:0.52, retreat:0.18, aimError:0.145, reaction:[430,760], burst:[2,5], preferred:'shotgun', coordination:.35, objectiveRing:[.05,.55] },
  medic:     { label:'Secours', aggression:0.34, flank:0.32, retreat:0.58, aimError:0.155, reaction:[650,1080], burst:[2,5], preferred:'smg', coordination:.94, objectiveRing:[.55,1.10] },
  scout:     { label:'Éclaireur', aggression:0.58, flank:0.96, retreat:0.34, aimError:0.135, reaction:[520,880], burst:[2,5], preferred:'smg', coordination:.18, objectiveRing:[1.2,2.3] },
  sentinel:  { label:'Défense', aggression:0.43, flank:0.18, retreat:0.44, aimError:0.108, reaction:[560,940], burst:[2,5], preferred:'semi', coordination:.68, objectiveRing:[.2,.82] }
};

module.exports={WEAPONS,EQUIPMENT,MEDICAL_ITEMS,TOOLS,ACCESSORIES,BOT_PERSONALITIES};
