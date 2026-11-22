'use strict';
const { getDB } = require('./db');
const { shortId, createRateLimiter } = require('./util');

const SESSION_COOKIE = 'lh_session';
const SESSION_TTL_MS = 30 * 24 * 3600e3; // 会话有效期 30 天

// 登录防爆破:同一 IP 15 分钟内 4 次失败后封锁
const loginLimiter = createRateLimiter(15 * 60e3, 4);

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createSession() {
  const db = getDB();
  const token = 'sess_' + shortId(32) + shortId(16);
  db.prepare('INSERT INTO sessions(token, created_at) VALUES(?, ?)').run(token, Date.now());
  return token;
}

function hasSession(req) {
  const db = getDB();
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return false;
  const row = db.prepare('SELECT token, created_at FROM sessions WHERE token = ?').get(token);
  if (!row) return false;
  return Date.now() - row.created_at < SESSION_TTL_MS; // 30 天过期
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/**
 * 访问保护中间件工厂。
 * 公开路径(无需登录):share 页面与分享 API、图片直链、健康检查、登录 API。
 */
function authMiddleware(settings, publicPathTesters) {
  return function auth(req, res, next) {
    const protectedMode = !!settings.get('access_password_enabled');
    if (!protectedMode) return next();
    // 挂载在 /api 之下时 req.path 是相对路径,拼上 baseUrl 得到完整路径
    const urlPath = (req.baseUrl || '') + req.path;
    for (const t of publicPathTesters) {
      if (t(urlPath)) return next();
    }
    // URL 参数免密授权(扫码链接携带)
    if (req.query && req.query.key) {
      if (String(req.query.key) === String(settings.get('access_key'))) {
        const token = createSession();
        setSessionCookie(res, token);
        // 去掉 key 参数继续(避免泄露到后续跳转)
        return next();
      }
    }
    if (hasSession(req)) return next();
    res.status(401).json({ error: 'unauthorized', message: '该设备尚未通过访问口令验证' });
  };
}

function loginHandler(settings) {
  return function login(req, res) {
    const ip = req.socket.remoteAddress || 'unknown';
    if (loginLimiter.blocked(ip)) {
      return res.status(429).json({ ok: false, error: 'too_many_attempts', message: '尝试次数过多,请 15 分钟后再试' });
    }
    const pw = String((req.body && req.body.password) || '');
    if (pw && settings.verifyPassword(pw)) {
      loginLimiter.reset(ip);
      const token = createSession();
      setSessionCookie(res, token);
      res.json({ ok: true });
    } else {
      if (pw) loginLimiter.fail(ip);
      res.status(401).json({ ok: false, error: 'wrong_password' });
    }
  };
}

function statusHandler(settings) {
  return function status(req, res) {
    res.json({
      protected: !!settings.get('access_password_enabled'),
      authorized: !settings.get('access_password_enabled') || hasSession(req),
    });
  };
}

function logoutHandler() {
  return function logout(req, res) {
    const db = getDB();
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    clearSessionCookie(res);
    res.json({ ok: true });
  };
}

module.exports = { authMiddleware, loginHandler, statusHandler, logoutHandler, hasSession, parseCookies, SESSION_COOKIE, resetLoginLimiter: () => loginLimiter.resetAll() };
