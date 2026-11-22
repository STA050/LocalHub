'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const { getDB } = require('../db');
const { safeName, shortId, nowMs, deviceFromUA, contentDisposition } = require('../util');

const IMAGE_MIME_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg', 'image/bmp': '.bmp', 'image/avif': '.avif' };

function extFor(name, mime) {
  const e = path.extname(name || '');
  if (e) return e.toLowerCase();
  return IMAGE_MIME_EXT[mime] || '.png';
}

/** 图床 API(粘贴截图即图床,直链局域网内可公开访问) */
function imagesRouter(ctx) {
  const { hub, settings, dirs } = ctx;
  const r = express.Router();

  const byId = (id) => getDB().prepare('SELECT * FROM images WHERE id = ?').get(id);

  r.get('/', (req, res) => {
    const db = getDB();
    const { search, limit } = req.query;
    let sql = 'SELECT id, name, mime, size, width, height, device, created_at, (thumb_path IS NOT NULL) AS has_thumb FROM images';
    const params = [];
    if (search) { sql += ' WHERE name LIKE ?'; params.push(`%${String(search)}%`); }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(Math.min(500, Number(limit) || 200));
    res.json({ items: db.prepare(sql).all(...params) });
  });

  // 上传图片(octet-stream,浏览器端可选先转 WebP/JPEG)
  r.post('/upload', (req, res) => {
    const mime = String(req.headers['content-type'] || 'image/png');
    if (!mime.startsWith('image/')) return res.status(415).json({ error: 'not_image', message: '仅支持图片文件' });
    const name = safeName(req.query.name || `image-${new Date().toISOString().replace(/[:.]/g, '-')}${extFor('', mime)}`);
    const tmpPath = path.join(dirs.tmp, `img_${shortId(12)}`);
    let received = 0;
    const ws = fs.createWriteStream(tmpPath);
    // 上传进度实时广播
    const ck = String(req.query.ck || '');
    const uploadId = `up_${shortId(8)}`;
    const device = deviceFromUA(req.headers['user-agent']);
    const declaredSize = Number(req.headers['content-length'] || 0);
    let lastBcast = 0;
    const broadcastProgress = () => {
      const now = Date.now();
      if (now - lastBcast < 250) return;
      lastBcast = now;
      hub.broadcast('upload:progress', { uploadId, ck, kind: 'image', name, size: declaredSize, loaded: received, device });
    };
    // 停滞超时:30 秒没有任何字节到达即视为中断
    let lastDataAt = Date.now();
    let abortedImg = false;
    const stallTimer = setInterval(() => {
      if (abortedImg) return;
      if (Date.now() - lastDataAt > 30000) {
        console.warn(`[images] upload stalled >30s, aborted: ${name}`);
        req.destroy();
        abortedImg = true;
        try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
        hub.broadcast('upload:cancelled', { uploadId, ck });
      }
    }, 5000);
    if (stallTimer.unref) stallTimer.unref();
    req.on('data', c => { received += c.length; lastDataAt = Date.now(); broadcastProgress(); });
    req.on('aborted', () => {
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
      hub.broadcast('upload:cancelled', { uploadId, ck });
    });
    req.pipe(ws);
    ws.on('error', () => {
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
      hub.broadcast('upload:cancelled', { uploadId, ck });
      if (!res.headersSent) res.status(500).json({ error: 'write_failed' });
    });
    ws.on('close', () => {
      clearInterval(stallTimer);
      if (abortedImg) return;
      const db = getDB();
      const finalPath = path.join(dirs.images, `i${Date.now().toString(36)}_${shortId(6)}${extFor(name, mime)}`);
      try { fs.renameSync(tmpPath, finalPath); } catch { fs.copyFileSync(tmpPath, finalPath); fs.rmSync(tmpPath, { force: true }); }
      const info = db.prepare('INSERT INTO images(name, mime, size, width, height, path, device, created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(name, mime, received, Number(req.query.width) || null, Number(req.query.height) || null, finalPath, device, nowMs());
      hub.broadcast('upload:done', { uploadId, ck });
      hub.broadcast('image:created', { id: Number(info.lastInsertRowid) });
      const row = byId(info.lastInsertRowid);
      res.status(201).json({ ...row, has_thumb: !!row.thumb_path });
    });
  });

  // 上传缩略图(浏览器端 canvas 生成)
  r.post('/:id/thumb', (req, res) => {
    const row = byId(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    const thumbPath = row.path.replace(/(\.[^.]+)?$/, '') + '.thumb.webp';
    const ws = fs.createWriteStream(thumbPath);
    req.pipe(ws);
    ws.on('error', () => { try { fs.rmSync(thumbPath, { force: true }); } catch { /* ignore */ } if (!res.headersSent) res.status(500).json({ error: 'write_failed' }); });
    ws.on('close', () => {
      if (fs.statSync(thumbPath).size < 100) { fs.rmSync(thumbPath, { force: true }); return res.status(400).json({ error: 'bad_thumb' }); }
      getDB().prepare('UPDATE images SET thumb_path = ? WHERE id = ?').run(thumbPath, row.id);
      hub.broadcast('image:updated', { id: row.id });
      res.json({ ok: true });
    });
  });

  // 用转换后的字节替换原图(WebP/JPEG 压缩由浏览器端完成)
  r.post('/:id/replace', (req, res) => {
    const db = getDB();
    const row = byId(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    const mime = String(req.headers['content-type'] || 'image/webp');
    if (!mime.startsWith('image/')) return res.status(415).json({ error: 'not_image' });
    const newPath = path.join(dirs.images, path.basename(row.path, path.extname(row.path)) + extFor(row.name, mime));
    const tmpPath = newPath + '.tmp';
    let received = 0;
    const ws = fs.createWriteStream(tmpPath);
    req.on('data', c => { received += c.length; });
    req.pipe(ws);
    ws.on('error', () => { try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ } if (!res.headersSent) res.status(500).json({ error: 'write_failed' }); });
    ws.on('close', () => {
      try {
        fs.renameSync(tmpPath, newPath);
        if (newPath !== row.path) { try { fs.rmSync(row.path, { force: true }); } catch { /* ignore */ } }
        const ext = mime === 'image/webp' ? '.webp' : mime === 'image/jpeg' ? '.jpg' : extFor(row.name, mime);
        const newName = row.name.replace(/\.[^.]+$/, '') + ext;
        db.prepare('UPDATE images SET name=?, mime=?, size=?, path=?, width=?, height=? WHERE id=?')
          .run(newName, mime, received, newPath, Number(req.query.width) || null, Number(req.query.height) || null, row.id);
        // 旧缩略图失效(内容已变),删除
        if (row.thumb_path) { try { fs.rmSync(row.thumb_path, { force: true }); } catch { /* ignore */ } db.prepare('UPDATE images SET thumb_path = NULL WHERE id = ?').run(row.id); }
        hub.broadcast('image:updated', { id: row.id });
        const updated = byId(row.id);
        res.json({ ...updated, has_thumb: false });
      } catch (err) {
        try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
        res.status(500).json({ error: 'replace_failed', message: err.message });
      }
    });
  });

  // 图片直链(公开访问,供 Markdown/HTML 引用)
  r.get('/:id/raw', (req, res) => {
    const row = byId(req.params.id);
    if (!row || !fs.existsSync(row.path)) return res.status(404).json({ error: 'not_found' });
    const stat = fs.statSync(row.path);
    // 图片字节可能被 WebP 转换替换,不能用 immutable 长缓存
    res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
    res.setHeader('ETag', `W/"${row.id}-${stat.size}-${Math.round(stat.mtimeMs)}"`);
    if (req.query.dl === '1') {
      res.setHeader('Content-Disposition', contentDisposition(row.name));
    } else {
      res.setHeader('Content-Disposition', contentDisposition(row.name, true));
    }
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Type', row.mime || 'application/octet-stream');
    const stream = fs.createReadStream(row.path);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });

  r.get('/:id/thumb', (req, res) => {
    const row = byId(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    let p = row.thumb_path;
    if (!p || !fs.existsSync(p)) p = row.path; // 回退到原图
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'not_found' });
    const stat = fs.statSync(p);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Type', p.endsWith('.webp') ? 'image/webp' : (row.mime || 'image/png'));
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const stream = fs.createReadStream(p);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });

  r.delete('/:id', (req, res) => {
    const db = getDB();
    const row = byId(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    try { fs.rmSync(row.path, { force: true }); } catch { /* ignore */ }
    if (row.thumb_path) { try { fs.rmSync(row.thumb_path, { force: true }); } catch { /* ignore */ } }
    db.prepare('DELETE FROM images WHERE id = ?').run(row.id);
    hub.broadcast('image:deleted', { id: row.id });
    res.json({ ok: true });
  });

  return r;
}

module.exports = { imagesRouter };
