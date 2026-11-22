'use strict';
const express = require('express');
const { getDB } = require('../db');
const { detectLang, nowMs, deviceFromUA } = require('../util');

function serializeClip(row) {
  if (!row) return null;
  let tags = [];
  try { tags = JSON.parse(row.tags || '[]'); } catch { /* ignore */ }
  return { ...row, tags, pinned: !!row.pinned, favorite: !!row.favorite };
}

/** 剪贴板文本流 API */
function clipsRouter(ctx) {
  const { hub } = ctx;
  const r = express.Router();

  const listQuery = (req) => {
    const db = getDB();
    const { search, tag, favorites, pinned, limit, offset } = req.query;
    const where = [];
    const params = [];
    if (search) {
      where.push('(content LIKE ? OR tags LIKE ?)');
      const s = `%${String(search)}%`;
      params.push(s, s);
    }
    if (tag) { where.push('tags LIKE ?'); params.push(`%"${String(tag)}"%`); }
    if (favorites === '1') where.push('favorite = 1');
    if (pinned === '1') where.push('pinned = 1');
    const sql = `SELECT * FROM clips ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY pinned DESC, created_at DESC LIMIT ? OFFSET ?`;
    params.push(Math.min(200, Number(limit) || 100), Number(offset) || 0);
    return db.prepare(sql).all(...params).map(serializeClip);
  };

  r.get('/', (req, res) => {
    res.json({ items: listQuery(req) });
  });

  r.get('/:id', (req, res) => {
    const row = getDB().prepare('SELECT * FROM clips WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(serializeClip(row));
  });

  r.post('/', (req, res) => {
    const db = getDB();
    const content = String(req.body?.content ?? '');
    if (!content.trim()) return res.status(400).json({ error: 'empty_content' });
    if (content.length > 2 * 1024 * 1024) return res.status(413).json({ error: 'too_large', message: '文本超过 2MB 限制' });
    let tags = req.body?.tags;
    if (typeof tags === 'string') tags = tags.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
    if (!Array.isArray(tags)) tags = [];
    const lang = detectLang(content);
    const contentType = lang && lang !== 'plaintext' ? 'code' : 'text';
    const now = nowMs();
    const device = deviceFromUA(req.headers['user-agent']);
    const info = db.prepare(
      'INSERT INTO clips(content, content_type, lang, tags, pinned, favorite, device, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)'
    ).run(content, contentType, lang, JSON.stringify(tags.slice(0, 12)), req.body?.pinned ? 1 : 0, req.body?.favorite ? 1 : 0, device, now, now);
    const row = db.prepare('SELECT * FROM clips WHERE id = ?').get(info.lastInsertRowid);
    hub.broadcast('clip:created', serializeClip(row));
    res.status(201).json(serializeClip(row));
  });

  r.patch('/:id', (req, res) => {
    const db = getDB();
    const row = db.prepare('SELECT * FROM clips WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    const b = req.body || {};
    let content = row.content, lang = row.lang, contentType = row.content_type;
    if (typeof b.content === 'string') {
      if (!b.content.trim()) return res.status(400).json({ error: 'empty_content' });
      content = b.content;
      lang = detectLang(content);
      contentType = lang ? 'code' : 'text';
    }
    let tags = row.tags;
    if (b.tags !== undefined) {
      let t = b.tags;
      if (typeof t === 'string') t = t.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
      if (!Array.isArray(t)) t = [];
      tags = JSON.stringify(t.slice(0, 12));
    }
    const pinned = b.pinned === undefined ? row.pinned : (b.pinned ? 1 : 0);
    const favorite = b.favorite === undefined ? row.favorite : (b.favorite ? 1 : 0);
    db.prepare('UPDATE clips SET content=?, content_type=?, lang=?, tags=?, pinned=?, favorite=?, updated_at=? WHERE id=?')
      .run(content, contentType, lang, tags, pinned, favorite, nowMs(), row.id);
    const updated = db.prepare('SELECT * FROM clips WHERE id = ?').get(row.id);
    hub.broadcast('clip:updated', serializeClip(updated));
    res.json(serializeClip(updated));
  });

  r.delete('/:id', (req, res) => {
    const db = getDB();
    const info = db.prepare('DELETE FROM clips WHERE id = ?').run(req.params.id);
    if (!info.changes) return res.status(404).json({ error: 'not_found' });
    hub.broadcast('clip:deleted', { id: Number(req.params.id) });
    res.json({ ok: true });
  });

  return r;
}

module.exports = { clipsRouter, serializeClip };
