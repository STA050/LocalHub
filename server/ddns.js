'use strict';
const crypto = require('crypto');
const { execFile } = require('child_process');
const { lanAddresses, addressUrls } = require('./net');

function ps(command, timeout = 10000) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? '' : (stdout || ''));
    });
  });
}
function parseJsonPs(out) {
  try {
    const v = JSON.parse(out);
    return Array.isArray(v) ? v : [v];
  } catch { return []; }
}

/** Windows 稳定 IPv6 集合(排除隐私扩展临时地址),60s 缓存;非 Windows 返回 null */
let stableV6Cache = { at: 0, set: null };
async function stableIPv6Set() {
  if (process.platform !== 'win32') return null;
  if (stableV6Cache.set && Date.now() - stableV6Cache.at < 60000) return stableV6Cache.set;
  try {
    const out = await ps('Get-NetIPAddress -AddressFamily IPv6 -ErrorAction SilentlyContinue | Where-Object { $_.SuffixOrigin -ne "Random" } | Select-Object -ExpandProperty IPAddress | ConvertTo-Json -Compress');
    const list = parseJsonPs(out).filter(x => typeof x === 'string');
    stableV6Cache = { at: Date.now(), set: new Set(list) };
    return stableV6Cache.set;
  } catch { return null; }
}

/** 从本机网卡提取可发布地址:全局 IPv6 优先(这是 IPv6+DDNS 免端口映射的关键) */
async function detectAddresses() {
  const addrs = lanAddresses();
  const globalV6 = addrs.filter(a => a.family === 6 && a.global);
  let ipv6 = (globalV6[0] || {}).ip || null;
  const stable = await stableIPv6Set();
  if (stable && globalV6.length) {
    const firstStable = globalV6.find(a => stable.has(a.ip));
    if (firstStable) ipv6 = firstStable.ip;
  }
  const ipv4Local = (addrs.find(a => a.family === 4) || {}).ip || null;
  return { ipv6, ipv4Local };
}

/**
 * 展示用地址列表:排除 IPv6 临时隐私地址(只留稳定地址)。
 * 若过滤后没有全局 v6 则保留原列表,避免误清空。
 */
async function addressUrlsStable(port) {
  const urls = addressUrls(port);
  const stable = await stableIPv6Set();
  if (!stable) return urls;
  const hasGlobal = urls.some(u => u.family === 6 && u.global);
  const filtered = urls.filter(u => !(u.family === 6 && u.global) || stable.has(u.host.slice(1, -1)));
  if (hasGlobal && !filtered.some(u => u.family === 6 && u.global)) return urls;
  return filtered;
}

/** 公网 IPv4 需要外部服务探测(局域网私有地址无法用于 DNS 解析) */
async function fetchPublicIPv4() {
  for (const url of ['https://api.ipify.org', 'https://ipv4.icanhazip.com']) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const t = (await res.text()).trim();
        if (/^\d+\.\d+\.\d+\.\d+$/.test(t)) return t;
      }
    } catch { /* 尝试下一个 */ }
  }
  return null;
}

function splitDnsPodName(name) {
  const parts = String(name || '').split('.').filter(Boolean);
  if (parts.length < 3) throw new Error('DNSPod 域名请填「子域.根域」形式,如 hub.example.com');
  return { sub: parts[0], root: parts.slice(1).join('.') };
}

/** 通用记录名拆分:两段视为根域裸记录(如 example.com → @),三段以上取首段为子域 */
function splitRecordName(name) {
  const parts = String(name || '').split('.').filter(Boolean);
  if (parts.length < 2) throw new Error('域名格式:子域.根域,如 hub.example.com');
  if (parts.length === 2) return { sub: '@', root: parts.join('.') };
  return { sub: parts[0], root: parts.slice(1).join('.') };
}

const TIMEOUT_MS = 15000;

async function providerDuckDNS({ token, domain, ipv4, ipv6 }) {
  const url = `https://www.duckdns.org/update?domains=${encodeURIComponent(domain)}&token=${encodeURIComponent(token)}&ipv6=${encodeURIComponent(ipv6 || '')}&ip=${encodeURIComponent(ipv4 || '')}&verbose=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = (await res.text()).trim();
  if (!/^OK/i.test(text)) throw new Error(`DuckDNS 返回异常:${text.slice(0, 80)}`);
  return `DuckDNS 已更新 ${domain}.duckdns.org`;
}

async function providerDNSPod({ token, domain, content }) {
  const { sub, root } = splitDnsPodName(domain);
  const body = new URLSearchParams({
    login_token: token, format: 'json', domain: root,
    record_line: '默认', sub_domain: sub, value: content,
  }).toString();
  const res = await fetch('https://dnsapi.cn/Record.Ddns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => null);
  if (!data || data.status?.code !== '1') {
    throw new Error(`DNSPod 失败:${data?.status?.message || '接口无响应'}`);
  }
  return `DNSPod 已更新 ${domain} → ${content}`;
}

async function cfApi(token, path, options = {}) {
  return fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    ...options,
  }).then(r => r.json());
}
const cfError = (data) => (data.errors || []).map(e => e.message).join('; ') || '未知错误';

async function providerCloudflare({ token, zoneId, domain, content }) {
  if (!zoneId) throw new Error('Cloudflare 需要填写 Zone ID(域名概览页右下角可复制)');
  const type = content.includes(':') ? 'AAAA' : 'A';
  const q = await cfApi(token, `/zones/${encodeURIComponent(zoneId)}/dns_records?type=${type}&name=${encodeURIComponent(domain)}&per_page=5`);
  if (!q.success) throw new Error(`Cloudflare 查询失败:${cfError(q)}`);
  const record = (q.result || [])[0];
  if (record) {
    const upd = await cfApi(token, `/zones/${encodeURIComponent(zoneId)}/dns_records/${record.id}`, {
      method: 'PUT',
      body: JSON.stringify({ type, name: domain, content, ttl: 300, proxied: false }),
    });
    if (!upd.success) throw new Error(`Cloudflare 更新失败:${cfError(upd)}`);
    return `Cloudflare 已更新 ${domain} ${type} → ${content}`;
  }
  const created = await cfApi(token, `/zones/${encodeURIComponent(zoneId)}/dns_records`, {
    method: 'POST',
    body: JSON.stringify({ type, name: domain, content, ttl: 300, proxied: false }),
  });
  if (!created.success) throw new Error(`Cloudflare 创建失败:${cfError(created)}`);
  return `Cloudflare 已创建 ${domain} ${type} → ${content}`;
}

/** 自定义模板:URL 中可用占位符 {ipv4} {ipv6} {domain} {token} */
async function providerCustom({ token, domain, ipv4, ipv6, template }) {
  if (!template) throw new Error('自定义模式需要填写更新 URL 模板');
  const url = template
    .replaceAll('{ipv4}', encodeURIComponent(ipv4 || ''))
    .replaceAll('{ipv6}', encodeURIComponent(ipv6 || ''))
    .replaceAll('{domain}', encodeURIComponent(domain || ''))
    .replaceAll('{token}', encodeURIComponent(token || ''));
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`自定义 DDNS HTTP ${res.status}`);
  return `自定义 DDNS 已执行(HTTP ${res.status})`;
}

// ---------- 阿里云 ----------
function percentEncode(s) {
  return encodeURIComponent(String(s))
    .replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');
}
/** 阿里云 RPC 签名:HMAC-SHA1(RFC3986 规范化查询串) */
function aliyunSign(params, secret) {
  const canonical = Object.keys(params).sort()
    .map(k => `${percentEncode(k)}=${percentEncode(params[k])}`).join('&');
  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonical)}`;
  return crypto.createHmac('sha1', `${secret}&`).update(stringToSign).digest('base64');
}

async function providerAliyun({ token, domain, content, endpoint }) {
  const [akId, akSecret] = String(token || '').split(',').map(s => s.trim());
  if (!akId || !akSecret) throw new Error('阿里云令牌格式:AccessKeyID,AccessKeySecret');
  const { sub, root } = splitRecordName(domain);
  const type = content.includes(':') ? 'AAAA' : 'A';
  const base = {
    Format: 'json', Version: '2015-01-09', AccessKeyId: akId,
    SignatureMethod: 'HMAC-SHA1', SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  const call = async (action, extra) => {
    const params = { ...base, Action: action, ...extra };
    params.Signature = aliyunSign(params, akSecret);
    const qs = Object.keys(params).map(k => `${percentEncode(k)}=${percentEncode(params[k])}`).join('&');
    const res = await fetch(`${(endpoint && endpoint.aliyun) || 'https://dns.aliyuncs.com'}/?${qs}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const data = await res.json().catch(() => null);
    if (!data || data.Code || data.Message) {
      throw new Error(`阿里云 ${action} 失败:${data?.Message || data?.Code || `HTTP ${res.status}`}`);
    }
    return data;
  };
  const list = await call('DescribeDomainRecords', { DomainName: root });
  const rec = (list.DomainRecords?.Record || []).find(r => r.RR === sub && r.Type === type);
  if (rec) {
    await call('UpdateDomainRecord', { RecordId: rec.RecordId, RR: sub, Type: type, Value: content });
    return `阿里云已更新 ${domain} ${type} → ${content}`;
  }
  await call('AddDomainRecord', { DomainName: root, RR: sub, Type: type, Value: content });
  return `阿里云已创建 ${domain} ${type} → ${content}`;
}

// ---------- Dynv6 ----------
async function providerDynv6({ token, domain, ipv4, ipv6, endpoint }) {
  const base = (endpoint && endpoint.dynv6) || 'https://dynv6.com';
  const url = `${base}/api/update?zone=${encodeURIComponent(domain)}&token=${encodeURIComponent(token || '')}&ipv4=${encodeURIComponent(ipv4 || '')}&ipv6=${encodeURIComponent(ipv6 || '')}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = (await res.text()).trim();
  if (res.status !== 200 || /^error/i.test(text.slice(0, 40))) {
    throw new Error(`Dynv6 失败:${text.slice(0, 80) || `HTTP ${res.status}`}`);
  }
  return `Dynv6 已更新 ${domain}`;
}

// ---------- No-IP(dyn 标准协议) ----------
async function providerNoIP({ token, domain, ipv4, ipv6, endpoint }) {
  const sep = String(token || '').includes(':') ? ':' : ',';
  const [user, pass] = String(token || '').split(sep).map(s => s.trim());
  if (!user || !pass) throw new Error('No-IP 令牌格式:用户名,密码');
  const ips = [ipv4, ipv6].filter(Boolean).join(',');
  if (!ips) throw new Error('没有可发布的地址');
  const base = (endpoint && endpoint.noip) || 'https://dynupdate.no-ip.com';
  const url = `${base}/nic/update?hostname=${encodeURIComponent(domain)}&myip=${encodeURIComponent(ips)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`, 'User-Agent': 'LocalHub/1.0' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = (await res.text()).trim();
  if (!/^(good|nochg)/i.test(text)) throw new Error(`No-IP 失败:${text.slice(0, 80)}`);
  return `No-IP 已更新 ${domain}(${ips})`;
}

// ---------- deSEC.io ----------
async function providerDesec({ token, domain, content, endpoint }) {
  const type = content.includes(':') ? 'AAAA' : 'A';
  const { sub, root } = splitRecordName(domain);
  const base = (endpoint && endpoint.desec) || 'https://desec.io';
  const url = `${base}/api/v1/domains/${encodeURIComponent(root)}/rrsets/${encodeURIComponent(sub)}/${type}/`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Token ${token || ''}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: [content] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`deSEC 失败:HTTP ${res.status}`);
  return `deSEC 已更新 ${domain} ${type} → ${content}`;
}

// ---------- GoDaddy(PUT 为 upsert 语义) ----------
async function providerGoDaddy({ token, domain, content, endpoint }) {
  const type = content.includes(':') ? 'AAAA' : 'A';
  const [key, secret] = String(token || '').split(/[:,]/).map(s => s.trim());
  if (!key || !secret) throw new Error('GoDaddy 令牌格式:key:secret');
  const { sub, root } = splitRecordName(domain);
  const base = (endpoint && endpoint.godaddy) || 'https://api.godaddy.com';
  const url = `${base}/v1/domains/${encodeURIComponent(root)}/records/${type}/${encodeURIComponent(sub)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `sso-key ${key}:${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ data: content, ttl: 600 }]),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GoDaddy 失败:HTTP ${res.status}`);
  return `GoDaddy 已更新 ${domain} ${type} → ${content}`;
}

// ---------- Dynu ----------
async function dynuHeaders(cfg) {
  // 令牌填 API-Key,或「ClientID,ClientSecret」走 OAuth2
  const base = (cfg.endpoint && cfg.endpoint.dynu) || 'https://api.dynu.com';
  if (String(cfg.token || '').includes(',')) {
    const [cid, secret] = cfg.token.split(',').map(s => s.trim());
    const res = await fetch(`${base}/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${cid}:${secret}`).toString('base64')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => null);
    const at = data && (data.accessToken || data.access_token);
    if (!at) throw new Error(`Dynu OAuth2 失败:${data?.error || data?.message || `HTTP ${res.status}`}`);
    return { base, headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' } };
  }
  return { base, headers: { 'API-Key': String(cfg.token || '').trim(), 'Content-Type': 'application/json' } };
}

async function providerDynu(cfg) {
  const { domain, content } = cfg;
  const { base, headers } = await dynuHeaders(cfg);
  const type = content.includes(':') ? 'IPV6ADDR' : 'IPV4ADDR';
  const sig = AbortSignal.timeout(TIMEOUT_MS);
  // 记录所属根域:按最长后缀匹配账户下域名(Dynu 的 DDNS 主机本身就是 zone)
  const zoneRes = await fetch(`${base}/v2/dns`, { headers, signal: sig });
  const zones = await zoneRes.json().catch(() => null);
  if (!zoneRes.ok || !zones || !Array.isArray(zones.domains)) {
    throw new Error(`Dynu 获取域名列表失败:HTTP ${zoneRes.status}`);
  }
  const names = zones.domains.map(d => d.Name || d.name || '').filter(Boolean);
  const root = names.filter(n => domain === n || domain.endsWith('.' + n)).sort((a, b) => b.length - a.length)[0];
  if (!root) {
    throw new Error(`Dynu 账户中找不到包含 ${domain} 的域名(账户域名:${names.join('、') || '空'})`);
  }
  const nodeName = domain === root ? '' : domain.slice(0, -(root.length + 1));
  const q = nodeName ? `?nodeName=${encodeURIComponent(nodeName)}` : '';
  const recRes = await fetch(`${base}/v2/dns/record/${encodeURIComponent(root)}${q}`, { headers, signal: sig });
  const recData = await recRes.json().catch(() => null);
  if (!recRes.ok) throw new Error(`Dynu 查询记录失败:HTTP ${recRes.status}`);
  const records = (recData && (recData.dnsRecords || recData.records)) || [];
  const rec = records.find(r => String((r && r.recordType) || '').toUpperCase() === type);
  const body = JSON.stringify({ nodeName, recordType: type, ipAddress: content });
  let resp;
  if (rec && rec.id !== undefined && rec.id !== null) {
    resp = await fetch(`${base}/v2/dns/record/${encodeURIComponent(root)}/${rec.id}`, { method: 'POST', headers, body, signal: sig });
  } else {
    resp = await fetch(`${base}/v2/dns/record/${encodeURIComponent(root)}`, { method: 'POST', headers, body, signal: sig });
  }
  const rd = await resp.json().catch(() => null);
  if (!resp.ok || (rd && rd.statusCode && rd.statusCode !== 200)) {
    throw new Error(`Dynu 写入失败:${(rd && (rd.message || rd.Message)) || `HTTP ${resp.status}`}`);
  }
  return `Dynu 已更新 ${domain} ${type} → ${content}`;
}

const PROVIDERS = {
  dnspod: { name: 'DNSPod(腾讯云)', run: providerDNSPod, mode: 'single' },
  aliyun: { name: '阿里云 DNS', run: providerAliyun, mode: 'single' },
  cloudflare: { name: 'Cloudflare', run: providerCloudflare, mode: 'single' },
  desec: { name: 'deSEC.io', run: providerDesec, mode: 'single' },
  godaddy: { name: 'GoDaddy', run: providerGoDaddy, mode: 'single' },
  duckdns: { name: 'DuckDNS', run: providerDuckDNS, mode: 'dual' },
  dynv6: { name: 'Dynv6', run: providerDynv6, mode: 'dual' },
  dynu: { name: 'Dynu', run: providerDynu, mode: 'single' },
  noip: { name: 'No-IP', run: providerNoIP, mode: 'dual' },
  custom: { name: '自定义 URL', run: providerCustom, mode: 'dual' },
};

/**
 * 执行一次解析更新。
 * single:逐条调用,IPv6 → AAAA、IPv4 → A;dual:一次请求同时携带双栈地址。
 */
async function runOnce(cfg, addrs) {
  const p = PROVIDERS[cfg.provider];
  if (!p) throw new Error(`未知 DDNS 提供商:${cfg.provider}`);
  const contents = [];
  if (addrs.ipv6) contents.push(addrs.ipv6);
  if (addrs.ipv4) contents.push(addrs.ipv4);
  if (!contents.length) throw new Error('没有可发布的地址:未检测到全局 IPv6,公网 IPv4 也未获取到');
  if (p.mode === 'dual') {
    return p.run({ ...cfg, ipv4: addrs.ipv4, ipv6: addrs.ipv6 });
  }
  const messages = [];
  for (const content of contents) {
    messages.push(await p.run({ ...cfg, content, ipv4: addrs.ipv4, ipv6: addrs.ipv6 }));
  }
  return messages.join(' | ');
}

class DdnsUpdater {
  constructor(settings, hub) {
    this.settings = settings;
    this.hub = hub;
    this.timer = null;
    this.lastRun = null;
    this.lastResult = null;
    this.running = false;
  }

  config() {
    const s = this.settings;
    return {
      enabled: !!s.get('ddns_enabled'),
      provider: s.get('ddns_provider') || 'dnspod',
      token: String(s.get('ddns_token') || ''),
      domain: String(s.get('ddns_domain') || ''),
      zoneId: String(s.get('ddns_zone_id') || ''),
      template: String(s.get('ddns_url_template') || ''),
      intervalMinutes: Math.max(1, Number(s.get('ddns_interval_minutes') || 10)),
    };
  }

  start() {
    this.stop();
    const cfg = this.config();
    if (!cfg.enabled) return;
    this.timer = setInterval(() => {
      this.updateNow().catch(err => console.error('[ddns]', err.message));
    }, cfg.intervalMinutes * 60000);
    if (this.timer.unref) this.timer.unref();
    const t = setTimeout(() => {
      this.updateNow().catch(err => console.error('[ddns]', err.message));
    }, 3000);
    if (t.unref) t.unref();
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  /** 探测当前可发布的地址(尊重 IPv6 开关) */
  async detect() {
    const local = await detectAddresses();
    const ipv6 = this.settings.get('ipv6_enabled') ? local.ipv6 : null;
    const ipv4 = await fetchPublicIPv4();
    return { ipv6, ipv4, ipv4Local: local.ipv4Local };
  }

  async updateNow(opts = {}) {
    const force = opts.force === true; // 测试按钮:未启用也允许执行
    if (this.running) return { ok: false, message: '上一次更新仍在进行中,请稍候' };
    this.running = true;
    try {
      const cfg = this.config();
      if (!cfg.enabled && !force) return { ok: false, message: 'DDNS 未启用,请先在设置中开启' };
      if (!cfg.domain || !cfg.token) throw new Error('请先在设置中填写 DDNS 域名与令牌');
      const addrs = await this.detect();
      const message = await runOnce(cfg, addrs);
      this.lastRun = Date.now();
      this.lastResult = { ok: true, message, addrs, at: this.lastRun };
      if (this.hub) this.hub.broadcast('ddns:updated', { ok: true, message });
      return { ok: true, message, addrs };
    } catch (err) {
      let message = err.message;
      if (message === 'fetch failed') {
        message = '网络连接失败:无法访问服务商 API。可能是该服务商在你的网络被墙(如 Dynu/GoDaddy/DuckDNS),请换用可直连的服务商或让服务走代理启动。';
      }
      this.lastRun = Date.now();
      this.lastResult = { ok: false, message, at: this.lastRun };
      if (this.hub) this.hub.broadcast('ddns:updated', { ok: false, message });
      return { ok: false, message };
    } finally {
      this.running = false;
    }
  }

  /** 供前端展示的状态(令牌不回传明文) */
  status() {
    const cfg = this.config();
    return {
      enabled: cfg.enabled,
      provider: cfg.provider,
      providerName: (PROVIDERS[cfg.provider] || {}).name || cfg.provider,
      domain: cfg.domain,
      intervalMinutes: cfg.intervalMinutes,
      tokenSet: !!cfg.token,
      lastRun: this.lastRun,
      lastResult: this.lastResult,
    };
  }
}

module.exports = { DdnsUpdater, runOnce, detectAddresses, addressUrlsStable, stableIPv6Set, fetchPublicIPv4, splitDnsPodName, PROVIDERS };
