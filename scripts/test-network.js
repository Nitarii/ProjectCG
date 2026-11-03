'use strict';
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {WebSocket:SimpleWebSocket,WebSocketServer}=require('../src/server/net/simple-ws');
class Socket extends EventEmitter{
 constructor(){super();this.writes=[];this.writableLength=0;this.destroyed=false;}
 write(b){this.writes.push(Buffer.from(b));return true;}
 end(){this.destroyed=true;}destroy(){this.destroyed=true;}
 setNoDelay(){}setKeepAlive(){}
}
function frame(op,payload=Buffer.alloc(0),fin=true){
 const mask=Buffer.from([1,2,3,4]),data=Buffer.from(payload);
 if(data.length>125)throw Error('invalid test frame size');
 const head=Buffer.from([(fin?128:0)|op,128|data.length]);
 for(let i=0;i<data.length;i++)data[i]^=mask[i%4];
 return Buffer.concat([head,mask,data]);
}
function fresh(){const socket=new Socket(),ws=new SimpleWebSocket(socket);ws.on('error',()=>{});return{socket,ws};}
{
 const {socket,ws}=fresh(),messages=[];ws.on('message',b=>messages.push(b.toString()));
 socket.emit('data',frame(1,Buffer.from('hel'),false));socket.emit('data',frame(0,Buffer.from('lo')));
 assert.deepEqual(messages,['hello']);assert.equal(ws.readyState,SimpleWebSocket.OPEN);
}
{
 const {socket,ws}=fresh();socket.emit('data',frame(2,Buffer.from('bad')));
 assert.equal(ws.readyState,SimpleWebSocket.CLOSING);
}
{
 const {socket,ws}=fresh();socket.emit('data',frame(1,Buffer.from('first'),false));
 socket.emit('data',frame(1,Buffer.from('second')));
 assert.equal(ws.readyState,SimpleWebSocket.CLOSING);
}
{
 const {socket,ws}=fresh();const control=frame(9,Buffer.from('p'),false);
 socket.emit('data',control);assert.equal(ws.readyState,SimpleWebSocket.CLOSING);
}
{
 const {socket,ws}=fresh();socket.writableLength=900*1024;
 assert.equal(ws.send('x'),false);assert.equal(ws.readyState,SimpleWebSocket.CLOSING);
}
{
 const server=new WebSocketServer(),socket=new Socket();
 server.handleUpgrade({headers:{upgrade:'websocket',connection:'Upgrade','sec-websocket-key':'bad','sec-websocket-version':'13'}},socket,Buffer.alloc(0),()=>{throw Error('must reject');});
 assert.equal(socket.destroyed,true);assert.ok(socket.writes.some(b=>b.toString().includes('400 Bad Request')));
}
console.log('Network regressions: OK');
