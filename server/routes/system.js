'use strict';
const express = require('express');
const QRCode = require('qrcode');
const { storageStats } = require('../cleanup');
const { detectAddresses, addressUrlsStable } = require('../ddns');
const { checkFirewall, fixFirewall } = require('../firewall');
const { SECRET_KEYS } = require('../settings');

/** 系统:设置 / 网络 / 仪表盘 */
function systemRouter(ctx) {
  const { settings, hub, cleaner, dirs, startedAt } = ctx;
  const r = express.Router();

  // ---- 局域网信息(IP 列表公开;二维码因含免密 key 而需登录) ----
  r.get('/lan', async (req, res) => {
    const port = ctx.port;
    let urls = await addressUrlsStable(port);
    if (!settings.get('ipv6_enabled')) urls = urls.filter(u => u.family === 4);
    // DDNS 域名作为首选入口:仅在 DDNS 已启用且填了域名时展示
    const ddnsDomain = String(settings.get('ddns_domain') || '').trim();
    if (settings.get('ddns_enabled') && ddnsDomain) {
      urls = urls.filter(u => u.host !== ddnsDomain);
      urls.unshift({ label: 'DDNS 域名', host: ddnsDomain, url: `http://${ddnsDomain}:${port}`, family: 0, iface: 'ddns' });
    }
    res.json({
      ips: urls.filter(u => u.family === 4).map(u => u.host),
      ipv6: urls.filter(u => u.family === 6).map(u => u.host),
      urls,
      port,
      url: (urls[0] || {}).url || `http://127.0.0.1:${port}`,
      hasGlobalIPv6: urls.some(u => u.family === 6 && u.global),
      protected: !!settings.get('access_password_enabled'),
    });
  });

  r.get('/lan/qr', async (req, res) => {
    let urls = await addressUrlsStable(ctx.port);
    if (!settings.get('ipv6_enabled')) urls = urls.filter(u => u.family === 4);
    const host = String(req.query.host || req.query.ip || (urls[0] || {}).host || '127.0.0.1');
    let url = `http://${host}:${ctx.port}`;
    if (settings.get('access_password_enabled')) url += `?key=${encodeURIComponent(String(settings.get('access_key')))}`;
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 240 });
    res.json({ url, svg, host });
  });

  // ---- DDNS 远程访问 ----
  r.get('/ddns', async (req, res) => {
    const detected = await ctx.ddns.detect();
    res.json({ ...ctx.ddns.status(), localIPv6: detected.ipv6, ipv4Local: detected.ipv4Local });
  });

  r.post('/ddns/run', async (req, res) => {
    const result = await ctx.ddns.updateNow();
    res.json({ ...result, status: ctx.ddns.status() });
  });

  // 测试按钮:无需启用 DDNS 即可执行,返回分步诊断
  r.post('/ddns/test', async (req, res) => {
    const started = Date.now();
    const result = await ctx.ddns.updateNow({ force: true });
    res.json({
      ...result,
      durationMs: Date.now() - started,
      steps: [
        { name: '探测本机地址', detail: result.addrs ? `IPv6: ${result.addrs.ipv6 || '无'} · 公网IPv4: ${result.addrs.ipv4 || '未获取到'}` : null },
        { name: '连接服务商并写入解析', detail: result.message },
      ].filter(s => s.detail),
    });
  });

  // ---- 在线设备注册表(按浏览器指纹去重) ----
  r.get('/devices', (req, res) => {
    res.json({ count: hub.deviceCount(), items: hub.devices() });
  });

  // ---- 设置(可视化设置页数据源) ----
  r.get('/settings', (req, res) => {
    res.json({
      items: settings.describe().map(it => {
        if (it.key === 'access_password') {
          // 口令只下发"是否已设置",不回传明文/哈希;前端留空 = 保持不变
          return { ...it, value: '', passwordSet: !!settings.get('access_password') };
        }
        return it;
      }),
      restartRequired: ['port'],
      accessKey: settings.get('access_key'),
    });
  });

  r.put('/settings', (req, res) => {
    const body = req.body || {};
    const before = { port: settings.get('port'), pwEnabled: settings.get('access_password_enabled') };
    let applied;
    try { applied = settings.setMany(body); }
    catch (err) { return res.status(err.status || 400).json({ error: 'bad_value', message: err.message }); }
    const warn = settings.validate();
    if (warn) {
      // 口令保护开启但无口令 → 回滚开关
      if (body.access_password_enabled === true) {
        settings.set('access_password_enabled', false, true);
        applied.access_password_enabled = false;
        return res.status(400).json({ error: 'password_required', message: warn });
      }
    }
    if (applied.access_password_enabled === false) {
      // 关闭保护后清空所有会话
      require('../db').getDB().prepare('DELETE FROM sessions').run();
    }
    hub.broadcast('settings:updated', { applied });
    res.json({
      ok: true, applied,
      restartRequired: applied.port !== undefined && applied.port !== before.port,
      notice: applied.port !== undefined && applied.port !== before.port ? `端口已改为 ${applied.port},重启服务后生效` : null,
    });
  });

  // ---- 仪表盘 ----
  r.get('/dashboard', (req, res) => {
    const stats = storageStats(dirs);
    res.json({
      ...stats,
      onlineDevices: hub.onlineCount(),
      uptimeMs: Date.now() - startedAt,
      cleaner: { lastRun: cleaner.lastRun, lastResult: cleaner.lastResult },
      port: ctx.port,
      maxFileSizeMb: settings.get('max_file_size_mb'),
      retentionMinutes: settings.get('item_retention_minutes'),
      autoCleanup: !!settings.get('auto_cleanup_enabled'),
      cleanupIntervalMinutes: settings.get('cleanup_interval_minutes'),
    });
  });

  r.post('/cleanup', async (req, res) => {
    const result = await cleaner.run();
    res.json({ ok: true, result });
  });

  // ---- 防火墙连通性自检与一键修复(需登录;修复会弹 UAC 由本机用户确认) ----
  r.get('/firewall', async (req, res) => {
    res.json(await checkFirewall(ctx.port));
  });

  r.post('/firewall/fix', async (req, res) => {
    res.json(await fixFirewall(ctx.port));
  });

  return r;
}

module.exports = { systemRouter };
