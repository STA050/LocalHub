'use strict';
const crypto = require('crypto');
const { getDB } = require('./db');
const { shortId } = require('./util');

/** 口令加盐哈希(scrypt);格式 scrypt$<salt>$<hash> */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return `scrypt$${salt}$${h}`;
}
function verifyPasswordHash(pw, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) return pw === stored; // 兼容旧明文
  const [, salt, h] = stored.split('$');
  const c = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(c), Buffer.from(h));
}

/** 设置定义:类型 / 默认值 / 说明(供前端渲染与校验) */
const SETTINGS_DEF = [
  { key: 'port', type: 'number', def: 5217, min: 1, max: 65535, label: '服务端口', desc: '服务监听的端口号,修改后需要重启服务生效。' },
  { key: 'max_file_size_mb', type: 'number', def: 0, min: 0, max: 1048576, label: '单文件大小上限(MB)', desc: '超过上限的文件将被拒绝上传,填 0 表示不限制。局域网内传输不限速。' },
  { key: 'image_default_format', type: 'select', def: 'original', options: ['original', 'webp', 'jpeg'], optionLabels: { original: '保留原格式', webp: '自动转 WebP(更小)', jpeg: '自动转 JPEG(兼容) ' }, label: '默认图床格式', desc: '上传或粘贴图片时的默认处理格式。转换在浏览器端完成,原图字节不会发到服务器再转,更省流量。' },
  { key: 'webp_quality', type: 'slider', def: 0.8, min: 0.3, max: 1, step: 0.05, label: '图片压缩质量', desc: '转换为 WebP / JPEG 时的质量系数,越高越清晰、体积越大。' },
  { key: 'auto_cleanup_enabled', type: 'switch', def: true, label: '自动清理过期内容', desc: '定期自动删除已过期的分享链接、超过保留期的剪贴板/文件/图片及其磁盘文件。' },
  { key: 'cleanup_interval_minutes', type: 'number', def: 30, min: 1, max: 1440, label: '清理执行间隔(分钟)', desc: '自动清理任务的执行频率。' },
  { key: 'item_retention_minutes', type: 'number', def: 10080, min: 0, max: 5256000, label: '内容保留时长(分钟)', desc: '剪贴板 / 文件 / 图片超过该时长后将被自动清理,填 0 表示永久保留。' },
  { key: 'access_password_enabled', type: 'switch', def: false, label: '访问口令保护', desc: '开启后,新设备首次打开工作台需要输入口令;已授权设备会记住登录状态。扫码连接会自动带上免密授权参数。' },
  { key: 'access_password', type: 'password', def: '', label: '访问口令', desc: '4~32 位口令,建议简短易输入,仅用于局域网内区分设备。' },
  { key: 'ipv6_enabled', type: 'switch', def: false, label: '启用 IPv6', desc: '默认关闭,初始状态仅使用局域网地址,更安全。开启后,扫码弹窗与访问地址会包含本机 IPv6(自动只显示稳定地址),DDNS 也会发布 AAAA 记录,公网设备才有可能通过 IPv6 访问。⚠️ 关闭时,来自公网 IPv6 的连接会被服务器直接拒绝(实时生效);局域网与 Tailscale 不受影响。' },
  { key: 'ddns_enabled', type: 'switch', def: false, label: '启用 DDNS 动态域名', desc: '把本机当前公网地址(优先全局 IPv6,免端口映射)自动更新到你的域名解析,实现"域名固定、IP 随变"。⚠️ 开启后工作台可能可从公网访问:强烈建议同时开启「访问口令保护」。关闭时,来自公网 IPv4 的连接(需路由器端口转发)也会被服务器拒绝。' },
  { key: 'ddns_provider', type: 'select', def: 'dnspod', options: ['dnspod', 'aliyun', 'cloudflare', 'desec', 'godaddy', 'duckdns', 'dynv6', 'dynu', 'noip', 'custom'], optionLabels: { dnspod: 'DNSPod(腾讯云)', aliyun: '阿里云 DNS', cloudflare: 'Cloudflare', desec: 'deSEC.io(免费)', godaddy: 'GoDaddy', duckdns: 'DuckDNS(免费)', dynv6: 'Dynv6(免费)', dynu: 'Dynu', noip: 'No-IP(免费)', custom: '自定义更新 URL' }, label: '解析服务商', desc: '令牌格式——DNSPod:「ID,Token」;阿里云:「AccessKeyID,AccessKeySecret」;No-IP:「用户名,密码」;GoDaddy:「key:secret」;Dynu:API-Key 或「ClientID,ClientSecret」;Cloudflare:API Token(另填 Zone ID);DuckDNS / Dynv6 / deSEC:各自页面生成的 token;自定义:URL 模板占位符 {ipv4} {ipv6} {domain} {token}。' },
  { key: 'ddns_domain', type: 'text', def: '', label: '域名', desc: '填完整记录名,如 hub.example.com(裸根域 example.com 也可以);DuckDNS / Dynv6 填完整 zone(如 mypc.duckdns.org);No-IP 填完整 hostname(如 mypc.ddns.net)。' },
  { key: 'ddns_token', type: 'password', def: '', label: '令牌 / Token', desc: '解析服务商的 API 令牌或密钥对,仅保存在本地数据库,不会展示给其他设备。' },
  { key: 'ddns_token', type: 'password', def: '', label: '令牌 / Token', desc: '解析服务商的 API 令牌,仅保存在本地数据库,不会展示给其他设备。' },
  { key: 'ddns_zone_id', type: 'text', def: '', label: 'Zone ID(仅 Cloudflare)', desc: 'Cloudflare 域名概览页右下角的 Zone ID。其他服务商无需填写。' },
  { key: 'ddns_url_template', type: 'text', def: '', label: '更新 URL 模板(仅自定义)', desc: '示例:https://ddns.example.com/update?domain={domain}&token={token}&v6={ipv6}&v4={ipv4}。保存后可用"立即更新"验证。' },
  { key: 'ddns_interval_minutes', type: 'number', def: 10, min: 1, max: 1440, label: '更新间隔(分钟)', desc: '定时把最新地址同步到解析服务商;IP 变化后最长等一个周期生效。' },
];

const SECRET_KEYS = new Set(['access_password']);
// 运行时辅助值(非用户设置):免密授权 key
const INTERNAL_DEF = { access_key: () => shortId(16) };

class SettingsStore {
  constructor() { this.cache = new Map(); this.listeners = new Set(); this.load(); }

  load() {
    const db = getDB();
    const rows = db.prepare('SELECT key, value FROM settings').all();
    for (const r of rows) {
      try { this.cache.set(r.key, JSON.parse(r.value)); } catch { this.cache.set(r.key, r.value); }
    }
    // 旧明文口令自动迁移为加盐哈希(启动时一次性)
    const legacy = this.cache.get('access_password');
    if (typeof legacy === 'string' && legacy && !legacy.startsWith('scrypt$')) {
      this.cache.set('access_password', hashPassword(legacy));
      this.set('access_password', this.cache.get('access_password'), true);
    }
    for (const d of SETTINGS_DEF) {
      if (!this.cache.has(d.key)) this.cache.set(d.key, d.def);
    }
    for (const [k, fn] of Object.entries(INTERNAL_DEF)) {
      if (!this.cache.has(k)) this.set(k, fn(), true);
    }
  }

  /** 校验口令(支持哈希与旧明文) */
  verifyPassword(pw) {
    return verifyPasswordHash(pw, this.get('access_password'));
  }

  get(key) {
    if (this.cache.has(key)) return this.cache.get(key);
    const d = SETTINGS_DEF.find(x => x.key === key);
    return d ? d.def : undefined;
  }

  getAll() {
    const out = {};
    for (const d of SETTINGS_DEF) out[d.key] = this.get(d.key);
    return out;
  }

  set(key, value, silent = false) {
    const db = getDB();
    db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
    this.cache.set(key, value);
    if (!silent) for (const fn of this.listeners) { try { fn(key, value); } catch { /* ignore */ } }
  }

  setMany(obj) {
    const applied = {};
    for (const d of SETTINGS_DEF) {
      if (obj[d.key] !== undefined) {
        let v = obj[d.key];
        if (d.type === 'number') {
          v = Number(v);
          if (!Number.isFinite(v)) continue;
          v = Math.max(d.min ?? -Infinity, Math.min(d.max ?? Infinity, v));
          if (d.type === 'number' && !Number.isInteger(v)) v = Math.round(v);
        }
        if (d.type === 'slider') {
          v = Number(v);
          if (!Number.isFinite(v)) continue;
          v = Math.max(d.min, Math.min(d.max, v));
        }
        if (d.type === 'select' && !d.options.includes(v)) continue;
        if (d.type === 'switch') v = v === true || v === 'true' || v === 1;
        if (d.type === 'text') {
          v = String(v ?? '').trim();
          if (v.length > 512) { const err = new Error('内容过长'); err.status = 400; throw err; }
        }
        if (d.type === 'password') {
          v = String(v ?? '').trim();
          if (v === '') continue; // 空值 = 保持原口令不变(不再支持清空,关闭保护即可)
          // 访问口令或 API 令牌:兼容 DNSPod「ID,Token」等含逗号/冒号/斜杠格式
          if (!/^[A-Za-z0-9_\-@#$%^&*!.,:;+=/]{4,64}$/.test(v)) {
            const err = new Error('令牌需为 4~64 位字母、数字或常用符号(支持逗号、冒号等)');
            err.status = 400; throw err;
          }
          // 访问口令(非 API 令牌)落库为加盐哈希
          if (d.key === 'access_password') v = hashPassword(v);
        }
        this.set(d.key, v, true);
        applied[d.key] = v;
      }
    }
    for (const fn of this.listeners) { try { fn('*batch', applied); } catch { /* ignore */ } }
    return applied;
  }

  validate() {
    // 开启口令保护时必须有非空口令
    if (this.get('access_password_enabled')) {
      const pw = String(this.get('access_password') || '');
      if (!pw) return '开启访问保护前请先设置口令';
    }
    return null;
  }

  describe() {
    return SETTINGS_DEF.map(d => ({
      ...d, value: this.get(d.key),
    }));
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}

module.exports = { SettingsStore, SETTINGS_DEF, SECRET_KEYS };
