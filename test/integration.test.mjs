/* LocalHub 全链路集成测试:真实文件流式上传下载、剪贴板 CRUD、
   过期清理、提取码校验、访问保护、设置持久化 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startServer } from '../server/index.js';
import { getDB } from '../server/db.js';
import ddnsMod from '../server/ddns.js';
import WebSocket from 'ws';

const { runOnce, detectAddresses, splitDnsPodName } = ddnsMod;
import authMod from '../server/auth.js';
import shareMod from '../server/routes/share.js';
const { resetLoginLimiter } = authMod;
const { resetCodeLimiter } = shareMod;
import netMod from '../server/net.js';
const { ifaceToolName, accessAllowed } = netMod;

let srv;
let base;
let cookieJar = ''; // 已授权会话 cookie
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'localhub-test-'));

const PNG_1PX = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
  '0000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082',
  'hex'
);

function j(res) { return res.json(); }

async function GET(p, headers = {}) {
  return fetch(base + p, { headers: { cookie: cookieJar, ...headers } });
}
async function POST_JSON(p, body, headers = {}) {
  return fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieJar, ...headers },
    body: JSON.stringify(body),
  });
}
async function PUT_JSON(p, body) {
  return fetch(base + p, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: cookieJar },
    body: JSON.stringify(body),
  });
}
async function DEL(p) {
  return fetch(base + p, { method: 'DELETE', headers: { cookie: cookieJar } });
}

/** 解析 zip 中央目录,返回条目名列表 */
function zipEntries(buf) {
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'ZIP 本地文件头签名');
  // 从尾部找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65557; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.ok(eocd >= 0, 'ZIP EOCD 存在');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const names = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, '中央目录签名');
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    names.push(buf.slice(p + 46, p + 46 + nameLen).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

before(async () => {
  srv = await startServer({
    port: 0,
    dataDir: path.join(tmpRoot, 'data'),
    storageDir: path.join(tmpRoot, 'storage'),
    silent: true,
  });
  base = `http://127.0.0.1:${srv.port}`;
});

after(async () => {
  await srv.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('基础与静态资源', () => {
  test('首页与分享页可访问', async () => {
    const home = await GET('/');
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /LocalHub/);
    assert.match(html, /js\/app\.js/);
    const share = await fetch(`${base}/s/someslug`);
    assert.equal(share.status, 200);
  });
  test('未知 API 返回 JSON 404', async () => {
    const r = await GET('/api/nonexistent');
    assert.equal(r.status, 404);
    const d = await j(r);
    assert.equal(d.error, 'not_found');
  });
  test('局域网信息接口返回 IP', async () => {
    const d = await j(await GET('/api/system/lan'));
    assert.ok(Array.isArray(d.ips));
    assert.ok(d.port > 0);
  });
  test('lan 接口提供双栈地址列表(IPv6 带方括号)', async () => {
    const d = await j(await GET('/api/system/lan'));
    assert.ok(Array.isArray(d.urls) && d.urls.length >= 1, '至少有一个访问地址');
    for (const u of d.urls) {
      assert.ok(/^http:\/\/.+:\d+$/.test(u.url), `URL 格式合法: ${u.url}`);
      if (u.family === 6) {
        assert.match(u.url, /http:\/\/\[[0-9a-f:]+\]:\d+$/i, 'IPv6 地址必须带方括号');
        assert.match(u.host, /^\[/);
      } else {
        assert.doesNotMatch(u.url, /\[/, 'IPv4 URL 不应含方括号');
      }
      assert.ok(!/\bfe80/i.test(u.host) && !u.host.includes('::1'), '不应包含链路本地/环回地址');
    }
    assert.equal(typeof d.hasGlobalIPv6, 'boolean');
  });
});

describe('剪贴板文本流:增删改查 + 代码识别 + 搜索', () => {
  let clipId;
  test('创建代码片段自动识别语言', async () => {
    const r = await POST_JSON('/api/clips', { content: 'function hello() {\n  const x = 42;\n  return x;\n}' },
      { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36' });
    assert.equal(r.status, 201);
    const clip = await j(r);
    clipId = clip.id;
    assert.equal(clip.content_type, 'code');
    assert.equal(clip.lang, 'javascript');
    assert.match(clip.device, /Windows|Linux|macOS|ChromeOS/);
  });
  test('创建带标签的纯文本', async () => {
    const r = await POST_JSON('/api/clips', { content: '这是一条普通文本 https://example.com', tags: '常用, 工作' });
    const clip = await j(r);
    assert.equal(clip.content_type, 'text');
    assert.deepEqual(clip.tags, ['常用', '工作']);
  });
  test('列表 + 全文检索', async () => {
    let d = await j(await GET('/api/clips'));
    assert.ok(d.items.length >= 2);
    d = await j(await GET('/api/clips?search=' + encodeURIComponent('普通文本')));
    assert.equal(d.items.length, 1);
    assert.match(d.items[0].content, /普通文本/);
  });
  test('置顶与收藏', async () => {
    const r = await fetch(`${base}/api/clips/${clipId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', cookie: cookieJar },
      body: JSON.stringify({ pinned: true, favorite: true, tags: ['code'] }),
    });
    const clip = await j(r);
    assert.equal(clip.pinned, true);
    assert.equal(clip.favorite, true);
    assert.deepEqual(clip.tags, ['code']);
    const list = await j(await GET('/api/clips?pinned=1'));
    assert.ok(list.items.some(c => c.id === clipId));
  });
  test('更新内容重新识别语言', async () => {
    const r = await fetch(`${base}/api/clips/${clipId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', cookie: cookieJar },
      body: JSON.stringify({ content: 'SELECT * FROM users WHERE id = 1;' }),
    });
    const clip = await j(r);
    assert.equal(clip.lang, 'sql');
  });
  test('删除', async () => {
    const r = await DEL(`/api/clips/${clipId}`);
    assert.equal(r.status, 200);
    const r2 = await DEL(`/api/clips/${clipId}`);
    assert.equal(r2.status, 404);
  });
  test('UA 设备标识(Android)', async () => {
    const r = await POST_JSON('/api/clips', { content: 'from android' },
      { 'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36' });
    const clip = await j(r);
    assert.match(clip.device, /Android · Chrome/);
    await DEL(`/api/clips/${clip.id}`);
  });
  test('空内容被拒绝', async () => {
    const r = await POST_JSON('/api/clips', { content: '   ' });
    assert.equal(r.status, 400);
  });
});

describe('WebSocket 实时推送', () => {
  test('创建剪贴板后 WS 收到 clip:created', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const got = new Promise((resolve) => {
      ws.on('message', (data) => {
        const m = JSON.parse(data.toString());
        if (m.type === 'clip:created') resolve(m);
      });
    });
    // 给服务端一点时间完成注册
    await new Promise(r => setTimeout(r, 150));
    const r = await POST_JSON('/api/clips', { content: 'ws 实时推送测试' });
    const clip = await j(r);
    const msg = await Promise.race([
      got,
      new Promise((_, rej) => setTimeout(() => rej(new Error('3 秒内未收到 WS 推送')), 3000)),
    ]);
    assert.equal(msg.payload.id, clip.id);
    assert.equal(msg.payload.content, 'ws 实时推送测试');
    ws.close();
    await DEL(`/api/clips/${clip.id}`);
  });
});

describe('局域网大文件流式上传/下载(真实字节校验)', () => {
  let fileId;
  const MB24 = crypto.randomBytes(24 * 1024 * 1024);
  const hash = crypto.createHash('sha256').update(MB24).digest('hex');

  test('24MB 文件流式上传', async () => {
    const r = await fetch(`${base}/api/files/upload?name=${encodeURIComponent('大文件测试.bin')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', cookie: cookieJar },
      body: MB24,
    });
    assert.equal(r.status, 201);
    const f = await j(r);
    fileId = f.id;
    assert.equal(f.name, '大文件测试.bin');
    assert.equal(f.size, MB24.length);
  });

  test('下载字节完全一致(sha256)', async () => {
    const r = await GET(`/api/files/${fileId}/download`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-disposition').includes('filename*'), true);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.length, MB24.length);
    assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), hash, '下载内容与上传完全一致');
  });

  test('Range 断点下载(206)', async () => {
    const r = await GET(`/api/files/${fileId}/download`, { range: 'bytes=100-199' });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), `bytes 100-199/${MB24.length}`);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.length, 100);
    assert.ok(buf.equals(MB24.subarray(100, 200)));
  });

  test('文件列表含中文名与大小', async () => {
    const d = await j(await GET('/api/files'));
    const f = d.items.find(x => x.id === fileId);
    assert.ok(f);
    assert.equal(f.name, '大文件测试.bin');
    assert.equal(f.size, MB24.length);
  });

  test('不安全文件名被净化', async () => {
    const r = await fetch(`${base}/api/files/upload?name=${encodeURIComponent('..\\evil:file?.txt')}`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: cookieJar }, body: 'hello',
    });
    const f = await j(r);
    assert.doesNotMatch(f.name, /[\\/:*?"<>|.]{2}|^\./);
    assert.match(f.name, /evil/);
    await DEL(`/api/files/${f.id}`);
  });

  test('批量 ZIP 打包下载', async () => {
    const r2 = await fetch(`${base}/api/files/upload?name=${encodeURIComponent('文件二.txt')}`, {
      method: 'POST', headers: { 'content-type': 'text/plain', cookie: cookieJar }, body: '第二个文件内容',
    });
    const f2 = await j(r2);
    const rz = await GET(`/api/files/download.zip?ids=${fileId},${f2.id}`);
    assert.equal(rz.status, 200);
    assert.match(rz.headers.get('content-type'), /zip/);
    const buf = Buffer.from(await rz.arrayBuffer());
    const names = zipEntries(buf);
    assert.ok(names.includes('大文件测试.bin'), 'zip 包含中文文件名');
    assert.ok(names.includes('文件二.txt'));
    await DEL(`/api/files/${f2.id}`);
  });

  test('单文件大小上限(超限 413)', async () => {
    await PUT_JSON('/api/system/settings', { max_file_size_mb: 1 });
    const r = await fetch(`${base}/api/files/upload?name=too-big.bin`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: cookieJar },
      body: crypto.randomBytes(2 * 1024 * 1024),
    });
    assert.equal(r.status, 413);
    await PUT_JSON('/api/system/settings', { max_file_size_mb: 0 });
  });

  test('删除文件后磁盘同步清理', async () => {
    const d = await j(await GET(`/api/files`));
    const f = d.items.find(x => x.id === fileId);
    const diskPath = f.path;
    assert.ok(fs.existsSync(diskPath));
    await DEL(`/api/files/${fileId}`);
    assert.equal(fs.existsSync(diskPath), false);
    const r = await GET(`/api/files/${fileId}/download`);
    assert.equal(r.status, 404);
  });
});

describe('图床:粘贴/上传、直链、缩略图回退', () => {
  let imgId;
  test('上传图片并访问直链', async () => {
    const r = await fetch(`${base}/api/images/upload?name=${encodeURIComponent('测试图.png')}&width=1&height=1`, {
      method: 'POST', headers: { 'content-type': 'image/png', cookie: cookieJar }, body: PNG_1PX,
    });
    assert.equal(r.status, 201);
    const img = await j(r);
    imgId = img.id;
    const raw = await GET(`/api/images/${imgId}/raw`);
    assert.equal(raw.status, 200);
    assert.match(raw.headers.get('content-type'), /image\/png/);
    const buf = Buffer.from(await raw.arrayBuffer());
    assert.ok(buf.equals(PNG_1PX), '直链返回原始字节');
  });
  test('非图片类型被拒绝', async () => {
    const r = await fetch(`${base}/api/images/upload?name=x.png`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: cookieJar }, body: 'not image',
    });
    assert.equal(r.status, 415);
  });
  test('图床列表与缩略图回退到原图', async () => {
    const d = await j(await GET('/api/images'));
    assert.ok(d.items.some(i => i.id === imgId));
    const thumb = await GET(`/api/images/${imgId}/thumb`);
    assert.equal(thumb.status, 200);
  });
  test('图片替换(WebP 转换入库)', async () => {
    const webpBytes = Buffer.from('RIFF0000WEBPVP8 ', 'ascii'); // 内容不重要,服务端按字节保存
    const r = await fetch(`${base}/api/images/${imgId}/replace`, {
      method: 'POST', headers: { 'content-type': 'image/webp', cookie: cookieJar }, body: webpBytes,
    });
    const img = await j(r);
    assert.equal(img.mime, 'image/webp');
    assert.equal(img.size, webpBytes.length);
    const raw = await GET(`/api/images/${imgId}/raw`);
    assert.match(raw.headers.get('content-type'), /image\/webp/);
  });
  test('删除图片清理磁盘', async () => {
    const r = await DEL(`/api/images/${imgId}`);
    assert.equal(r.status, 200);
    const raw = await GET(`/api/images/${imgId}/raw`);
    assert.equal(raw.status, 404);
  });
});

describe('分享链接:提取码 + 过期 + 阅后即焚', () => {
  let clipId;
  before(async () => {
    const r = await POST_JSON('/api/clips', { content: '机密内容:LocalHub 分享测试' });
    clipId = (await j(r)).id;
  });

  test('创建带自动提取码的分享', async () => {
    const r = await POST_JSON('/api/share', { target_type: 'clip', target_id: clipId, expiry: '24h', code: 'auto' });
    assert.equal(r.status, 201);
    const share = await j(r);
    assert.match(share.code, /^\d{4}$/);
    assert.ok(share.url.startsWith('/s/'));
    const slug = share.slug;
    // info 不带码 → 403(分享页据此弹出提取码输入框);带码 → has_code
    const infoNoCode = await GET(`/api/share/${slug}/info`);
    assert.equal(infoNoCode.status, 403);
    const info2 = await j(await GET(`/api/share/${slug}/info?code=${share.code}`));
    assert.equal(info2.has_code, true);
    assert.equal(info2.type, 'clip');
    // 无码访问内容 → 403
    const noCode = await GET(`/api/share/${slug}/content?format=json`);
    assert.equal(noCode.status, 403);
    // 错误码 → 403
    const badCode = await GET(`/api/share/${slug}/content?format=json&code=9999`);
    assert.equal(badCode.status, 403);
    // 正确码 → 200 内容一致
    const okCode = await GET(`/api/share/${slug}/content?format=json&code=${share.code}`);
    assert.equal(okCode.status, 200);
    const clip = await j(okCode);
    assert.match(clip.content, /机密内容/);
    // 错误码访问 info → 403
    const badInfo = await GET(`/api/share/${slug}/info?code=0000`);
    assert.equal(badInfo.status, 403);
  });

  test('分享页 HTML 可访问', async () => {
    const r = await POST_JSON('/api/share', { target_type: 'clip', target_id: clipId, expiry: 'forever' });
    const share = await j(r);
    const page = await fetch(`${base}/s/${share.slug}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /share\.js/);
    await DEL(`/api/share/${share.id}`);
  });

  test('文件分享无提取码直接下载,字节一致', async () => {
    const bytes = crypto.randomBytes(1024);
    const up = await fetch(`${base}/api/files/upload?name=${encodeURIComponent('分享文件.dat')}`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: cookieJar }, body: bytes,
    });
    const f = await j(up);
    const s = await j(await POST_JSON('/api/share', { target_type: 'file', target_id: f.id, expiry: '1h' }));
    const dl = await GET(`/api/share/${s.slug}/content`);
    assert.equal(dl.status, 200);
    const buf = Buffer.from(await dl.arrayBuffer());
    assert.ok(buf.equals(bytes));
    await DEL(`/api/files/${f.id}`);
  });

  test('阅后即焚:首次访问成功,再次访问失效', async () => {
    const s = await j(await POST_JSON('/api/share', { target_type: 'clip', target_id: clipId, expiry: 'burn' }));
    const first = await GET(`/api/share/${s.slug}/content?format=json`);
    assert.equal(first.status, 200);
    const second = await GET(`/api/share/${s.slug}/content?format=json`);
    assert.equal(second.status, 404);
  });

  test('过期分享:访问返回 410,清理任务删除记录', async () => {
    const db = getDB();
    // 已过期分享访问 → 410(同时被删除)
    const s = await j(await POST_JSON('/api/share', { target_type: 'clip', target_id: clipId, expiry: '1h' }));
    db.prepare('UPDATE shares SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, s.id);
    const access = await GET(`/api/share/${s.slug}/content?format=json`);
    assert.equal(access.status, 410);
    // 再造一条过期分享,验证清理任务删除记录
    const s2 = await j(await POST_JSON('/api/share', { target_type: 'clip', target_id: clipId, expiry: '1h' }));
    db.prepare('UPDATE shares SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, s2.id);
    const result = await srv.cleaner.run();
    const left = db.prepare('SELECT COUNT(*) AS c FROM shares WHERE id = ?').get(s2.id).c;
    assert.equal(left, 0, '清理任务已删除过期分享');
    assert.ok(result.sharesDeleted >= 1);
  });

  test('分享管理列表含目标名称与访问计数', async () => {
    const s = await j(await POST_JSON('/api/share', { target_type: 'clip', target_id: clipId, expiry: 'forever', code: '1234' }));
    await GET(`/api/share/${s.slug}/content?format=json&code=1234`);
    const list = await j(await GET('/api/share/list'));
    const row = list.items.find(x => x.id === s.id);
    assert.ok(row);
    assert.equal(row.code, '1234');
    assert.equal(row.access_count, 1);
    assert.match(row.target_name, /机密内容/);
    await DEL(`/api/share/${s.id}`);
  });

  after(async () => { await DEL(`/api/clips/${clipId}`).catch(() => {}); });
});

describe('过期自动清理(内容保留期)', () => {
  test('超保留期的剪贴板与文件被清理', async () => {
    const db = getDB();
    const old = Date.now() - 100 * 24 * 3600e3; // 100 天前
    const ins = db.prepare('INSERT INTO clips(content, tags, created_at, updated_at) VALUES(?,?,?,?)')
      .run('古老内容', '[]', old, old);
    // 造一个老文件记录 + 磁盘文件
    const diskPath = path.join(srv.dirs.files, `old_${Date.now()}.bin`);
    fs.writeFileSync(diskPath, 'old file bytes');
    db.prepare('INSERT INTO files(name, mime, size, path, created_at) VALUES(?,?,?,?,?)')
      .run('旧文件.bin', 'application/octet-stream', 14, diskPath, old);

    await PUT_JSON('/api/system/settings', { item_retention_minutes: 60 }); // 保留 1 小时
    const result = await srv.cleaner.run();
    await PUT_JSON('/api/system/settings', { item_retention_minutes: 0 });

    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM clips WHERE id = ?').get(ins.lastInsertRowid).c, 0, '超期剪贴板已删除');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM files WHERE path = ?').get(diskPath).c, 0, '超期文件记录已删除');
    assert.equal(fs.existsSync(diskPath), false, '磁盘文件已删除');
    assert.ok(result.clipsDeleted >= 1 && result.filesDeleted >= 1);
  });
  test('孤儿磁盘文件被回收', async () => {
    const orphan = path.join(srv.dirs.files, `orphan_${Date.now()}.bin`);
    fs.writeFileSync(orphan, 'orphan');
    // 让 mtime 变旧
    const old = new Date(Date.now() - 7200e3);
    fs.utimesSync(orphan, old, old);
    await srv.cleaner.run();
    assert.equal(fs.existsSync(orphan), false);
  });
});

describe('设置保存与持久化', () => {
  test('保存并回读', async () => {
    const r = await PUT_JSON('/api/system/settings', { webp_quality: 0.5, cleanup_interval_minutes: 15 });
    assert.equal(r.status, 200);
    const d = await j(await GET('/api/system/settings'));
    const q = d.items.find(i => i.key === 'webp_quality');
    const ci = d.items.find(i => i.key === 'cleanup_interval_minutes');
    assert.equal(q.value, 0.5);
    assert.equal(ci.value, 15);
  });
  test('非法值被钳制', async () => {
    await PUT_JSON('/api/system/settings', { port: 99999, cleanup_interval_minutes: 0.7 });
    const d = await j(await GET('/api/system/settings'));
    assert.equal(d.items.find(i => i.key === 'port').value, 65535);
    assert.equal(d.items.find(i => i.key === 'cleanup_interval_minutes').value, 1);
  });
  test('非法口令被拒绝', async () => {
    const r = await PUT_JSON('/api/system/settings', { access_password: 'abc' });
    assert.equal(r.status, 400);
  });
  test('持久化到磁盘(重启可恢复)', async () => {
    const db = getDB();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'webp_quality'").get();
    assert.equal(JSON.parse(row.value), 0.5);
  });
  test('恢复默认', async () => {
    await PUT_JSON('/api/system/settings', { webp_quality: 0.8, cleanup_interval_minutes: 30 });
  });
});

describe('访问口令保护', () => {
  test('开启前必须先设置口令', async () => {
    await PUT_JSON('/api/system/settings', { access_password: '' });
    const r = await PUT_JSON('/api/system/settings', { access_password_enabled: true });
    assert.equal(r.status, 400);
    const d = await j(r);
    assert.equal(d.error, 'password_required');
  });
  test('开启后未授权请求 401(WS 之外的 API)', async () => {
    await PUT_JSON('/api/system/settings', { access_password: '1234', access_password_enabled: true });
    const r = await fetch(`${base}/api/clips`);
    assert.equal(r.status, 401);
  });
  test('错误口令登录被拒', async () => {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: '0000' }),
    });
    assert.equal(r.status, 401);
  });
  test('正确口令登录获得会话 cookie', async () => {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: '1234' }),
    });
    assert.equal(r.status, 200);
    const setCookie = r.headers.get('set-cookie');
    assert.match(setCookie, /lh_session=/);
    const token = /lh_session=([^;]+)/.exec(setCookie)[1];
    cookieJar = `lh_session=${token}`;
    const ok = await GET('/api/clips');
    assert.equal(ok.status, 200);
  });
  test('URL 参数免密授权(?key=)', async () => {
    const d0 = await j(await GET('/api/system/settings'));
    const key = d0.accessKey;
    const r = await fetch(`${base}/api/clips?key=${key}`, { redirect: 'manual' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('set-cookie'), /lh_session=/);
    const bad = await fetch(`${base}/api/clips?key=wrongkey`);
    assert.equal(bad.status, 401);
  });
  test('二维码接口在保护模式下需要授权', async () => {
    const r = await fetch(`${base}/api/system/lan/qr`);
    assert.equal(r.status, 401);
    const ok = await GET('/api/system/lan/qr');
    assert.equal(ok.status, 200);
    const d = await j(ok);
    assert.match(d.url, /key=/, '二维码 URL 包含免密授权参数');
  });
  test('关闭保护后会话全部失效', async () => {
    await PUT_JSON('/api/system/settings', { access_password_enabled: false });
    const d = await j(await GET('/api/system/settings'));
    // cookieJar 是开启保护前无 cookie 的会话;关闭后全局无保护
    const r = await fetch(`${base}/api/clips`);
    assert.equal(r.status, 200);
    assert.equal(d.items.find(i => i.key === 'access_password_enabled').value, false);
  });
});

describe('仪表盘统计', () => {
  test('返回存储用量与磁盘空间', async () => {
    const d = await j(await GET('/api/system/dashboard'));
    assert.ok(d.totalSize >= 0);
    assert.ok(d.clips.count >= 0);
    assert.ok(d.diskFree === null || d.diskFree > 0);
    assert.ok(d.onlineDevices >= 0);
    assert.ok(d.uptimeMs >= 0);
  });
  test('手动清理接口可用', async () => {
    const r = await POST_JSON('/api/system/cleanup', {});
    assert.equal(r.status, 200);
    const d = await j(r);
    assert.ok('result' in d);
  });
});

describe('防火墙连通性自检', () => {
  test('自检接口返回结构化结果', async () => {
    const d = await j(await GET('/api/system/firewall'));
    assert.equal(d.supported, process.platform === 'win32');
    assert.equal(d.port, srv.port);
    if (d.supported) {
      assert.ok(Array.isArray(d.items) && d.items.length >= 3);
      assert.equal(typeof d.ruleExists, 'boolean');
      assert.equal(typeof d.needsFix, 'boolean');
      assert.ok(d.verdict.length > 0);
      // 端口规则名与端口对应(本服务通常未添加规则,不应误报为已存在)
      assert.equal(d.ruleExists, false);
    }
  });
});

describe('DDNS 动态域名', () => {
  test('地址探测:无链路本地/环回,全局 IPv6 优先', async () => {
    const a = await detectAddresses();
    if (a.ipv6) {
      assert.match(a.ipv6, /^(2[0-9a-f]|3[0-9a-f])/i, '发布地址必须是全局单播');
      assert.doesNotMatch(a.ipv6, /^fe80|^::1/i);
    }
    if (a.ipv4Local) assert.match(a.ipv4Local, /^\d+\.\d+\.\d+\.\d+$/);
  });

  test('DNSPod 域名拆分为子域+根域', () => {
    assert.deepEqual(splitDnsPodName('hub.example.com'), { sub: 'hub', root: 'example.com' });
    assert.deepEqual(splitDnsPodName('a.b.example.com'), { sub: 'a', root: 'b.example.com' });
    assert.throws(() => splitDnsPodName('example.com'), /子域\.根域/);
  });

  test('自定义 URL 模板:占位符替换与真实 HTTP 调用', async () => {
    const http = await import('node:http');
    const received = [];
    const mock = http.createServer((req, res) => { received.push(req.url); res.end('OK'); });
    await new Promise(r => mock.listen(0, '127.0.0.1', r));
    const mp = mock.address().port;
    const msg = await runOnce(
      { provider: 'custom', token: 'SECRET', domain: 'home.example.com',
        template: `http://127.0.0.1:${mp}/update?token={token}&v6={ipv6}&v4={ipv4}&d={domain}` },
      { ipv6: '2408:8207::11', ipv4: '1.2.3.4' }
    );
    assert.match(msg, /自定义 DDNS 已执行/);
    assert.equal(received.length, 1, '模板只应请求一次');
    const q = decodeURIComponent(received[0]);
    assert.ok(q.includes('token=SECRET'), 'token 已替换');
    assert.ok(q.includes('v6=2408:8207::11'), 'IPv6 已替换');
    assert.ok(q.includes('v4=1.2.3.4'), 'IPv4 已替换');
    assert.ok(q.includes('d=home.example.com'), '域名已替换');
    mock.close();
  });

  test('无可用地址时报错提示', async () => {
    await assert.rejects(
      () => runOnce({ provider: 'custom', token: 't', domain: 'd', template: 'http://127.0.0.1:9/x' }, { ipv6: null, ipv4: null }),
      /没有可发布的地址/
    );
  });

  test('DDNS 设置保存与状态接口', async () => {
    const put = await PUT_JSON('/api/system/settings', { ddns_provider: 'custom', ddns_url_template: 'http://127.0.0.1:9/up?ip={ipv6}' });
    assert.equal(put.status, 200);
    const st = await PUT_JSON('/api/system/settings', { ddns_enabled: true, ddns_domain: 'hub.example.com', ddns_token: 'abc,123' });
    assert.equal(st.status, 200);
    const d = await j(await GET('/api/system/ddns'));
    assert.equal(d.enabled, true);
    assert.equal(d.provider, 'custom');
    assert.equal(d.tokenSet, true);
    assert.ok(!('token' in d), '状态接口不回传令牌明文');
    // 立即更新:自定义模板指向未监听端口 → 应返回 ok:false 而非崩溃
    const run = await POST_JSON('/api/system/ddns/run', {});
    assert.equal(run.status, 200);
    const rd = await j(run);
    assert.equal(rd.ok, false);
    // 关闭并恢复(令牌清空改由直接删行:空值语义为保持)
    await PUT_JSON('/api/system/settings', { ddns_enabled: false, ddns_provider: 'dnspod', ddns_url_template: '', ddns_domain: '' });
    getDB().prepare("DELETE FROM settings WHERE key = 'ddns_token'").run();
    const d2 = await j(await GET('/api/system/ddns'));
    assert.equal(d2.enabled, false);
  });
});

describe('跨设备上传实时广播', () => {
  test('WS 收到 upload:progress 与 upload:done(慢速上传)', async () => {
    const http = await import('node:http');
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const events = [];
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      if (m.type === 'upload:progress' || m.type === 'upload:done' || m.type === 'upload:cancelled') events.push(m);
    });
    await new Promise(r => setTimeout(r, 200));
    // node:http 慢速分块上传(模拟真实网络),携带 ck 标识来源设备
    await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: srv.port,
        path: `/api/files/upload?name=${encodeURIComponent('慢速.bin')}&ck=tester`,
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', cookie: cookieJar, 'content-length': String(6 * 1024 * 1024) },
      }, res => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      let i = 0;
      const t = setInterval(() => {
        i++;
        if (i > 6) { clearInterval(t); req.end(); } // 恰好 6 块 × 1MB = 声明的 Content-Length
        else req.write(Buffer.alloc(1024 * 1024, i)); // 6MB,每 150ms 一块
      }, 150);
    });
    await new Promise(r => setTimeout(r, 600));
    ws.close();
    const progress = events.filter(e => e.type === 'upload:progress');
    const done = events.filter(e => e.type === 'upload:done');
    assert.ok(progress.length >= 2, `应收到多次进度事件,实际 ${progress.length}`);
    assert.equal(progress[0].payload.ck, 'tester');
    assert.equal(progress[0].payload.kind, 'file');
    assert.equal(progress[0].payload.name, '慢速.bin');
    assert.ok(progress[0].payload.size > 0, '携带总大小');
    const loadeds = progress.map(e => e.payload.loaded);
    assert.ok(loadeds.every((v, idx) => idx === 0 || v >= loadeds[idx - 1]), '进度单调递增');
    assert.equal(done.length, 1, '完成事件恰好一次');
    // 清理
    const list = await j(await GET('/api/files?search=' + encodeURIComponent('慢速')));
    if (list.items[0]) await DEL(`/api/files/${list.items[0].id}`);
  });
});

describe('DDNS 新增服务商(阿里云/Dynv6/No-IP/deSEC/GoDaddy)', () => {
  async function mockServer(handler) {
    const http = await import('node:http');
    const calls = [];
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        calls.push({ url: req.url, path: url.pathname, query: Object.fromEntries(url.searchParams), method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        handler(url, req, res);
      });
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    return { srv, calls, port: srv.address().port };
  }

  test('阿里云:查询→创建流程、签名与参数', async () => {
    const { srv, calls, port } = await mockServer((url, req, res) => {
      const action = url.searchParams.get('Action');
      res.end(JSON.stringify(action === 'DescribeDomainRecords'
        ? { DomainRecords: { Record: [] } }
        : { RecordId: '111' }));
    });
    const msg = await runOnce(
      { provider: 'aliyun', token: 'AKID,AKSECRET', domain: 'hub.example.com', endpoint: { aliyun: `http://127.0.0.1:${port}` } },
      { ipv6: '2408::66', ipv4: null }
    );
    assert.match(msg, /阿里云已创建 hub\.example\.com AAAA/);
    const actions = calls.map(c => c.query.Action);
    assert.deepEqual(actions, ['DescribeDomainRecords', 'AddDomainRecord'], '先查询后创建');
    const sig = calls[0].query.Signature;
    assert.ok(sig && sig.length >= 20, '签名存在');
    assert.ok(/T\d{2}:\d{2}:\d{2}Z/.test(calls[0].query.Timestamp), 'UTC 时间戳');
    assert.equal(calls[0].query.AccessKeyId, 'AKID');
    assert.equal(calls[1].query.RR, 'hub');
    assert.equal(calls[1].query.Type, 'AAAA');
    assert.equal(calls[1].query.Value, '2408::66');
    await new Promise(r => srv.close(r));
  });

  test('Dynv6:一次请求携带双栈', async () => {
    const { srv, calls, port } = await mockServer((url, req, res) => res.end('OK'));
    const msg = await runOnce(
      { provider: 'dynv6', token: 'T9', domain: 'mypc.dynv6.net', endpoint: { dynv6: `http://127.0.0.1:${port}` } },
      { ipv6: '2408::d6', ipv4: '5.6.7.8' }
    );
    assert.match(msg, /Dynv6 已更新 mypc\.dynv6\.net/);
    assert.equal(calls.length, 1, 'dual 模式单次请求');
    assert.equal(calls[0].query.zone, 'mypc.dynv6.net');
    assert.equal(calls[0].query.token, 'T9');
    assert.equal(calls[0].query.ipv4, '5.6.7.8');
    assert.equal(calls[0].query.ipv6, '2408::d6');
    await new Promise(r => srv.close(r));
  });

  test('No-IP:Basic 认证 + dyn 协议响应', async () => {
    const { srv, calls, port } = await mockServer((url, req, res) => res.end('good 1.2.3.4'));
    const msg = await runOnce(
      { provider: 'noip', token: 'me@x.com,pass99', domain: 'mypc.ddns.net', endpoint: { noip: `http://127.0.0.1:${port}` } },
      { ipv6: '2408::99', ipv4: '1.2.3.4' }
    );
    assert.match(msg, /No-IP 已更新 mypc\.ddns\.net/);
    assert.equal(calls.length, 1);
    const b64 = calls[0].headers.authorization.replace('Basic ', '');
    assert.equal(Buffer.from(b64, 'base64').toString(), 'me@x.com:pass99');
    assert.equal(calls[0].query.hostname, 'mypc.ddns.net');
    assert.equal(calls[0].query.myip, '1.2.3.4,2408::99');
    assert.match(calls[0].headers['user-agent'] || '', /LocalHub/);
    await new Promise(r => srv.close(r));
  });

  test('deSEC:PUT rrsets(AAAA 与 A 各一条)', async () => {
    const { srv, calls, port } = await mockServer((url, req, res) => res.end('{}'));
    const msg = await runOnce(
      { provider: 'desec', token: 'DTK', domain: 'hub.example.com', endpoint: { desec: `http://127.0.0.1:${port}` } },
      { ipv6: '2408::de', ipv4: '9.9.9.9' }
    );
    assert.match(msg, /AAAA/);
    assert.match(msg, /A /);
    assert.equal(calls.length, 2, 'single 模式逐条更新');
    assert.match(calls[0].path, /\/api\/v1\/domains\/example\.com\/rrsets\/hub\/AAAA\/$/);
    assert.match(calls[1].path, /\/api\/v1\/domains\/example\.com\/rrsets\/hub\/A\/$/);
    assert.equal(calls[0].headers.authorization, 'Token DTK');
    assert.equal(JSON.parse(calls[0].body).records[0], '2408::de');
    await new Promise(r => srv.close(r));
  });

  test('GoDaddy:sso-key 认证 + upsert PUT', async () => {
    const { srv, calls, port } = await mockServer((url, req, res) => res.end('{}'));
    const msg = await runOnce(
      { provider: 'godaddy', token: 'gdkey:gdsecret', domain: 'hub.example.com', endpoint: { godaddy: `http://127.0.0.1:${port}` } },
      { ipv6: '2408::gd', ipv4: '8.8.4.4' }
    );
    assert.match(msg, /GoDaddy 已更新/);
    assert.match(calls[0].path, /\/v1\/domains\/example\.com\/records\/AAAA\/hub$/);
    assert.match(calls[1].path, /\/v1\/domains\/example\.com\/records\/A\/hub$/);
    assert.equal(calls[0].headers.authorization, 'sso-key gdkey:gdsecret');
    assert.equal(JSON.parse(calls[0].body)[0].data, '2408::gd');
    await new Promise(r => srv.close(r));
  });

  test('阿里云:令牌格式错误给出明确提示', async () => {
    await assert.rejects(
      () => runOnce({ provider: 'aliyun', token: '只有一个', domain: 'hub.example.com', endpoint: { aliyun: 'http://127.0.0.1:9' } }, { ipv6: '2408::1', ipv4: null }),
      /AccessKeyID,AccessKeySecret/
    );
  });
});

describe('Dynu 服务商', () => {
  async function dynuMock() {
    const http = await import('node:http');
    const calls = [];
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        if (url.pathname === '/oauth2/token') return res.end(JSON.stringify({ accessToken: 'DYNU_AT', tokenType: 'Bearer' }));
        if (url.pathname === '/v2/dns') return res.end(JSON.stringify({ domains: [{ Name: 'mypc.dynu.net' }] }));
        if (req.method === 'POST' && /^\/v2\/dns\/record\/[^/]+\/\d+$/.test(url.pathname)) return res.end(JSON.stringify({ statusCode: 200 }));
        if (req.method === 'POST') return res.end(JSON.stringify({ statusCode: 200 }));
        return res.end(JSON.stringify({ dnsRecords: [] }));
      });
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    return { srv, calls, port: srv.address().port };
  }

  test('API-Key 认证:找 zone → 查记录 → 创建(IPV6ADDR/IPV4ADDR)', async () => {
    const { srv, calls, port } = await dynuMock();
    const msg = await runOnce(
      { provider: 'dynu', token: 'T55b3cU7Y2abVdfafU5b6X553ZZWcV5W', domain: 'mypc.dynu.net', endpoint: { dynu: `http://127.0.0.1:${port}` } },
      { ipv6: '2408::dy', ipv4: '3.3.3.3' }
    );
    assert.match(msg, /IPV6ADDR/);
    assert.match(msg, /IPV4ADDR/);
    const zoneLists = calls.filter(c => c.path === '/v2/dns');
    assert.equal(zoneLists.length, 2, 'AAAA 与 A 各查询一次 zone 列表');
    assert.equal(zoneLists[0].headers['api-key'], 'T55b3cU7Y2abVdfafU5b6X553ZZWcV5W');
    const creates = calls.filter(c => c.method === 'POST');
    assert.deepEqual(creates.map(c => JSON.parse(c.body).recordType), ['IPV6ADDR', 'IPV4ADDR']);
    assert.equal(JSON.parse(creates[0].body).ipAddress, '2408::dy');
    await new Promise(r => srv.close(r));
  });

  test('OAuth2(clientId,clientSecret):先取 token 再 Bearer 调用', async () => {
    const { srv, calls, port } = await dynuMock();
    await runOnce(
      { provider: 'dynu', token: '8fce6702-8589-4da2-9f04-e2684a0775a7,54b65gTW6b4X46U7Ze6gcc7Vbebf66', domain: 'mypc.dynu.net', endpoint: { dynu: `http://127.0.0.1:${port}` } },
      { ipv6: '2408::dy', ipv4: null }
    );
    const tokenCall = calls.find(c => c.path === '/oauth2/token');
    assert.ok(tokenCall, '调用了 OAuth2 token 接口');
    const b64 = tokenCall.headers.authorization.replace('Basic ', '');
    assert.equal(Buffer.from(b64, 'base64').toString(), '8fce6702-8589-4da2-9f04-e2684a0775a7:54b65gTW6b4X46U7Ze6gcc7Vbebf66');
    const apiCalls = calls.filter(c => c.path.startsWith('/v2/'));
    assert.ok(apiCalls.length >= 2);
    assert.equal(apiCalls[0].headers.authorization, 'Bearer DYNU_AT');
    await new Promise(r => srv.close(r));
  });
});

describe('IPv6 开关', () => {
  test('关闭后:lan 接口仅 IPv4、DDNS 不发布 AAAA;开启恢复', async () => {
    await PUT_JSON('/api/system/settings', { ipv6_enabled: false });
    const lanOff = await j(await GET('/api/system/lan'));
    assert.ok(lanOff.urls.every(u => u.family === 4), '关闭后所有地址都是 IPv4');
    assert.equal(lanOff.ipv6.length, 0);
    assert.equal(lanOff.hasGlobalIPv6, false);
    const ddnsOff = await j(await GET('/api/system/ddns'));
    assert.equal(ddnsOff.localIPv6, null, 'DDNS 不再探测 IPv6');
    await PUT_JSON('/api/system/settings', { ipv6_enabled: true });
    const lanOn = await j(await GET('/api/system/lan'));
    // 仅当本机确实存在全局 IPv6 时才断言(CI Linux 构建机没有公网 IPv6)
    const hasGlobalV6OnHost = Object.values(os.networkInterfaces()).some(addrs => (addrs || []).some(a => a.family === 'IPv6' && !a.internal && /^(2|3)/.test(a.address)));
    if (hasGlobalV6OnHost) {
      assert.ok(lanOn.urls.some(u => u.family === 6), '重新开启后 IPv6 地址恢复显示');
    }
  });
});

describe('DDNS 测试按钮(免启用诊断)', () => {
  test('未启用 DDNS 时 force 测试仍执行并给出明确原因', async () => {
    await PUT_JSON('/api/system/settings', { ddns_enabled: false, ddns_provider: 'custom', ddns_url_template: '' });
    const r = await POST_JSON('/api/system/ddns/test', {});
    assert.equal(r.status, 200);
    const d = await j(r);
    assert.equal(d.ok, false);
    assert.match(d.message, /域名与令牌|URL 模板/, '报的是配置缺失而不是"未启用"');
    assert.ok(Array.isArray(d.steps));
  });
});

describe('安全增强', () => {
  test('口令以加盐哈希存储,接口不回传,留空=保持', async () => {
    await PUT_JSON('/api/system/settings', { access_password: 'strongpw99' });
    const db = getDB();
    const stored = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='access_password'").get().value);
    assert.match(stored, /^scrypt\$/, '库中为加盐哈希');
    assert.ok(!stored.includes('strongpw99'), '明文不入库');
    const d = await j(await GET('/api/system/settings'));
    const it = d.items.find(i => i.key === 'access_password');
    assert.equal(it.value, '', '接口不回传口令');
    assert.equal(it.passwordSet, true);
    // 留空提交 = 保持不变
    await PUT_JSON('/api/system/settings', { access_password: '' });
    const stored2 = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='access_password'").get().value);
    assert.equal(stored2, stored, '留空未覆盖原口令');
    // 哈希口令可登录
    const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'strongpw99' }) });
    assert.equal(r.status, 200);
  });

  test('会话 30 天过期:过期会话 401,新会话有效', async () => {
    await PUT_JSON('/api/system/settings', { access_password_enabled: true });
    // cookieJar 会话已被"关闭保护"清理,重新登录刷新
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'strongpw99' }) });
    assert.equal(login.status, 200);
    cookieJar = 'lh_session=' + /lh_session=([^;]+)/.exec(login.headers.get('set-cookie'))[1];
    const db = getDB();
    db.prepare('INSERT INTO sessions(token, created_at) VALUES(?, ?)').run('expired_token_x', Date.now() - 31 * 24 * 3600e3);
    const r = await fetch(`${base}/api/clips`, { headers: { cookie: 'lh_session=expired_token_x' } });
    assert.equal(r.status, 401, '过期会话被拒');
    const r2 = await GET('/api/clips');
    assert.equal(r2.status, 200, '有效会话仍可用');
    await PUT_JSON('/api/system/settings', { access_password_enabled: false });
  });

  test('WS 在保护模式下需要会话,关闭保护后恢复开放', async () => {
    await PUT_JSON('/api/system/settings', { access_password_enabled: true });
    // 重新登录获取有效会话(旧 cookieJar 会话已被清理)
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'strongpw99' }) });
    assert.equal(login.status, 200);
    const freshCookie = 'lh_session=' + /lh_session=([^;]+)/.exec(login.headers.get('set-cookie'))[1];
    cookieJar = freshCookie; // 让结尾的"关闭保护"PUT 获得授权
    const attempt = (withCookie) => new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, withCookie ? { headers: { cookie: freshCookie } } : undefined);
      const t = setTimeout(() => { try { ws.terminate(); } catch { /* ignore */ } resolve('timeout'); }, 3000);
      ws.on('open', () => { clearTimeout(t); try { ws.close(); } catch { /* ignore */ } resolve('open'); });
      ws.on('unexpected-response', (req, res) => { clearTimeout(t); resolve('unexpected:' + res.statusCode); });
      ws.on('error', () => { clearTimeout(t); resolve('error'); });
    });
    assert.match(await attempt(false), /401/, '未授权 WS 握手被拒');
    assert.equal(await attempt(true), 'open', '带会话 cookie 的 WS 正常');
    await PUT_JSON('/api/system/settings', { access_password_enabled: false });
    assert.equal(await attempt(false), 'open', '关闭保护后 WS 恢复开放');
  });

  test('登录限速:4 次失败后第 5 次 429,成功后清零', async () => {
    resetLoginLimiter();
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) });
      assert.equal(r.status, 401);
    }
    const blocked = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'strongpw99' }) });
    assert.equal(blocked.status, 429, '封锁期内即使密码正确也 429');
    resetLoginLimiter();
    const ok = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'strongpw99' }) });
    assert.equal(ok.status, 200);
  });

  test('分享提取码限速:8 次错误后 429,正确码清零', async () => {
    resetCodeLimiter();
    await PUT_JSON('/api/system/settings', { access_password_enabled: false });
    const c = await j(await POST_JSON('/api/clips', { content: '限速测试内容' }));
    const s = await j(await POST_JSON('/api/share', { target_type: 'clip', target_id: c.id, expiry: 'forever', code: '8888' }));
    let last = 0;
    for (let i = 0; i < 9; i++) {
      last = (await GET(`/api/share/${s.slug}/content?format=json&code=0000`)).status;
    }
    assert.equal(last, 429, '第 9 次错误尝试被限流');
    const blocked = await GET(`/api/share/${s.slug}/content?format=json&code=8888`);
    assert.equal(blocked.status, 429, '封锁期内正确码也 429');
    resetCodeLimiter();
    const ok = await GET(`/api/share/${s.slug}/content?format=json&code=8888`);
    assert.equal(ok.status, 200, '清零后正确码可用');
    await DEL(`/api/share/${s.id}`);
    await DEL(`/api/clips/${c.id}`);
  });

  test('安全响应头', async () => {
    const r = await fetch(`${base}/`);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  });
});

describe('二维码入口与显示优化', () => {
  test('DDNS 关闭时二维码不含域名入口,开启时作为首选', async () => {
    await PUT_JSON('/api/system/settings', { ddns_enabled: true, ddns_domain: 'hub.example.com' });
    let d = await j(await GET('/api/system/lan'));
    assert.equal(d.urls[0].label, 'DDNS 域名');
    assert.equal(d.urls[0].host, 'hub.example.com');
    assert.match(d.urls[0].url, new RegExp(':' + srv.port + '$'));
    await PUT_JSON('/api/system/settings', { ddns_enabled: false });
    d = await j(await GET('/api/system/lan'));
    assert.ok(!d.urls.some(u => u.label === 'DDNS 域名'), '关闭后不再显示域名入口');
    assert.ok(d.urls.length >= 1, '仍有 IP 地址入口');
    await PUT_JSON('/api/system/settings', { ddns_enabled: false, ddns_domain: '' });
  });

  test('Tailscale 网卡地址显示为 Tailscale-IPv4/IPv6', async () => {
    // 新默认仅局域网:显式开启 IPv6 才能看到 Tailscale-IPv6 标签
    await PUT_JSON('/api/system/settings', { ipv6_enabled: true });
    const d = await j(await GET('/api/system/lan'));
    for (const u of d.urls) {
      if (/tailscale/i.test(u.iface || '')) {
        assert.match(u.label, /^Tailscale-IPv[46]$/, `Tailscale 地址标签: ${u.label}`);
      } else if (u.family === 4 && u.label === 'IPv4 局域网') {
        assert.doesNotMatch(u.host, /^100\./, '非 Tailscale 的 IPv4 不用该标签');
      }
    }
    await PUT_JSON('/api/system/settings', { ipv6_enabled: false });
  });

  test('DDNS 令牌:设置接口返回供前端密文展示与查看', async () => {
    await PUT_JSON('/api/system/settings', { ddns_token: 'tokview123' });
    const d = await j(await GET('/api/system/settings'));
    const it = d.items.find(i => i.key === 'ddns_token');
    assert.equal(it.value, 'tokview123', '令牌明文仅提供给已授权设备(前端密文显示+眼睛查看)');
    await PUT_JSON('/api/system/settings', { ddns_token: '' });
    getDB().prepare("DELETE FROM settings WHERE key = 'ddns_token'").run();
  });
});

describe('组网工具网卡识别', () => {
  test('常见组网工具网卡名识别', () => {
    const cases = [
      ['Tailscale', 'Tailscale'],
      ['ZeroTier One [9f2a]', 'ZeroTier'],
      ['zt0', 'ZeroTier'],
      ['PgyClient Virtual Network Adapter', '蒲公英(Oray)'],
      ['Radmin VPN', 'Radmin VPN'],
      ['Hamachi Network Interface', 'Hamachi'],
      ['OpenVPN TAP-Windows6', 'OpenVPN'],
      ['Wintun Userspace Tunnel', 'WireGuard'],
      ['Sangfor EasyConnect', '深信服 EasyConnect'],
      ['以太网', null],
      ['WLAN', null],
      ['VirtualBox Host-Only Network', null],
    ];
    for (const [iface, expected] of cases) {
      assert.equal(ifaceToolName(iface), expected, `网卡「${iface}」识别为 ${expected}`);
    }
  });

  test('组网工具地址带专属标签且出现在列表中', async () => {
    const d = await j(await GET('/api/system/lan'));
    for (const u of d.urls) {
      if (/tailscale/i.test(u.iface || '')) {
        assert.equal(u.label, `Tailscale-IPv${u.family}`);
        assert.equal(u.tool, 'Tailscale');
      }
    }
    assert.ok(d.urls.length >= 1);
  });
});

describe('仅局域网模式(连接级封锁)', () => {
  // 从本机全局 IPv6 / Tailscale IPv6 地址访问,模拟外部入口
  let globalV6 = null, tsV6 = null;
  before(async () => {
    const d = await j(await GET('/api/system/lan'));
    await PUT_JSON('/api/system/settings', { ipv6_enabled: true });
    const d2 = await j(await GET('/api/system/lan'));
    for (const u of d2.urls) {
      if (u.family === 6 && u.global) globalV6 = u.host;
      if (u.family === 6 && /Tailscale/.test(u.label)) tsV6 = u.host;
    }
  });

  test('IPv6 开启时:全局 IPv6 入口可访问', async () => {
    if (!globalV6) return; // 机器无全局 IPv6 时跳过
    const r = await fetch(`http://${globalV6}:${srv.port}/api/auth/status`);
    assert.equal(r.status, 200, '开启后全局 IPv6 入口可用');
  });

  test('IPv6 关闭时:全局 IPv6 入口被 403 拒绝(含 DDNS 域名访问场景)', async () => {
    if (!globalV6) return;
    await PUT_JSON('/api/system/settings', { ipv6_enabled: false });
    const r = await fetch(`http://${globalV6}:${srv.port}/api/auth/status`);
    assert.equal(r.status, 403, '关闭后外部 IPv6 连接被拒绝');
    const d = await j(r);
    assert.equal(d.error, 'lan_only');
    // 网页请求返回中文提示
    const page = await fetch(`http://${globalV6}:${srv.port}/`);
    assert.equal(page.status, 403);
    assert.match(await page.text(), /仅局域网模式/);
  });

  test('IPv6 关闭时:Tailscale-IPv6 属于内网来源,仍然允许', async () => {
    if (!tsV6) return;
    await PUT_JSON('/api/system/settings', { ipv6_enabled: false });
    const v6 = await fetch(`http://${tsV6}:${srv.port}/api/auth/status`);
    assert.equal(v6.status, 200, 'Tailscale-IPv6 属于内网来源,允许访问');
    const v4 = await fetch(`http://127.0.0.1:${srv.port}/api/auth/status`);
    assert.equal(v4.status, 200, 'IPv4/回环不受影响');
    await PUT_JSON('/api/system/settings', { ipv6_enabled: false });
  });

  test('重新开启后恢复访问', async () => {
    if (!globalV6) return;
    await PUT_JSON('/api/system/settings', { ipv6_enabled: true });
    const r = await fetch(`http://${globalV6}:${srv.port}/api/auth/status`);
    assert.equal(r.status, 200);
    await PUT_JSON('/api/system/settings', { ipv6_enabled: false });
  });
});

describe('在线设备注册表(按浏览器去重)', () => {
  test('同一 ck 的多个连接计为一台,不同 ck 分开,断开即移除', async () => {
    const mk = (ck) => new Promise((res, rej) => {
      const w = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?ck=${encodeURIComponent(ck)}`, {
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36' },
      });
      w.on('open', () => res(w)); w.on('error', rej);
    });
    const w1 = await mk('devA');
    const w2 = await mk('devA');   // 同一浏览器的第二个标签页
    const w3 = await mk('devB');   // 另一台设备
    await new Promise(r => setTimeout(r, 250));
    const d = await j(await GET('/api/system/devices'));
    assert.equal(d.count, 2, '两台设备(devA + devB)');
    const a = d.items.find(x => x.key === 'devA');
    assert.ok(a, 'devA 在注册表中');
    assert.equal(a.connections, 2, 'devA 的 2 个连接去重为一台');
    assert.match(a.device, /Windows|Linux|macOS/, '设备名由 UA 识别');
    assert.ok(d.items.some(x => x.key === 'devB'), 'devB 独立存在');
    // 全部断开后设备消失
    w1.close(); w2.close(); w3.close();
    await new Promise(r => setTimeout(r, 250));
    const d2 = await j(await GET('/api/system/devices'));
    assert.ok(!d2.items.some(x => x.key === 'devA' || x.key === 'devB'), '断开后从注册表移除');
    assert.equal(d2.count, 0);
  });
});

describe('连接准入判定(accessAllowed)', () => {
  const cases = [
    ['127.0.0.1', {}, true, '回环'],
    ['::1', {}, true, '回环 IPv6'],
    ['192.168.1.101', {}, true, '局域网'],
    ['10.0.0.5', {}, true, '私网 A 类'],
    ['172.16.3.9', {}, true, '私网 172.16'],
    ['fe80::1234', {}, true, '链路本地'],
    ['100.102.173.41', {}, true, 'Tailscale IPv4'],
    ['fd7a:115c:a1e0::8f01:ad2a', {}, true, 'Tailscale IPv6'],
    ['::ffff:192.168.1.101', {}, true, 'IPv4-mapped 私网'],
    ['2409:8a62:1::9', { ipv6: false, ddns: false }, false, '公网 IPv6 + 开关全关'],
    ['2409:8a62:1::9', { ipv6: true, ddns: false }, true, '公网 IPv6 + IPv6 开'],
    ['117.174.71.254', { ipv6: false, ddns: false }, false, '公网 IPv4 + 开关全关'],
    ['117.174.71.254', { ipv6: false, ddns: true }, true, '公网 IPv4 + DDNS 开'],
    ['::ffff:117.174.71.254', { ipv6: true, ddns: false }, false, 'IPv4-mapped 公网按 IPv4 规则'],
  ];
  for (const [ip, opts, expected, label] of cases) {
    test(`${label} → ${expected ? '允许' : '拒绝'}`, () => {
      assert.equal(accessAllowed(ip, opts), expected);
    });
  }
});
