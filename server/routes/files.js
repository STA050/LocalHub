'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { getDB } = require('../db');
const { safeName, shortId, nowMs, deviceFromUA, contentDisposition, humanSize } = require('../util');

/** 局域网文件快传 API(流式上传下载) */
function filesRouter(ctx) {
  const { hub, settings, dirs } = ctx;
  const r = express.Router();

  const byId = (id) => getDB().prepare('SELECT * FROM files WHERE id = ?').get(id);

  r.get('/', (req, res) => {
    const db = getDB();
    const { search, limit } = req.query;
    let sql = 'SELECT * FROM files';
    const params = [];
    if (search) { sql += ' WHERE name LIKE ?'; params.push(`%${String(search)}%`); }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(Math.min(500, Number(limit) || 200));
    res.json({ items: db.prepare(sql).all(...params), maxFileSizeMb: settings.get('max_file_size_mb') });
  });

  // 流式上传:body 为原始文件字节(XHR 可获得真实进度)
  r.post('/upload', (req, res) => {
    const name = safeName(req.query.name || 'file.bin');
    const declaredSize = Number(req.headers['content-length'] || 0);
    const maxBytes = Number(settings.get('max_file_size_mb') || 0) * 1024 * 1024;
    if (maxBytes > 0 && declaredSize > maxBytes) {
      return res.status(413).json({ error: 'too_large', message: `文件超过大小上限 ${settings.get('max_file_size_mb')} MB` });
    }
    // 先写入临时文件,入库后再移动为正式文件名
    const tmpPath = path.join(dirs.tmp, `tmp_${shortId(12)}`);
    let received = 0;
    const ws = fs.createWriteStream(tmpPath);
    let aborted = false;
    // 上传进度实时广播:其他设备的网页可以看到"有文件正在上传"
    const ck = String(req.query.ck || '');
    const uploadId = `up_${shortId(8)}`;
    const device = deviceFromUA(req.headers['user-agent']);
    let lastBcast = 0;
    const broadcastProgress = (final = false) => {
      const now = Date.now();
      if (!final && now - lastBcast < 250) return; // 节流:每 250ms 最多一次
      lastBcast = now;
      hub.broadcast('upload:progress', { uploadId, ck, kind: 'file', name, size: declaredSize, loaded: received, device });
    };
    // 停滞超时:30 秒没有任何字节到达即视为中断(客户端崩溃/网络断开),避免永久挂起
    let lastDataAt = Date.now();
    const stallTimer = setInterval(() => {
      if (aborted) return;
      if (Date.now() - lastDataAt > 30000) {
        console.warn(`[files] upload stalled >30s, aborted: ${name}`);
        req.destroy();
        aborted = true;
        try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
        hub.broadcast('upload:cancelled', { uploadId, ck });
      }
    }, 5000);
    if (stallTimer.unref) stallTimer.unref();
    const touch = () => { lastDataAt = Date.now(); };

    const abort = (msg) => {
      aborted = true;
      req.unpipe(ws);
      req.removeAllListeners('data');
      ws.destroy();
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
      hub.broadcast('upload:cancelled', { uploadId, ck });
      if (!res.headersSent) res.status(413).json({ error: 'too_large', message: msg });
    };

    req.on('data', (chunk) => {
      if (aborted) return;
      received += chunk.length;
      touch();
      broadcastProgress();
      if (maxBytes > 0 && received > maxBytes) abort(`文件超过大小上限 ${settings.get('max_file_size_mb')} MB`);
    });
    req.on('aborted', () => {
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
      hub.broadcast('upload:cancelled', { uploadId, ck });
    });

    req.pipe(ws);
    ws.on('error', (err) => {
      console.error('[files] write error', err.message);
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
      hub.broadcast('upload:cancelled', { uploadId, ck });
      if (!res.headersSent) res.status(500).json({ error: 'write_failed' });
    });
    ws.on('close', () => {
      clearInterval(stallTimer);
      if (aborted) return;
      const db = getDB();
      const now = nowMs();
      const info = db.prepare('INSERT INTO files(name, mime, size, path, device, created_at) VALUES(?,?,?,?,?,?)')
        .run(name, String(req.headers['content-type'] || 'application/octet-stream'), received, tmpPath, device, now);
      const finalPath = path.join(dirs.files, `f${info.lastInsertRowid}_${name}`);
      try {
        fs.renameSync(tmpPath, finalPath);
      } catch {
        // 跨盘符等情况退化为复制
        fs.copyFileSync(tmpPath, finalPath);
        fs.rmSync(tmpPath, { force: true });
      }
      db.prepare('UPDATE files SET path = ? WHERE id = ?').run(finalPath, info.lastInsertRowid);
      const row = byId(info.lastInsertRowid);
      hub.broadcast('upload:done', { uploadId, ck });
      hub.broadcast('file:created', row);
      res.status(201).json(row);
    });
  });

  // 单文件下载(支持 Range,便于移动端视频拖动播放)
  r.get('/:id/download', (req, res) => {
    const row = byId(req.params.id);
    if (!row || !fs.existsSync(row.path)) return res.status(404).json({ error: 'not_found' });
    const stat = fs.statSync(row.path);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', contentDisposition(row.name));
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        let start = m[1] === '' ? 0 : parseInt(m[1], 10);
        let end = m[2] === '' ? stat.size - 1 : parseInt(m[2], 10);
        if (isNaN(start) || start > end || end >= stat.size) {
          res.status(416).setHeader('Content-Range', `bytes */${stat.size}`);
          return res.end();
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
        res.setHeader('Content-Length', end - start + 1);
        const stream = fs.createReadStream(row.path, { start, end });
        return stream.pipe(res);
      }
    }
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Type', row.mime || 'application/octet-stream');
    const stream = fs.createReadStream(row.path);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });

  // 批量打包 ZIP 下载
  r.get('/download.zip', (req, res) => {
    const db = getDB();
    const ids = String(req.query.ids || '').split(',').map(s => parseInt(s, 10)).filter(n => Number.isInteger(n) && n > 0);
    if (!ids.length) return res.status(400).json({ error: 'no_ids' });
    const rows = ids.map(byId).filter(Boolean).filter(f => fs.existsSync(f.path));
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const zipName = `LocalHub_文件_${new Date().toISOString().slice(0, 10)}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', contentDisposition(zipName));
    const archive = archiver('zip', { zlib: { level: 0 } }); // 存储模式:不重复压缩,速度最快
    archive.on('error', (err) => { console.error('[zip]', err.message); res.destroy(); });
    archive.pipe(res);
    const used = new Set();
    for (const f of rows) {
      let n = f.name;
      let k = 1;
      while (used.has(n)) { n = `${path.basename(f.name, path.extname(f.name))}(${k++})${path.extname(f.name)}`; }
      used.add(n);
      archive.file(f.path, { name: n });
    }
    archive.finalize();
  });

  r.delete('/:id', (req, res) => {
    const db = getDB();
    const row = byId(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    try { fs.rmSync(row.path, { force: true }); } catch { /* ignore */ }
    db.prepare('DELETE FROM files WHERE id = ?').run(row.id);
    hub.broadcast('file:deleted', { id: row.id });
    res.json({ ok: true });
  });

  r.post('/delete-batch', (req, res) => {
    const db = getDB();
    const ids = (req.body?.ids || []).map(Number).filter(Number.isInteger);
    let n = 0;
    for (const id of ids) {
      const row = byId(id);
      if (!row) continue;
      try { fs.rmSync(row.path, { force: true }); } catch { /* ignore */ }
      db.prepare('DELETE FROM files WHERE id = ?').run(id);
      n++;
    }
    if (n) hub.broadcast('file:deleted', { ids: ids });
    res.json({ ok: true, deleted: n });
  });

  return r;
}

module.exports = { filesRouter };
