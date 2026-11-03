'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

class SimpleWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(socket, maxPayload = 32 * 1024) {
    super();
    this.socket = socket;
    this.readyState = SimpleWebSocket.OPEN;
    this.maxPayload = maxPayload;
    this.maxBufferedAmount = 768 * 1024;
    this.buffer = Buffer.alloc(0);
    this.fragmentOpcode = 0;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.lastPongAt = Date.now();
    try { socket.setNoDelay(true); socket.setKeepAlive(true, 15000); } catch {}

    socket.on('data', chunk => this._onData(chunk));
    socket.on('close', () => this._finalizeClose());
    socket.on('end', () => this._finalizeClose());
    socket.on('error', err => this.emit('error', err));
  }

  get bufferedAmount() {
    return this.socket?.writableLength || 0;
  }

  send(data) {
    if (this.readyState !== SimpleWebSocket.OPEN) return false;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    if (this.bufferedAmount > this.maxBufferedAmount) { this.close(1013, 'slow receiver'); return false; }
    try { this.socket.write(makeFrame(0x1, payload)); return true; } catch { this.socket.destroy(); return false; }
  }

  ping(payload = Buffer.alloc(0)) {
    if (this.readyState !== SimpleWebSocket.OPEN) return false;
    try { this.socket.write(makeFrame(0x9, Buffer.isBuffer(payload) ? payload.subarray(0,125) : Buffer.from(String(payload)).subarray(0,125))); return true; } catch { return false; }
  }

  close(code = 1000, reason = '') {
    if (this.readyState >= SimpleWebSocket.CLOSING) return;
    this.readyState = SimpleWebSocket.CLOSING;
    const reasonBuf = Buffer.from(String(reason).slice(0, 120));
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    try { this.socket.write(makeFrame(0x8, payload)); } catch {}
    setTimeout(() => { try { this.socket.end(); } catch {} }, 20).unref?.();
  }

  _finalizeClose() {
    if (this.readyState === SimpleWebSocket.CLOSED) return;
    this.readyState = SimpleWebSocket.CLOSED;
    this.emit('close');
  }

  _onData(chunk) {
    if (!chunk?.length || this.readyState !== SimpleWebSocket.OPEN) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (true) {
      const parsed = parseFrame(this.buffer, this.maxPayload);
      if (!parsed) return;
      if (parsed.error) {
        this.close(1009, parsed.error);
        return;
      }
      this.buffer = this.buffer.subarray(parsed.bytes);
      this._handleFrame(parsed);
    }
  }

  _handleFrame(frame) {
    if (this.readyState !== SimpleWebSocket.OPEN) return;
    const { fin, opcode, payload } = frame;
    if (opcode === 0x8) {
      if (this.readyState === SimpleWebSocket.OPEN) {
        this.readyState = SimpleWebSocket.CLOSING;
        try { this.socket.write(makeFrame(0x8, payload.subarray(0, 125))); } catch {}
      }
      try { this.socket.end(); } catch {}
      return;
    }
    if (opcode === 0x9) {
      try { this.socket.write(makeFrame(0xA, payload.subarray(0, 125))); } catch {}
      return;
    }
    if (opcode === 0xA) { this.lastPongAt = Date.now(); this.emit('pong'); return; }

    if (opcode === 0x0) {
      if (!this.fragmentOpcode) return this.close(1002, 'unexpected continuation');
      this.fragments.push(payload); this.fragmentBytes += payload.length;
      if (this.fragmentBytes > this.maxPayload) return this.close(1009, 'payload too large');
      if (fin) {
        const full = Buffer.concat(this.fragments, this.fragmentBytes);
        const type = this.fragmentOpcode;
        this.fragmentOpcode = 0; this.fragments = []; this.fragmentBytes = 0;
        if (type === 0x1) this.emit('message', full);
      }
      return;
    }

    if (opcode !== 0x1 && opcode !== 0x2) return this.close(1002, 'unsupported opcode');
    if (opcode === 0x2) return this.close(1003, 'binary messages not supported');
    if (this.fragmentOpcode) return this.close(1002, 'fragment already in progress');
    if (!fin) {
      this.fragmentOpcode = opcode;
      this.fragments = [payload];
      this.fragmentBytes = payload.length;
      return;
    }
    if (opcode === 0x1) this.emit('message', payload);
  }
}

class WebSocketServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
  }

  handleUpgrade(req, socket, head, cb) {
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    const connection = String(req.headers.connection || '').toLowerCase();
    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    const keyBuffer = typeof key === 'string' && /^[A-Za-z0-9+/]{22}==$/.test(key) ? Buffer.from(key, 'base64') : null;
    if (upgrade !== 'websocket' || !connection.split(',').some(x=>x.trim()==='upgrade') || !keyBuffer || keyBuffer.length !== 16 || version !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    const accept = crypto.createHash('sha1')
      .update(String(key) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    const ws = new SimpleWebSocket(socket, this.options.maxPayload || 32 * 1024);
    if (head?.length) ws._onData(head);
    cb(ws);
  }
}

function makeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | opcode; header[1] = len;
  } else if (len <= 0xFFFF) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function parseFrame(buffer, maxPayload) {
  if (buffer.length < 2) return null;
  const b0 = buffer[0], b1 = buffer[1];
  const fin = !!(b0 & 0x80);
  const rsv = b0 & 0x70;
  const opcode = b0 & 0x0F;
  const masked = !!(b1 & 0x80);
  if (rsv) return { error:'RSV unsupported', bytes:buffer.length };
  if ((opcode >= 0x8 && (!fin || (b1 & 0x7f) > 125)) || [0x3,0x4,0x5,0x6,0x7,0xB,0xC,0xD,0xE,0xF].includes(opcode))
    return { error:'invalid control frame or opcode', bytes:buffer.length };
  if (!masked) return { error:'client frames must be masked', bytes:buffer.length };
  let len = b1 & 0x7F;
  let offset = 2;
  if (len === 126) {
    if (buffer.length < 4) return null;
    len = buffer.readUInt16BE(2); offset = 4;
  } else if (len === 127) {
    if (buffer.length < 10) return null;
    const big = buffer.readBigUInt64BE(2);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return { error:'payload too large', bytes:buffer.length };
    len = Number(big); offset = 10;
  }
  if (len > maxPayload) return { error:'payload too large', bytes:buffer.length };
  if (buffer.length < offset + 4 + len) return null;
  const mask = buffer.subarray(offset, offset + 4); offset += 4;
  const payload = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) payload[i] = buffer[offset + i] ^ mask[i & 3];
  return { fin, opcode, payload, bytes:offset + len };
}

module.exports = { WebSocketServer, WebSocket: SimpleWebSocket };
