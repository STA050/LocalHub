'use strict';
const { WebSocketServer } = require('ws');
const { deviceFromUA } = require('./util');

/** WebSocket 实时推送中心(含设备注册表:按浏览器指纹去重) */
class Hub {
  constructor() {
    this.wss = null;
    this.clients = new Set();
    this.pingTimer = null;
  }

  attach(httpServer, verifier) {
    this.wss = new WebSocketServer({
      server: httpServer,
      path: '/ws',
      // 升级握手前校验:开启访问保护时,未授权连接直接拒绝(否则任何人可监听实时剪贴板)
      verifyClient: (info, cb) => {
        try {
          cb(!verifier || verifier(info.req));
        } catch { cb(false); }
      },
    });
    // 将监听错误(如端口被占用)转发到 HTTP server,避免成为未处理事件
    this.wss.on('error', (err) => {
      try { httpServer.emit('error', err); } catch { console.error('[ws]', err.message); }
    });
    this.wss.on('connection', (ws, req) => {
      ws.isAlive = true;
      ws.meta = {
        ck: this.parseCk(req.url),
        device: deviceFromUA(req.headers['user-agent']),
        remote: (req.socket.remoteAddress || '').replace(/^::ffff:/, ''),
        connectedAt: Date.now(),
      };
      this.clients.add(ws);
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('error', () => { /* ignore */ });
      ws.on('close', () => {
        this.clients.delete(ws);
        this.broadcastPresence(); // 设备断开时同步在线列表
      });
      this.sendTo(ws, { type: 'hello', payload: { online: this.deviceCount(), devices: this.devices() } });
      this.broadcastPresence();
    });
    this.pingTimer = setInterval(() => {
      for (const ws of this.clients) {
        if (!ws.isAlive) { try { ws.terminate(); } catch { /* ignore */ } this.clients.delete(ws); continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch { /* ignore */ }
      }
    }, 25000);
    if (this.pingTimer.unref) this.pingTimer.unref();
  }

  /** 从升级请求 URL 中取出浏览器指纹 ck */
  parseCk(url) {
    try {
      return new URL(url, 'http://localhost').searchParams.get('ck') || '';
    } catch { return ''; }
  }

  /** 设备注册表:同一浏览器(相同 ck)的多个标签页/连接计为一台设备 */
  devices() {
    const map = new Map();
    let anon = 0;
    for (const ws of this.clients) {
      const m = ws.meta || {};
      const key = m.ck || `anon-${++anon}`;
      const rec = map.get(key) || {
        key,
        device: m.device || 'Unknown',
        address: m.remote || '',
        connections: 0,
        connectedAt: m.connectedAt || Date.now(),
      };
      rec.connections++;
      rec.connectedAt = Math.min(rec.connectedAt, m.connectedAt || Date.now());
      map.set(key, rec);
    }
    return [...map.values()].sort((a, b) => a.connectedAt - b.connectedAt);
  }

  deviceCount() { return this.devices().length; }

  broadcastPresence() {
    this.broadcast('presence', { online: this.deviceCount(), devices: this.devices() });
  }

  sendTo(ws, msg) {
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
    }
  }

  /** 广播事件;skip 可指定跳过的连接 */
  broadcast(type, payload, skip = null) {
    const data = JSON.stringify({ type, payload, ts: Date.now() });
    for (const ws of this.clients) {
      if (ws === skip) continue;
      this.sendRaw(ws, data);
    }
  }

  sendRaw(ws, data) {
    if (ws && ws.readyState === 1) {
      try { ws.send(data); } catch { /* ignore */ }
    }
  }

  onlineCount() { return this.deviceCount(); }

  close() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.wss) for (const ws of this.clients) { try { ws.close(); } catch { /* ignore */ } }
    if (this.wss) { try { this.wss.close(); } catch { /* ignore */ } }
    this.clients.clear();
  }
}

module.exports = { Hub };
