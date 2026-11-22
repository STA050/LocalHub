'use strict';
const express = require('express');
const fs = require('fs');
const { getDB } = require('../db');
const { makeSlug, genCode, nowMs, contentDisposition, createRateLimiter } = require('../util');
const { serializeClip } = require('./clips');

const EXPIRY_MAP = { '1h': 3600e3, '24h': 86400e3, '7d': 604800e3 };

// 提取码防爆破:同一 IP 对同一分享 10 分钟内 8 次错误后封锁
const codeLimiter = createRateLimiter(10 * 60e3, 8);
function resetCodeLimiter() { codeLimiter.resetAll(); }
function checkCodeGuard(req, share, res) {
  if (!share.code) return true;
  const key = `${req.socket.remoteAddress || 'unknown'}|${share.slug}`;
  if (codeLimiter.blocked(key)) {
    res.status(429).json({ error: 'too_many_attempts', message: '提取码尝试次数过多,请 10 分钟后再试' });
    return false;
  }
  return true;
}
function failCode(req, share) {
  if (share.code) codeLimiter.fail(`${req.socket.remoteAddress || 'unknown'}|${share.slug}`);
}

/** 分享链接 API(带提取码/过期时间/阅后即焚) */
function shareRouter(ctx) {
  const { hub } = ctx;
  const r = express.Router();

  const findShare = (slugOrId) => {
    const db = getDB();
    return String(slugOrId).match(/^\d+$/)
      ? db.prepare('SELECT * FROM shares WHERE id = ?').get(Number(slugOrId))
      : db.prepare('SELECT * FROM shares WHERE slug = ?').get(String(slugOrId));
  };

  const targetRow = (share) => {
    const db = getDB();
    if (!share) return null;
    if (share.target_type === 'clip') return db.prepare('SELECT * FROM clips WHERE id = ?').get(share.target_id);
    if (share.target_type === 'file') return db.prepare('SELECT * FROM files WHERE id = ?').get(share.target_id);
    if (share.target_type === 'image') return db.prepare('SELECT * FROM images WHERE id = ?').get(share.target_id);
    return null;
  };

  // 创建分享
  r.post('/', (req, res) => {
    const db = getDB();
    const { target_type, target_id, expiry, code } = req.body || {};
    if (!['file', 'image', 'clip'].includes(target_type)) return res.status(400).json({ error: 'bad_target_type' });
    const table = { file: 'files', image: 'images', clip: 'clips' }[target_type];
    const target = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(target_id));
    if (!target) return res.status(404).json({ error: 'target_not_found' });

    let expiresAt = null, burn = 0;
    if (expiry === 'burn') burn = 1;
    else if (EXPIRY_MAP[expiry]) expiresAt = nowMs() + EXPIRY_MAP[expiry];
    else if (expiry !== 'forever') return res.status(400).json({ error: 'bad_expiry' });

    let codeVal = null;
    if (code === 'auto') codeVal = genCode();
    else if (typeof code === 'string' && /^\d{4}$/.test(code)) codeVal = code;
    else if (code) return res.status(400).json({ error: 'bad_code', message: '提取码须为 4 位数字' });

    let slug;
    for (let i = 0; i < 5; i++) {
      slug = makeSlug();
      try {
        db.prepare('INSERT INTO shares(slug, target_type, target_id, code, expires_at, burn_after_read, created_at) VALUES(?,?,?,?,?,?,?)')
          .run(slug, target_type, Number(target_id), codeVal, expiresAt, burn, nowMs());
        break;
      } catch (e) {
        if (i === 4) throw e; // slug 冲突重试
      }
    }
    const share = db.prepare('SELECT * FROM shares WHERE slug = ?').get(slug);
    hub.broadcast('share:created', { id: share.id, target_type, target_id: Number(target_id) });
    res.status(201).json({
      id: share.id, slug, target_type, target_id: Number(target_id),
      code: codeVal, expires_at: expiresAt, burn_after_read: !!burn,
      url: `/s/${slug}`,
    });
  });

  // 管理列表(需登录,由全局中间件保障)
  r.get('/list', (req, res) => {
    const db = getDB();
    const shares = db.prepare('SELECT * FROM shares ORDER BY created_at DESC LIMIT 200').all();
    res.json({
      items: shares.map(s => {
        const t = targetRow(s);
        return {
          ...s,
          target_name: t ? (t.name ?? (t.content || '').slice(0, 60)) : null,
          target_size: t?.size ?? null,
          target_missing: !t,
        };
      }),
    });
  });

  // 分享页元信息(公开;带提取码校验)
  r.get('/:slug/info', (req, res) => {
    const share = findShare(req.params.slug);
    if (!share) return res.status(404).json({ error: 'not_found', message: '分享不存在或已被清理' });
    if (share.expires_at && share.expires_at < nowMs()) {
      return res.status(410).json({ error: 'expired', message: '分享已过期' });
    }
    if (share.code) {
      if (!checkCodeGuard(req, share, res)) return;
      const given = String(req.query.code || '');
      if (given !== String(share.code)) { failCode(req, share); return res.status(403).json({ error: 'wrong_code', message: '提取码不正确' }); }
    }
    const t = targetRow(share);
    if (!t) return res.status(404).json({ error: 'target_missing' });
    res.json({
      type: share.target_type,
      name: t.name ?? '文本片段',
      size: t.size ?? Buffer.byteLength(t.content || '', 'utf8'),
      has_code: !!share.code,
      burn: !!share.burn_after_read,
      expires_at: share.expires_at,
    });
  });

  // 分享内容(公开;带提取码校验、阅后即焚)
  r.get('/:slug/content', (req, res) => {
    const db = getDB();
    const share = findShare(req.params.slug);
    if (!share) return res.status(404).json({ error: 'not_found', message: '分享不存在或已被清理' });
    if (share.expires_at && share.expires_at < nowMs()) {
      db.prepare('DELETE FROM shares WHERE id = ?').run(share.id);
      return res.status(410).json({ error: 'expired', message: '分享已过期' });
    }
    if (share.code) {
      if (!checkCodeGuard(req, share, res)) return;
      const given = String(req.query.code || '');
      if (given !== String(share.code)) { failCode(req, share); return res.status(403).json({ error: 'wrong_code', message: '提取码不正确' }); }
      codeLimiter.reset(`${req.socket.remoteAddress || 'unknown'}|${share.slug}`); // 正确码清零计数
    }
    const t = targetRow(share);
    if (!t) return res.status(404).json({ error: 'target_missing' });

    db.prepare('UPDATE shares SET access_count = access_count + 1 WHERE id = ?').run(share.id);
    if (share.burn_after_read) {
      // 阅后即焚:分享链接失效(内容本体保留在工作台)
      db.prepare('DELETE FROM shares WHERE id = ?').run(share.id);
    }

    if (share.target_type === 'clip') {
      if (req.query.format === 'json') return res.json(serializeClip(t));
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.send(t.content);
    }
    if (share.target_type === 'image') {
      if (!fs.existsSync(t.path)) return res.status(404).json({ error: 'target_missing' });
      res.setHeader('Content-Type', t.mime || 'image/png');
      res.setHeader('Content-Disposition', contentDisposition(t.name, true));
      const stream = fs.createReadStream(t.path);
      stream.on('error', () => res.destroy());
      return stream.pipe(res);
    }
    // file
    if (!fs.existsSync(t.path)) return res.status(404).json({ error: 'target_missing' });
    const stat = fs.statSync(t.path);
    res.setHeader('Content-Type', t.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDisposition(t.name, req.query.preview === '1'));
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(t.path);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });

  // 撤销分享
  r.delete('/:id', (req, res) => {
    const share = findShare(req.params.id);
    if (!share) return res.status(404).json({ error: 'not_found' });
    getDB().prepare('DELETE FROM shares WHERE id = ?').run(share.id);
    hub.broadcast('share:deleted', { id: share.id });
    res.json({ ok: true });
  });

  return r;
}

module.exports = { shareRouter, resetCodeLimiter };
