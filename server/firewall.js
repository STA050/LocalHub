'use strict';
const { execFile } = require('child_process');
const { lanIPs } = require('./net');

const TAILSCALE_RE = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/; // CGNAT 100.64.0.0/10

function run(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '', killed: !!(err && err.killed) });
    });
  });
}

function ps(command, timeout = 15000) {
  return run('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], timeout);
}

function parseJsonPs(out) {
  try {
    const v = JSON.parse(out);
    return Array.isArray(v) ? v : [v];
  } catch { return []; }
}

const ruleNameFor = (port) => `LocalHub ${port}`;

/**
 * Windows 防火墙连通性自检:
 * 返回 { supported, port, needsFix, ruleExists, anyFwEnabled, hasPublic, networks,
 *        fwEnabledCount, alternative, items, checkedAt }
 */
async function checkFirewall(port) {
  const result = {
    platform: process.platform,
    supported: process.platform === 'win32',
    port,
    ruleExists: null,
    anyFwEnabled: null,
    hasPublic: null,
    networks: [],
    alternative: [],
    items: [],
    needsFix: false,
    verdict: '',
    checkedAt: Date.now(),
  };
  if (!result.supported) {
    result.verdict = '非 Windows 平台,通常无此问题';
    return result;
  }

  // 1) 当前活动网络的类型(公用/专用)
  const profRaw = await ps('Get-NetConnectionProfile | Select-Object InterfaceAlias,NetworkCategory | ConvertTo-Json -Compress');
  const profiles = parseJsonPs(profRaw.stdout);
  result.networks = profiles.map(p => ({
    iface: p.InterfaceAlias,
    category: p.NetworkCategory === 1 ? 'Private' : p.NetworkCategory === 0 ? 'Public' : String(p.NetworkCategory),
  }));
  result.hasPublic = result.networks.some(n => n.category === 'Public');

  // 2) 防火墙三个配置文件是否开启
  const fwRaw = await ps('Get-NetFirewallProfile | Select-Object Name,Enabled | ConvertTo-Json -Compress');
  const fwProfiles = parseJsonPs(fwRaw.stdout);
  result.anyFwEnabled = fwProfiles.some(p => p.Enabled === true);

  // 3) 本端口的放行规则是否存在且启用
  const rule = await run('netsh', ['advfirewall', 'firewall', 'show', `rule`, `name=${ruleNameFor(port)}`]);
  result.ruleExists = rule.code === 0 && /(?:已启用|Enabled)\s*:\s*(?:是|Yes)/i.test(rule.stdout);

  // 4) 免授权备用通道:Tailscale 等虚拟网卡(Private 类型,通常已放行)
  result.alternative = lanIPs()
    .filter(x => TAILSCALE_RE.test(x.ip))
    .map(x => ({ kind: 'Tailscale', url: `http://${x.ip}:${port}`, note: '手机安装 Tailscale 并登录同一账号即可直接访问,无需改防火墙' }));

  // 结论
  if (!result.anyFwEnabled) {
    result.needsFix = false;
    result.verdict = '防火墙未启用,外部设备可以直接访问';
  } else if (result.ruleExists) {
    result.needsFix = false;
    result.verdict = `已放行端口 ${port},手机可以正常访问`;
  } else if (result.hasPublic) {
    result.needsFix = true;
    result.verdict = '当前 WiFi 被归为"公用网络",且没有本端口的放行规则 —— 手机入站会被拦截';
  } else {
    result.needsFix = false;
    result.verdict = '当前网络为"专用",一般可访问;若手机仍连不上,点击一键修复添加放行规则';
  }

  result.items = [
    { key: 'listening', ok: true, label: `服务已在 0.0.0.0:${port} 监听` },
    {
      key: 'network',
      ok: !result.hasPublic,
      warnOnly: true,
      label: result.networks.length
        ? `活动网络:${result.networks.map(n => `${n.iface}(${n.category === 'Public' ? '公用' : '专用'})`).join('、')}`
        : '未检测到活动网络',
    },
    {
      key: 'fw',
      ok: true,
      warnOnly: true,
      label: `Windows 防火墙:${result.anyFwEnabled ? '已开启' : '已关闭'}`,
    },
    {
      key: 'rule',
      ok: result.ruleExists,
      label: `端口 ${port} 放行规则:${result.ruleExists ? '存在' : '不存在'}`,
    },
  ];
  return result;
}

/** 一键修复:通过 UAC 提权添加放行规则(用户需在弹窗点击"是") */
async function fixFirewall(port) {
  if (process.platform !== 'win32') return { ok: false, supported: false, message: '仅 Windows 需要' };
  const ruleName = ruleNameFor(port);
  const args = `advfirewall firewall add rule name="${ruleName}" dir=in action=allow protocol=TCP localport=${port} profile=any`;
  // 用户取消 UAC 时 Start-Process 抛异常 → 走 catch 退出码 2
  const r = await ps(
    `try { Start-Process netsh -ArgumentList '${args}' -Verb RunAs -Wait; exit 0 } catch { exit 2 }`,
    150000
  );
  const after = await checkFirewall(port);
  if (after.ruleExists) {
    return { ok: true, cancelled: false, check: after, message: `已添加放行规则「${ruleName}」(所有网络类型生效)` };
  }
  if (r.code === 2 || r.killed) {
    return { ok: false, cancelled: true, check: after, message: '未完成:UAC 弹窗被取消或超时,请重试并在弹窗中点击"是"' };
  }
  return { ok: false, cancelled: false, check: after, message: '修复未生效,可尝试手动运行项目目录下的 setup-firewall.bat' };
}

module.exports = { checkFirewall, fixFirewall, ruleNameFor };
