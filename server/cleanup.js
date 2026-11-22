'use strict';
const fs = require('fs');
const path = require('path');
const { getDB } = require('./db');

/**
 * 定时清理任务:
 * 1. 删除已过期的分享链接
 * 2. 按保留时长删除过期剪贴板、文件、图片及其磁盘文件
 * 3. 一致性检查:清理孤儿磁盘文件与指向缺失文件的记录
 */
class Cleaner {
  constructor(settings, dirs, onChange) {
    this.settings = settings;
    this.dirs = dirs; // { files, images }
    this.onChange = onChange; // (event, payload) => void
    this.timer = null;
    this.lastRun = null;
    this.lastResult = null;
  }

  start() {
    this.stop();
    const tick = () => this.run().catch(err => console.error('[cleanup]', err.message));
    const intervalMs = Math.max(1, Number(this.settings.get('cleanup_interval_minutes') || 30)) * 60000;
    this.timer = setInterval(tick, intervalMs);
    if (this.timer.unref) this.timer.unref();
    // 启动后延迟 5 秒先跑一次
    const t = setTimeout(tick, 5000);
    if (t.unref) t.unref();
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  async run() {
    const db = getDB();
    const now = Date.now();
    const result = { sharesDeleted: 0, clipsDeleted: 0, filesDeleted: 0, imagesDeleted: 0, orphansDeleted: 0, at: now };

    // 1. 过期分享(阅后即焚在访问时已处理;这里清理 expires_at 已过的)
    const delShares = db.prepare('DELETE FROM shares WHERE expires_at IS NOT NULL AND expires_at < ?').run(now);
    result.sharesDeleted = delShares.changes;

    // 1.5 过期会话(30 天)
    db.prepare('DELETE FROM sessions WHERE created_at < ?').run(now - 30 * 24 * 3600e3);

    // 2. 超期内容
    const retention = Number(this.settings.get('item_retention_minutes') || 0);
    if (retention > 0) {
      const cutoff = now - retention * 60000;
      result.clipsDeleted = db.prepare('DELETE FROM clips WHERE created_at < ?').run(cutoff).changes;
      // 文件与图片需先取路径再删,以便清理磁盘
      const oldFiles = db.prepare('SELECT id, path FROM files WHERE created_at < ?').all(cutoff);
      const oldImages = db.prepare('SELECT id, path, thumb_path FROM images WHERE created_at < ?').all(cutoff);
      for (const f of oldFiles) rmQuiet(f.path);
      for (const i of oldImages) { rmQuiet(i.path); rmQuiet(i.thumb_path); }
      if (oldFiles.length) db.prepare('DELETE FROM files WHERE created_at < ?').run(cutoff);
      if (oldImages.length) db.prepare('DELETE FROM images WHERE created_at < ?').run(cutoff);
      result.filesDeleted = oldFiles.length;
      result.imagesDeleted = oldImages.length;
    }

    // 3. 磁盘一致性
    const knownPaths = new Set();
    for (const [table] of [['files'], ['images']]) {
      const rows = db.prepare(`SELECT id, path${table === 'images' ? ', thumb_path' : ''} FROM ${table}`).all();
      for (const row of rows) {
        knownPaths.add(path.resolve(row.path));
        if (row.thumb_path) knownPaths.add(path.resolve(row.thumb_path));
        if (!fs.existsSync(row.path)) {
          db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(row.id);
          result.orphansDeleted++;
        }
      }
    }
    for (const dir of [this.dirs.files, this.dirs.images, this.dirs.tmp]) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const f of names) {
        const full = path.resolve(path.join(dir, f));
        if (knownPaths.has(full)) continue;
        // 孤儿文件(含上传中断的 tmp 残片):仅清理 1 小时以前的,避免误删正在写入的文件
        try {
          const stat = fs.statSync(full);
          if (now - stat.mtimeMs > 3600e3) { fs.rmSync(full, { force: true }); result.orphansDeleted++; }
        } catch { /* ignore */ }
      }
    }

    this.lastRun = now;
    this.lastResult = result;
    const total = result.sharesDeleted + result.clipsDeleted + result.filesDeleted + result.imagesDeleted + result.orphansDeleted;
    if (this.onChange && total > 0) {
      this.onChange('cleanup', { ...result, deletedTotal: total });
    }
    return result;
  }
}

function rmQuiet(p) {
  if (!p) return;
  try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
}

/** 磁盘用量统计 */
function storageStats(dirs) {
  const db = getDB();
  const sum = db.prepare(`
    SELECT
      (SELECT COALESCE(SUM(size),0) FROM files) AS filesSize,
      (SELECT COUNT(*) FROM files) AS filesCount,
      (SELECT COALESCE(SUM(size),0) FROM images) AS imagesSize,
      (SELECT COUNT(*) FROM images) AS imagesCount,
      (SELECT COUNT(*) FROM clips) AS clipsCount,
      (SELECT COUNT(*) FROM shares) AS sharesCount
  `).get();
  let diskFree = null, diskTotal = null;
  try {
    const root = path.resolve(path.dirname(Object.values(dirs)[0]));
    const st = fs.statfsSync(root);
    diskFree = st.bavail * st.bsize;
    diskTotal = st.blocks * st.bsize;
  } catch { /* unsupported platform */ }
  return {
    files: { count: sum.filesCount, size: sum.filesSize },
    images: { count: sum.imagesCount, size: sum.imagesSize },
    clips: { count: sum.clipsCount },
    shares: { count: sum.sharesCount },
    totalSize: sum.filesSize + sum.imagesSize,
    diskFree, diskTotal,
  };
}

module.exports = { Cleaner, storageStats };
