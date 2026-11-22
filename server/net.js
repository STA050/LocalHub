'use strict';
const os = require('os');

const V6_GLOBAL_RE = /^(2[0-9a-f]|3[0-9a-f])/i; // 2000::/3 全局单播(含 2408/240e 等国内运营商前缀)
const V6_ULA_RE = /^f[cd]/i;                    // fc00::/7 内网 ULA,类似 IPv4 私网

/** 常见组网/虚拟局域网工具的网卡名识别表(按顺序匹配) */
const TOOL_IFACE_PATTERNS = [
  { re: /tailscale/i, name: 'Tailscale' },
  { re: /zerotier|^zt[0-9a-f]/i, name: 'ZeroTier' },
  { re: /pgy|oray|蒲公英/i, name: '蒲公英(Oray)' },
  { re: /radmin/i, name: 'Radmin VPN' },
  { re: /hamachi/i, name: 'Hamachi' },
  { re: /openvpn|tap-windows/i, name: 'OpenVPN' },
  { re: /wireguard|wintun/i, name: 'WireGuard' },
  { re: /sangfor|easyconnect/i, name: '深信服 EasyConnect' },
  { re: /n2n/i, name: 'EasyN2N' },
];

/** 识别网卡属于哪个组网工具;不属于任何已知工具返回 null */
function ifaceToolName(iface) {
  for (const t of TOOL_IFACE_PATTERNS) {
    if (t.re.test(iface || '')) return t.name;
  }
  return null;
}

function isV6Global(ip) { return V6_GLOBAL_RE.test(ip); }
/** IPv6 URL 中主机须加方括号 */
function hostFor(ip) { return ip.includes(':') ? `[${ip}]` : ip; }

/** 收集本机所有可用地址(IPv4 + IPv6,按可用性打分排序) */
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    const virtual = /vmware|virtual|vbox|docker|hyper-v|loopback|tap|wsl/i.test(name);
    for (const a of addrs || []) {
      if (a.internal) continue;
      if (a.family === 'IPv4') {
        if (/^169\.254\./.test(a.address)) continue; // APIPA 链路本地,不可用于访问
        let score = 1;
        if (/^192\.168\./.test(a.address)) score = 4;
        else if (/^10\./.test(a.address) || /^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) score = 3;
        if (virtual) score -= 2;
        out.push({ family: 4, ip: a.address, iface: name, score, global: false });
      } else if (a.family === 'IPv6') {
        const ip = a.address.replace(/%.*$/, ''); // 去掉 zone id
        if (ip === '::1' || /^fe80/i.test(ip)) continue; // 环回/链路本地不作为访问地址
        let score;
        if (V6_GLOBAL_RE.test(ip)) score = 5;      // 全局可路由(可用于公网/DDNS)
        else if (V6_ULA_RE.test(ip)) score = 2;    // 内网 ULA
        else continue;
        if (virtual) score -= 2;
        out.push({ family: 6, ip, iface: name, score, global: V6_GLOBAL_RE.test(ip) });
      }
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/** 兼容旧接口:IPv4 列表 */
function lanIPs() {
  return lanAddresses().filter(a => a.family === 4).map(a => ({ ip: a.ip, iface: a.iface }));
}

/** 生成可直接打开的访问地址列表(IPv6 自动加方括号,去重) */
function addressUrls(port) {
  const urls = [];
  const seen = new Set();
  for (const a of lanAddresses()) {
    const host = hostFor(a.ip);
    const url = `http://${host}:${port}`;
    if (seen.has(url)) continue;
    seen.add(url);
    const tool = ifaceToolName(a.iface);
    let label;
    if (tool) {
      label = `${tool}-IPv${a.family}`; // 组网工具地址:如 Tailscale-IPv4 / ZeroTier-IPv6
    } else if (a.family === 6) {
      label = a.global ? 'IPv6 公网' : 'IPv6 内网';
    } else {
      label = 'IPv4 局域网';
    }
    urls.push({ label, host, url, family: a.family, iface: a.iface, tool, global: a.family === 6 ? a.global : undefined });
  }
  return urls;
}

/**
 * 连接准入判定:按"访客来源地址"分类,而不是按本地落点。
 * - 私网/回环/Tailscale/链路本地来源:永远允许(这是"本地局域网"的定义)
 * - 公网来源:IPv6 需 ipv6 开关,IPv4 需 ddns 开关(公网 IPv4 入站需路由器端口转发)
 */
function accessAllowed(remoteIp, { ipv6 = false, ddns = false } = {}) {
  const norm = String(remoteIp || '').replace(/^::ffff:/, '');
  if (!norm) return true;
  if (norm === '::1' || norm === '127.0.0.1') return true;      // 回环
  if (/^fe80/i.test(norm)) return true;                          // 链路本地
  if (/^f[cd]/i.test(norm)) return true;                         // ULA(Tailscale fd7a 等)
  if (/^10\./.test(norm) || /^192\.168\./.test(norm) || /^172\.(1[6-9]|2\d|3[01])\./.test(norm)) return true; // RFC1918 私网
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(norm)) return true; // 100.64/10 CGNAT(Tailscale)
  // 其余均为公网来源
  if (norm.includes(':')) return !!ipv6;                         // 公网 IPv6
  return !!ddns;                                                 // 公网 IPv4(需路由器端口转发配合)
}

module.exports = { lanIPs, lanAddresses, addressUrls, hostFor, isV6Global, ifaceToolName, accessAllowed };
