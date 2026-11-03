'use strict';

const { spawn } = require('child_process');
const path = require('path');
const root = path.resolve(__dirname, '..');
const port = Number(process.env.STRESS_PORT || 8099);
const count = Math.max(1, Math.min(60, Number(process.env.STRESS_CLIENTS || 12)));
const durationMs = Math.max(3000, Number(process.env.STRESS_MS || 10000));

const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT:String(port), HOST:'127.0.0.1' },
  stdio: ['ignore','pipe','pipe']
});
server.stdout.on('data',()=>{}); server.stderr.on('data',d=>process.stderr.write(d));

const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function waitHealth(){for(let i=0;i<40;i++){try{const r=await fetch(`http://127.0.0.1:${port}/health`);if(r.ok)return;}catch{}await sleep(150);}throw new Error('server health timeout');}

(async()=>{
  try{
    await waitHealth();
    let bytes=0,messages=0,opened=0;
    const sockets=[];
    for(let i=0;i<count;i++){
      const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`);sockets.push(ws);
      ws.addEventListener('open',()=>{opened++;ws.send(JSON.stringify({type:'hello',token:(i+1).toString(16).padStart(64,'0'),nickname:`Stress${i}`,teamId:['alpha','bravo','charlie'][i%3]}));});
      ws.addEventListener('message',e=>{messages++;bytes+=typeof e.data==='string'?Buffer.byteLength(e.data):e.data.byteLength||0;});
    }
    await sleep(1000);
    const inputTimer=setInterval(()=>{const t=Date.now()/1000;for(let i=0;i<sockets.length;i++){const ws=sockets[i];if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'input',keys:{up:i%2===0,down:false,left:false,right:i%3===0,sprint:i%4===0},angle:(t+i)%6.283,aiming:i%3===1}));}},50);
    await sleep(durationMs);
    clearInterval(inputTimer);
    const health=await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    for(const ws of sockets)try{ws.close();}catch{}
    console.log(JSON.stringify({clientsRequested:count,opened,durationMs,messages,bytes,bytesPerSecond:Math.round(bytes/(durationMs/1000)),health},null,2));
  }finally{
    server.kill('SIGTERM');
    setTimeout(()=>{try{server.kill('SIGKILL');}catch{}},1000).unref?.();
  }
})().catch(e=>{console.error(e);server.kill('SIGTERM');process.exit(1);});
