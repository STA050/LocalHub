'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');

const { openDB, closeDB } = require('./db');
const { SettingsStore } = require('./settings');
const { Hub } = require('./ws');
const { authMiddleware, loginHandler, statusHandler, logoutHandler, hasSession, parseCookies } = require('./auth');
const { Cleaner } = require('./cleanup');
const { accessAllowed } = require('./net');
const { DdnsUpdater } = require('./ddns');
const { clipsRouter } = require('./routes/clips');
const { filesRouter } = require('./routes/files');
const { imagesRouter } = require('./routes/images');
const { shareRouter } = require('./routes/share');
const { systemRouter } = require('./routes/system');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/**
 * 创建并启动 LocalHub 服务。
 * @param {object} opts { port, dataDir, storageDir, host, silent }
 * @returns {{ port, server, app, close() }}
 */
function startServer(opts = {}) {
  const dataDir = path.resolve(opts.dataDir || path.join(__dirname, '..', 'data'));
  const storageDir = path.resolve(opts.storageDir || path.join(dataDir, 'storage'));
  const dirs = {
    files: path.join(storageDir, 'files'),
    images: path.join(storageDir, 'images'),
    tmp: path.join(storageDir, 'tmp'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

  openDB(dataDir);
  const settings = new SettingsStore();
  // 注意:opts.port 可以显式为 0(随机端口),不能用 || 回退
  const port = opts.port !== undefined && opts.port !== null && opts.port !== ''
    ? Number(opts.port)
    : (Number(settings.get('port')) || 5217);

  const app = express();
  const server = http.createServer(app);
  const hub = new Hub();

  /**
   * 连接级守卫:按"访客来源地址"判定,而不是按本地落点。
   * - 来源为私网/回环/Tailscale/链路本地:永远允许(这就是"本地局域网")
   * - 来源为公网:IPv6 需 ipv6 开关;IPv4 需 ddns 开关(公网 IPv4 入站需路由器端口转发)
   * 实时生效:开关状态每次请求都会重新读取,无需重启。
   */
  function connectionAllowed(req) {
    const remote = String((req.socket && req.socket.remoteAddress) || '');
    return accessAllowed(remote, {
      ipv6: settings.get('ipv6_enabled'),
      ddns: settings.get('ddns_enabled'),
    });
  }

  // WS 握手鉴权:连接守卫 + 开启访问保护时,仅允许持有会话(或免密 key)的连接订阅实时流
  hub.attach(server, (req) => {
    if (!connectionAllowed(req)) return false;
    if (!settings.get('access_password_enabled')) return true;
    if (hasSession(req)) return true;
    try {
      const u = new URL(req.url, 'http://localhost');
      if (u.searchParams.get('key') === String(settings.get('access_key'))) return true;
    } catch { /* ignore */ }
    return false;
  });

  app.disable('x-powered-by');
  // 连接级守卫(HTTP):实时生效,无需重启
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!connectionAllowed(req)) {
      const msg = '仅局域网模式:来自公网的连接已被拒绝(局域网与 Tailscale 不受影响)。如需公网访问,请在设置中开启 IPv6 / DDNS。';
      if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) {
        return res.status(403).json({ error: 'lan_only', message: msg });
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(403).send(`<h1>仅局域网模式</h1><p>${msg}</p><p><a href="javascript:history.back()">返回</a></p>`);
    }
    next();
  });
  app.use(express.json({ limit: '4mb' }));

  // 前端静态资源(含登录页 UI,始终公开;数据 API 由下方中间件保护)
  // no-cache:每次经 ETag 校验,保证前端更新后各设备即时生效
  app.use(express.static(PUBLIC_DIR, {
    index: 'index.html',
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));

  // 分享页(公开)
  app.get('/s/:slug', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'share.html')));

  const ctx = { settings, hub, dirs, port, startedAt: Date.now() };

  // 访问保护:公开路径之外的全部 API 需要会话
  const publicApi = [
    p => p.startsWith('/api/share/'),
    p => p.startsWith('/api/auth/'),
    p => /^\/api\/images\/\d+\/(raw|thumb)$/.test(p),
    p => p === '/api/system/lan',
    p => p === '/api/system/dashboard' && false, // 仪表盘需登录
  ];
  app.use('/api', authMiddleware(settings, publicApi));

  // 认证路由(公开,位于保护中间件之后由白名单放行)
  const authRouter = express.Router();
  authRouter.post('/login', loginHandler(settings));
  authRouter.get('/status', statusHandler(settings));
  authRouter.post('/logout', logoutHandler());
  app.use('/api/auth', authRouter);

  ctx.cleaner = new Cleaner(settings, dirs, (type, payload) => hub.broadcast(type, payload));
  ctx.cleaner.start();

  ctx.ddns = new DdnsUpdater(settings, hub);
  ctx.ddns.start();
  settings.onChange((key, val) => {
    const touched = key === '*batch' ? Object.keys(val || {}) : [key];
    if (touched.some(k => String(k).startsWith('ddns_'))) ctx.ddns.start();
  });

  app.use('/api/clips', clipsRouter(ctx));
  app.use('/api/files', filesRouter(ctx));
  app.use('/api/images', imagesRouter(ctx));
  app.use('/api/share', shareRouter(ctx));
  app.use('/api/system', systemRouter(ctx));

  // API 404
  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found', path: req.path }));

  // 全局错误处理
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[server]', err.message);
    if (res.headersSent) return;
    res.status(err.status || 500).json({ error: 'server_error', message: err.message });
  });

  // 优先绑定 IPv6 双栈(:: 同时接受 IPv4/IPv6 连接);无 IPv6 栈时回退 IPv4
  function listenOn(hostAddr) {
    return new Promise((resolve, reject) => {
      const onErr = (err) => { cleanup(); reject(err); };
      const onOk = () => { cleanup(); resolve(); };
      const cleanup = () => {
        server.removeListener('error', onErr);
        server.removeListener('listening', onOk);
      };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(port, hostAddr);
    });
  }

  return (async () => {
    try {
      await listenOn('::');
    } catch (err) {
      if (['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(err.code)) {
        await listenOn('0.0.0.0');
      } else {
        throw err; // EADDRINUSE 等真实冲突直接报错,避免静默错绑
      }
    }
    const actualPort = server.address().port;
    ctx.port = actualPort;
    if (!opts.silent) {
      console.log(`LocalHub is running: http://localhost:${actualPort}  (dual-stack, data dir: ${dataDir})`);
    }
    return {
      port: actualPort, server, app, settings, hub, cleaner: ctx.cleaner, ddns: ctx.ddns, dirs,
      close: () => new Promise((done) => {
        hub.close();
        ctx.cleaner.stop();
        ctx.ddns.stop();
        server.close(() => { closeDB(); done(); });
        // 兜底:1.5s 后强制结束
        setTimeout(() => { try { closeDB(); } catch { /* ignore */ } done(); }, 1500).unref?.();
      }),
    };
  })();
}

if (require.main === module) {
  startServer().catch(err => {
    if (err.code === 'EADDRINUSE') {
      console.error('Failed to start: the configured port is busy - another LocalHub instance is probably still running.');
      console.error('Stop it first (Task Manager > node.exe), or change the port in settings.');
    } else {
      console.error('Failed to start LocalHub:', err.message);
    }
    process.exit(1);
  });
}

module.exports = { startServer };
