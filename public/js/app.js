/* LocalHub 前端主逻辑 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  /* 本设备标识:存 localStorage(同浏览器的所有标签页共享,多标签只算一台设备) */
  const CLIENT_KEY = (() => {
    let k = localStorage.getItem('lh_ck');
    if (!k) {
      k = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      localStorage.setItem('lh_ck', k);
    }
    return k;
  })();

  const state = {
    view: 'files',
    clips: [], files: [], images: [],
    settings: null, settingsItems: [],
    clipFilter: 'all',
    ws: null, wsOnline: false,
    transfers: new Map(), // id -> {xhr, name, size, loaded, samples}
    remoteUploads: new Map(), // uploadId -> {name, size, loaded, device, kind} 其他设备的实时上传
    devices: [],              // 在线设备注册表(presence 推送)
    shareCtx: null,
    uploadSeq: 0,
  };

  /* ============ 工具 ============ */
  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtSize(n) {
    if (!Number.isFinite(n)) return '-';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)) + ' ' + u[i];
  }
  function fmtTime(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    const now = Date.now();
    const diff = now - ts;
    if (diff < 60e3) return '刚刚';
    if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
    if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
    if (diff < 7 * 86400e3) return Math.floor(diff / 86400e3) + ' 天前';
    return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  function fmtRemaining(ts) {
    if (!ts) return '永久';
    const diff = ts - Date.now();
    if (diff <= 0) return '已过期';
    if (diff < 3600e3) return Math.ceil(diff / 60e3) + ' 分钟';
    if (diff < 86400e3) return Math.ceil(diff / 3600e3) + ' 小时';
    return Math.ceil(diff / 86400e3) + ' 天';
  }
  function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 2400);
  }
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); return true; } catch { return false; }
      finally { ta.remove(); }
    }
  }
  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  async function api(path, opts = {}) {
    const init = { ...opts, headers: { ...(opts.headers || {}) } };
    if (init.body && !(init.body instanceof Blob) && !(init.body instanceof FormData) && typeof init.body === 'object') {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(init.body);
    }
    const res = await fetch(path, init);
    if (res.status === 401) { showLogin(); throw Object.assign(new Error('unauthorized'), { status: 401 }); }
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) {
      throw Object.assign(new Error(data?.message || data?.error || `HTTP ${res.status}`), { status: res.status, data });
    }
    return data;
  }

  /* ============ 登录门 ============ */
  function showLogin() { $('#loginGate').classList.remove('hidden'); }
  function hideLogin() { $('#loginGate').classList.add('hidden'); }

  async function initAuth() {
    try {
      const st = await api('/api/auth/status');
      if (st.authorized) { hideLogin(); return true; }
      showLogin();
      return false;
    } catch { showLogin(); return false; }
  }

  $('#loginBtn').addEventListener('click', doLogin);
  $('#loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  async function doLogin() {
    const pw = $('#loginPassword').value;
    try {
      const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
      if (res.ok) { hideLogin(); boot(); }
      else { $('#loginError').classList.remove('hidden'); }
    } catch { $('#loginError').classList.remove('hidden'); }
  }

  /* ============ WebSocket ============ */
  function connectWS() {
    try {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws?ck=${encodeURIComponent(CLIENT_KEY)}`);
      state.ws = ws;
      ws.onopen = () => { state.wsOnline = true; setOnline(true); };
      ws.onclose = () => { state.wsOnline = false; setOnline(false); setTimeout(connectWS, 3000); };
      ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
      ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        handleWS(msg);
      };
    } catch { setTimeout(connectWS, 3000); }
  }

  function setOnline(n) {
    $('#onlineBadge').classList.toggle('offline', !n);
    $('#onlineText').textContent = n ? '实时连接正常' : '连接断开,重试中…';
    $('#onlineTextTop').textContent = n ? '在线' : '离线';
    $('#onlineBadgeTop').classList.toggle('offline', !n);
  }

  function handleWS(msg) {
    const { type } = msg;
    if (type === 'presence' || type === 'hello') {
      const n = msg.payload?.online ?? 1;
      state.devices = msg.payload?.devices || [];
      $('#onlineText').textContent = n > 1 ? `${n} 台设备在线` : '本机在线';
      $('#devCount').textContent = String(n);
      if (!$('#devModal').classList.contains('hidden')) renderDevList();
    }
    if (type === 'clip:created' || type === 'clip:updated' || type === 'clip:deleted') { loadClips().catch(() => {}); }
    if (type === 'file:created' || type === 'file:deleted') { loadFiles().catch(() => {}); }
    if (type === 'image:created' || type === 'image:updated' || type === 'image:deleted') { loadImages().catch(() => {}); }
    if (type === 'share:created' || type === 'share:deleted') { if (state.view === 'dashboard') loadDashboard().catch(() => {}); }
    if (type === 'cleanup') {
      toast(`自动清理完成:删除 ${msg.payload?.deletedTotal ?? 0} 条过期内容`, 'ok');
      if (state.view === 'dashboard') loadDashboard().catch(() => {});
    }
    if (type === 'upload:progress') {
      const p = msg.payload || {};
      if (p.ck && p.ck !== CLIENT_KEY) {
        state.remoteUploads.set(p.uploadId, { ...p, ts: Date.now() });
        renderRemoteUploads();
      }
    }
    if (type === 'upload:done' || type === 'upload:cancelled') {
      if (state.remoteUploads.delete(msg.payload?.uploadId)) renderRemoteUploads();
    }
    if (type === 'ddns:updated') {
      toast(`DDNS:${msg.payload?.message || '已更新'}`, msg.payload?.ok ? 'ok' : 'err');
    }
    if (type === 'settings:updated' && msg.payload?.applied) {
      const applied = msg.payload.applied;
      if (!isLocalSettingsEdit && Object.keys(applied).length) {
        toast('设置已在其他设备更新,已同步');
        if (state.view === 'settings') renderSettings();
      }
      if (applied.image_default_format !== undefined || applied.webp_quality !== undefined) loadSettings();
    }
  }
  let isLocalSettingsEdit = false;

  /* ============ 视图切换 ============ */
  const VIEW_TITLES = { files: '文件快传', clips: '剪贴板同步', images: '临时图床', dashboard: '仪表盘', settings: '设置' };
  function switchView(v) {
    state.view = v;
    $$('.view').forEach(el => el.classList.toggle('hidden', el.id !== `view-${v}`));
    $$('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === v));
    $$('.bn-item').forEach(el => el.classList.toggle('active', el.dataset.view === v));
    $('#viewTitle').textContent = VIEW_TITLES[v] || v;
    if (v === 'files') loadFiles();
    if (v === 'clips') loadClips();
    if (v === 'images') loadImages();
    if (v === 'dashboard') loadDashboard();
    if (v === 'settings') renderSettings();
  }
  $$('.nav-item, .bn-item').forEach(el => el.addEventListener('click', () => switchView(el.dataset.view)));

  /* ============ 文件上传 ============ */
  function pick(inputId) {
    const input = $(inputId);
    input.value = '';
    input.click();
  }
  $('#pickFilesBtn').addEventListener('click', () => pick('#fileInput'));
  $('#pickImagesBtn').addEventListener('click', () => pick('#imageInput'));
  $('#cameraBtn').addEventListener('click', () => pick('#cameraInput'));
  $('#imgPickBtn').addEventListener('click', () => pick('#imgFileInput'));
  $('#imgCameraBtn').addEventListener('click', () => pick('#imgCameraInput'));
  $('#imgPasteBtn').addEventListener('click', async () => {
    try {
      const items = await navigator.clipboard.read();
      const imgItem = items.find(i => i.types.some(t => t.startsWith('image/')));
      if (!imgItem) return toast('剪贴板中没有图片', 'err');
      const blob = await imgItem.getType(imgItem.types.find(t => t.startsWith('image/')));
      await processAndUploadImage(blob, autoImageName(blob));
    } catch (e) {
      toast(e.message.includes('permission') || e.name === 'NotAllowedError' ? '浏览器未授权读取剪贴板,请直接 Ctrl+V' : e.message, 'err');
    }
  });
  $('#clipPasteBtn').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return toast('系统剪贴板为空');
      $('#clipInput').value = text;
      $('#clipInput').dispatchEvent(new Event('input'));
      toast('已读取系统剪贴板内容');
    } catch { toast('浏览器未授权读取剪贴板,请手动粘贴', 'err'); }
  });

  $('#fileInput').addEventListener('change', (e) => uploadFileList(e.target.files, 'files'));
  $('#imageInput').addEventListener('change', (e) => uploadFileList(e.target.files, 'images'));
  $('#cameraInput').addEventListener('change', (e) => uploadFileList(e.target.files, 'images'));
  $('#imgFileInput').addEventListener('change', (e) => uploadFileList(e.target.files, 'images'));
  $('#imgCameraInput').addEventListener('change', (e) => uploadFileList(e.target.files, 'images'));

  function autoImageName(blob) {
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
    const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
    return `截图_${stamp}.${ext}`;
  }

  function uploadFileList(list, target) {
    const files = [...(list || [])];
    if (!files.length) return;
    const allImages = files.every(f => f.type.startsWith('image/'));
    const t = target || (allImages ? 'images' : 'files');
    for (const f of files) {
      if (t === 'images') processAndUploadImage(f, f.name);
      else uploadFile(f);
    }
  }

  function addTransferRow(rec, kind) {
    const id = `tr_${++state.uploadSeq}`;
    rec.rowId = id;
    rec.kind = kind;
    state.transfers.set(id, rec);
    renderTransfers();
    $('#transferPanel').classList.remove('hidden');
    return id;
  }

  function renderTransfers() {
    const list = $('#transferList');
    list.innerHTML = '';
    let hasActive = false;
    for (const [id, rec] of state.transfers) {
      if (!rec.done && !rec.failed) hasActive = true;
      const pct = rec.total ? Math.min(100, Math.round((rec.loaded / rec.total) * 100)) : 0;
      // 速率:取最近样本窗口
      let speed = 0;
      if (rec.samples && rec.samples.length >= 2) {
        const a = rec.samples[0], b = rec.samples[rec.samples.length - 1];
        const dt = (b.t - a.t) / 1000;
        if (dt > 0.05) speed = (b.b - a.b) / dt;
      }
      const remain = speed > 0 ? (rec.total - rec.loaded) / speed : null;
      const stateHtml = rec.failed
        ? `<span class="ti-state err">失败</span>`
        : rec.done
          ? `<span class="ti-state ok">✓ 完成</span>`
          : `<span class="ti-state">${pct}%</span>`;
      const el = document.createElement('div');
      el.className = 'transfer-item';
      el.innerHTML = `
        <div class="ti-row">
          <span class="ti-ico">${rec.kind === 'image' ? '🖼️' : '📄'}</span>
          <span class="ti-name">${esc(rec.name)}</span>
          <span class="ti-meta">${rec.done ? fmtSize(rec.size) : `${fmtSize(rec.loaded)} / ${fmtSize(rec.total)}`}</span>
          <span class="ti-speed">${!rec.done && speed > 0 ? fmtSize(speed) + '/s' : ''}${!rec.done && remain ? ' · 剩余 ' + (remain > 90 ? Math.round(remain / 60) + ' 分' : Math.ceil(remain) + ' 秒') : ''}</span>
          ${stateHtml}
          ${!rec.done ? `<button class="icon-btn" data-cancel="${id}" title="取消">✕</button>` : ''}
        </div>
        <div class="progress"><div class="progress-bar" style="width:${rec.done ? 100 : pct}%"></div></div>`;
      list.appendChild(el);
    }
    $$('#transferList [data-cancel]').forEach(b => b.addEventListener('click', () => {
      const rec = state.transfers.get(b.dataset.cancel);
      if (rec && rec.xhr) { try { rec.xhr.abort(); } catch { /* ignore */ } }
      state.transfers.delete(b.dataset.cancel);
      renderTransfers();
    }));
    const allDone = ![...state.transfers.values()].some(r => !r.done && !r.failed);
    if (allDone && state.transfers.size) setTimeout(() => { $('#transferPanel').classList.add('hidden'); }, 3500);
    $('#clearTransfers').style.display = state.transfers.size ? '' : 'none';
  }
  $('#clearTransfers').addEventListener('click', () => {
    for (const [id, rec] of [...state.transfers]) {
      if (rec.done || rec.failed) state.transfers.delete(id);
    }
    renderTransfers();
    if (!state.transfers.size) $('#transferPanel').classList.add('hidden');
  });

  async function uploadFile(file) {
    const maxMb = state.settings?.max_file_size_mb ?? 0;
    if (maxMb > 0 && file.size > maxMb * 1024 * 1024) {
      toast(`「${file.name}」超过大小上限 ${maxMb} MB`, 'err');
      return;
    }
    const url = `/api/files/upload?name=${encodeURIComponent(file.name)}&size=${file.size}&ck=${CLIENT_KEY}`;
    const rec = { name: file.name, size: file.size, loaded: 0, total: file.size, samples: [] };
    addTransferRow(rec, 'file');
    try {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        rec.xhr = xhr;
        xhr.open('POST', url);
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
        xhr.upload.onprogress = (e) => {
          if (!e.lengthComputable) return;
          rec.loaded = e.loaded; rec.total = e.total;
          const now = performance.now();
          rec.samples.push({ t: now, b: e.loaded });
          while (rec.samples.length > 12) rec.samples.shift();
          renderTransfers();
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else {
            let msg = `HTTP ${xhr.status}`;
            try { msg = JSON.parse(xhr.responseText).message || msg; } catch { /* ignore */ }
            reject(new Error(msg));
          }
        };
        xhr.onerror = () => reject(new Error('网络错误'));
        xhr.onabort = () => reject(Object.assign(new Error('已取消'), { cancelled: true }));
        xhr.send(file);
      });
      rec.done = true;
      renderTransfers();
      loadFiles();
    } catch (e) {
      rec.failed = true;
      if (!e.cancelled) { toast(`上传失败:${e.message}`, 'err'); renderTransfers(); }
      else state.transfers.delete(rec.rowId), renderTransfers();
    }
  }

  /* 图片处理(canvas 缩略图 / WebP 转换) */
  function loadImageEl(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  async function canvasConvert(blob, targetMime, quality) {
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImageEl(url);
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      const out = await new Promise(r => c.toBlob(r, targetMime, quality));
      if (!out) return null;
      return out.type === targetMime ? out : out; // 浏览器可能降级为 png,以实际类型为准
    } catch { return null; }
    finally { URL.revokeObjectURL(url); }
  }

  async function makeThumbBlob(blob) {
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImageEl(url);
      const scale = Math.min(1, 400 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * scale));
      c.height = Math.max(1, Math.round(img.naturalHeight * scale));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const t = await new Promise(r => c.toBlob(r, 'image/webp', 0.72));
      return t && t.type === 'image/webp' ? t : await new Promise(r => c.toBlob(r, 'image/jpeg', 0.72));
    } catch { return null; }
    finally { URL.revokeObjectURL(url); }
  }

  async function processAndUploadImage(file, name) {
    name = name || file.name || autoImageName(file);
    let blob = file, mime = file.type || 'image/png';
    const fmt = state.settings?.image_default_format || 'original';
    const quality = Number(state.settings?.webp_quality ?? 0.8);
    const target = fmt === 'webp' ? 'image/webp' : fmt === 'jpeg' ? 'image/jpeg' : null;
    if (target && target !== mime && mime !== 'image/svg+xml') {
      const converted = await canvasConvert(blob, target, quality);
      if (converted) {
        blob = converted; mime = converted.type;
        name = name.replace(/\.[^.]+$/, '') + (mime === 'image/webp' ? '.webp' : '.jpg');
      }
    }
    // 获取尺寸
    let width = null, height = null;
    try {
      const url = URL.createObjectURL(blob);
      const img = await loadImageEl(url);
      width = img.naturalWidth; height = img.naturalHeight;
      URL.revokeObjectURL(url);
    } catch { /* 非常规图片 */ }

    const url = `/api/images/upload?name=${encodeURIComponent(name)}&width=${width ?? ''}&height=${height ?? ''}&ck=${CLIENT_KEY}`;
    const rec = { name, size: blob.size, loaded: 0, total: blob.size, samples: [] };
    addTransferRow(rec, 'image');
    try {
      const row = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        rec.xhr = xhr;
        xhr.open('POST', url);
        xhr.setRequestHeader('Content-Type', mime);
        xhr.upload.onprogress = (e) => {
          if (!e.lengthComputable) return;
          rec.loaded = e.loaded; rec.total = e.total;
          const now = performance.now();
          rec.samples.push({ t: now, b: e.loaded });
          while (rec.samples.length > 12) rec.samples.shift();
          renderTransfers();
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) { try { resolve(JSON.parse(xhr.responseText)); } catch { resolve(null); } }
          else reject(new Error(`HTTP ${xhr.status}`));
        };
        xhr.onerror = () => reject(new Error('网络错误'));
        xhr.onabort = () => reject(Object.assign(new Error('已取消'), { cancelled: true }));
        xhr.send(blob);
      });
      rec.done = true;
      renderTransfers();
      // 缩略图
      const thumb = await makeThumbBlob(blob);
      if (thumb && row?.id) {
        try { await api(`/api/images/${row.id}/thumb`, { method: 'POST', headers: { 'Content-Type': thumb.type }, body: thumb }); } catch { /* 可选 */ }
      }
      loadImages();
      toast('图片已上传并生成直链', 'ok');
    } catch (e) {
      rec.failed = true;
      if (!e.cancelled) { toast(`图片上传失败:${e.message}`, 'err'); renderTransfers(); }
      else state.transfers.delete(rec.rowId), renderTransfers();
    }
  }

  /* WebP 转换按钮 */
  async function convertImageToWebP(item) {
    toast('正在转换 WebP…');
    try {
      const res = await fetch(`/api/images/${item.id}/raw`);
      const blob = await res.blob();
      const quality = Number(state.settings?.webp_quality ?? 0.8);
      const converted = await canvasConvert(blob, 'image/webp', quality);
      if (!converted) return toast('当前浏览器不支持 WebP 编码', 'err');
      const url = `/api/images/${item.id}/replace?width=&height=`;
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        xhr.setRequestHeader('Content-Type', 'image/webp');
        xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`)));
        xhr.onerror = () => reject(new Error('网络错误'));
        xhr.send(converted);
      });
      const thumb = await makeThumbBlob(converted);
      if (thumb) { try { await api(`/api/images/${item.id}/thumb`, { method: 'POST', headers: { 'Content-Type': thumb.type }, body: thumb }); } catch { /* ignore */ } }
      await loadImages();
      toast(`已转换为 WebP:${fmtSize(item.size)} → ${fmtSize(converted.size)}`, 'ok');
    } catch (e) { toast('转换失败:' + e.message, 'err'); }
  }

  /* ============ 拖拽与全局粘贴 ============ */
  let dragDepth = 0;
  window.addEventListener('dragover', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    $('#dropOverlay').classList.remove('hidden');
  });
  window.addEventListener('dragleave', (e) => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('#dropOverlay').classList.add('hidden');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('#dropOverlay').classList.add('hidden');
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    uploadFileList(files);
  });

  function isEditable(el) {
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  document.addEventListener('paste', (e) => {
    if (isEditable(e.target)) return; // 输入框内粘贴不劫持
    const dt = e.clipboardData;
    if (!dt) return;
    const imgItem = [...(dt.items || [])].find(i => i.kind === 'file' && i.type.startsWith('image/'));
    if (imgItem) {
      e.preventDefault();
      const blob = imgItem.getAsFile();
      if (blob) processAndUploadImage(blob, autoImageName(blob));
      return;
    }
    const text = dt.getData('text/plain');
    if (text && text.trim()) {
      e.preventDefault();
      createClipFromText(text);
    }
  });

  async function createClipFromText(text, tags = []) {
    try {
      await api('/api/clips', { method: 'POST', body: { content: text, tags } });
      toast('已加入剪贴板流,所有设备实时可见', 'ok');
    } catch (e) { if (e.status !== 401) toast('发送失败:' + e.message, 'err'); }
  }

  /* ============ 剪贴板视图 ============ */
  const clipInput = $('#clipInput');
  clipInput.addEventListener('input', debounce(() => {
    const lang = window.LHHighlight.detectLang(clipInput.value);
    const chip = $('#clipDetect');
    if (lang && clipInput.value.trim().length > 8) {
      chip.textContent = `已识别:${({ 'plaintext-code': '代码', javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python', json: 'JSON', html: 'HTML', css: 'CSS', bash: 'Shell', sql: 'SQL', java: 'Java', go: 'Go', c: 'C/C++', rust: 'Rust' })[lang] || lang}`;
      chip.classList.remove('hidden');
    } else chip.classList.add('hidden');
  }, 250));

  $('#clipSendBtn').addEventListener('click', async () => {
    const text = clipInput.value;
    if (!text.trim()) return toast('请输入内容');
    const tags = $('#clipTags').value.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
    await createClipFromText(text, tags);
    clipInput.value = ''; $('#clipTags').value = '';
    $('#clipDetect').classList.add('hidden');
    loadClips();
  });

  $$('#clipFilters .chip').forEach(ch => ch.addEventListener('click', () => {
    state.clipFilter = ch.dataset.f;
    $$('#clipFilters .chip').forEach(c => c.classList.toggle('active', c === ch));
    renderClips();
  }));

  const clipSearchDebounced = debounce(() => loadClips(), 350);
  $('#clipSearch').addEventListener('input', clipSearchDebounced);

  async function loadClips() {
    try {
      const search = $('#clipSearch').value.trim();
      const q = search ? `?search=${encodeURIComponent(search)}&limit=200` : '?limit=200';
      const data = await api('/api/clips' + q);
      state.clips = data.items;
      renderClips();
    } catch (e) { if (e.status !== 401) console.warn(e.message); }
  }

  function linkify(text) {
    return esc(text).replace(/(https?:\/\/[^\s<>"')]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  }

  function renderClips() {
    const list = $('#clipList');
    let items = state.clips;
    if (state.clipFilter === 'pinned') items = items.filter(c => c.pinned);
    else if (state.clipFilter === 'favorite') items = items.filter(c => c.favorite);
    else if (state.clipFilter === 'code') items = items.filter(c => c.content_type === 'code');
    $('#clipEmpty').classList.toggle('hidden', items.length > 0);
    list.innerHTML = '';
    for (const c of items) {
      const isCode = c.content_type === 'code' && c.lang;
      const long = (c.content || '').length > 600 || (c.content || '').split('\n').length > 8;
      const el = document.createElement('div');
      el.className = 'clip-card';
      const langName = ({ 'plaintext-code': '代码', javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python', json: 'JSON', html: 'HTML', css: 'CSS', bash: 'Shell', sql: 'SQL', java: 'Java', go: 'Go', c: 'C/C++', rust: 'Rust' })[c.lang] || c.lang;
      const bodyHtml = isCode
        ? `<pre class="codeblock ${long ? 'collapsed' : ''}" data-id="${c.id}"><code>${window.LHHighlight.highlight(c.content, c.lang)}</code></pre>`
        : `<div class="clip-text ${long ? 'collapsed' : ''}" data-id="${c.id}">${linkify(c.content)}</div>`;
      el.innerHTML = `
        <div class="clip-head">
          <span>${fmtTime(c.created_at)}</span>
          <span class="device-chip">${esc(c.device || '未知设备')}</span>
          ${isCode ? `<span class="lang-chip">${esc(langName)}</span>` : ''}
          ${c.pinned ? '<span class="pin-badge">📌</span>' : ''}
          ${c.favorite ? '<span>⭐</span>' : ''}
          ${(c.tags || []).map(t => `<span class="tag">#${esc(t)}</span>`).join('')}
        </div>
        <div class="clip-body">${bodyHtml}${long ? `<button class="clip-expand" data-expand="${c.id}">展开全部 ▾</button>` : ''}</div>
        <div class="clip-foot">
          <button class="btn btn-soft btn-sm" data-copy="${c.id}">复制</button>
          <button class="icon-btn" data-pin="${c.id}" title="置顶">📌</button>
          <button class="icon-btn" data-fav="${c.id}" title="收藏">⭐</button>
          <button class="btn btn-ghost btn-sm" data-share-clip="${c.id}">🔗 分享</button>
          <div class="grow"></div>
          <button class="icon-btn danger" data-del="${c.id}" title="删除">🗑</button>
        </div>`;
      list.appendChild(el);
    }
    $$('#clipList [data-expand]').forEach(b => b.addEventListener('click', () => {
      const body = $(`[data-id="${b.dataset.expand}"]`, list.closest('.clip-list')) || list.querySelector(`[data-id="${b.dataset.expand}"]`);
      if (body) {
        body.classList.toggle('collapsed');
        b.textContent = body.classList.contains('collapsed') ? '展开全部 ▾' : '收起 ▴';
      }
    }));
    $$('#clipList [data-copy]').forEach(b => b.addEventListener('click', async () => {
      const c = state.clips.find(x => x.id == b.dataset.copy);
      if (c && await copyText(c.content)) toast('已复制到系统剪贴板', 'ok');
    }));
    $$('#clipList [data-pin]').forEach(b => b.addEventListener('click', async () => {
      const c = state.clips.find(x => x.id == b.dataset.pin);
      await api(`/api/clips/${c.id}`, { method: 'PATCH', body: { pinned: !c.pinned } });
      loadClips();
    }));
    $$('#clipList [data-fav]').forEach(b => b.addEventListener('click', async () => {
      const c = state.clips.find(x => x.id == b.dataset.fav);
      await api(`/api/clips/${c.id}`, { method: 'PATCH', body: { favorite: !c.favorite } });
      loadClips();
    }));
    $$('#clipList [data-del]').forEach(b => b.addEventListener('click', async () => {
      await api(`/api/clips/${b.dataset.del}`, { method: 'DELETE' });
      toast('已删除');
      loadClips();
    }));
    $$('#clipList [data-share-clip]').forEach(b => b.addEventListener('click', () => {
      const c = state.clips.find(x => x.id == b.dataset.shareClip);
      openShareModal('clip', c.id, (c.content || '').slice(0, 60));
    }));
  }

  /* ============ 文件视图 ============ */
  const fileSearchDebounced = debounce(() => loadFiles(), 350);
  $('#fileSearch').addEventListener('input', fileSearchDebounced);
  const selectedFiles = new Set();

  async function loadFiles() {
    try {
      const search = $('#fileSearch').value.trim();
      const data = await api('/api/files' + (search ? `?search=${encodeURIComponent(search)}` : ''));
      state.files = data.items;
      for (const id of [...selectedFiles]) {
        if (!state.files.find(f => f.id === id)) selectedFiles.delete(id);
      }
      renderFiles();
    } catch (e) { if (e.status !== 401) console.warn(e.message); }
  }

  function fileIcon(name) {
    const ext = (name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase() || '';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'avif'].includes(ext)) return ['🖼️', '#ECFEFF'];
    if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) return ['🎬', '#FEF3C7'];
    if (['mp3', 'wav', 'flac', 'ogg', 'm4a'].includes(ext)) return ['🎵', '#F3E8FF'];
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return ['🗜️', '#FEE2E2'];
    if (['pdf'].includes(ext)) return ['📕', '#FEE2E2'];
    if (['doc', 'docx', 'txt', 'md', 'rtf'].includes(ext)) return ['📝', '#DBEAFE'];
    if (['xls', 'xlsx', 'csv'].includes(ext)) return ['📊', '#DCFCE7'];
    if (['js', 'ts', 'py', 'json', 'html', 'css', 'java', 'go', 'c', 'cpp', 'sh'].includes(ext)) return ['💻', '#E0E7FF'];
    return ['📦', '#F1F5F9'];
  }

  function renderFiles() {
    const list = $('#fileList');
    $('#filesCount').textContent = state.files.length;
    $('#fileEmpty').classList.toggle('hidden', state.files.length > 0);
    list.innerHTML = '';
    for (const f of state.files) {
      const [ico, bg] = fileIcon(f.name);
      const el = document.createElement('div');
      el.className = 'file-card';
      el.innerHTML = `
        <input type="checkbox" class="file-check" data-check="${f.id}" ${selectedFiles.has(f.id) ? 'checked' : ''}>
        <div class="file-ico" style="background:${bg}">${ico}</div>
        <div class="file-info">
          <div class="file-name">${esc(f.name)}</div>
          <div class="file-meta">${fmtSize(f.size)} · ${fmtTime(f.created_at)} · <span class="device-chip">${esc(f.device || '未知设备')}</span></div>
        </div>
        <div class="file-actions">
          <a class="btn btn-soft btn-sm" href="/api/files/${f.id}/download" download><span class="btn-label">下载</span>⬇</a>
          <button class="btn btn-ghost btn-sm" data-share="${f.id}">🔗<span class="btn-label"> 分享</span></button>
          <button class="icon-btn danger" data-del="${f.id}" title="删除">🗑</button>
        </div>`;
      list.appendChild(el);
    }
    $$('#fileList [data-check]').forEach(cb => cb.addEventListener('change', () => {
      const id = Number(cb.dataset.check);
      if (cb.checked) selectedFiles.add(id); else selectedFiles.delete(id);
      updateBatchButtons();
    }));
    $$('#fileList [data-del]').forEach(b => b.addEventListener('click', async () => {
      await api(`/api/files/${b.dataset.del}`, { method: 'DELETE' });
      toast('文件已删除');
      loadFiles();
    }));
    $$('#fileList [data-share]').forEach(b => b.addEventListener('click', () => {
      const f = state.files.find(x => x.id == b.dataset.share);
      openShareModal('file', f.id, f.name);
    }));
    updateBatchButtons();
  }

  function updateBatchButtons() {
    const n = selectedFiles.size;
    $('#zipSelectedBtn').disabled = n === 0;
    $('#delSelectedBtn').disabled = n === 0;
    $('#zipSelectedBtn').textContent = n ? `⬇ ZIP 打包下载 (${n})` : '⬇ ZIP 打包下载';
    $('#delSelectedBtn').textContent = n ? `删除所选 (${n})` : '删除所选';
  }

  $('#zipSelectedBtn').addEventListener('click', () => {
    if (!selectedFiles.size) return;
    window.open(`/api/files/download.zip?ids=${[...selectedFiles].join(',')}`, '_blank');
  });
  $('#delSelectedBtn').addEventListener('click', async () => {
    if (!selectedFiles.size) return;
    if (!confirm(`确定删除所选 ${selectedFiles.size} 个文件?`)) return;
    await api('/api/files/delete-batch', { method: 'POST', body: { ids: [...selectedFiles] } });
    selectedFiles.clear();
    toast('所选文件已删除');
    loadFiles();
  });

  /* ============ 图床视图 ============ */
  async function loadImages() {
    try {
      const data = await api('/api/images?limit=200');
      state.images = data.items;
      renderImages();
    } catch (e) { if (e.status !== 401) console.warn(e.message); }
  }

  function renderImages() {
    const grid = $('#imageGrid');
    $('#imageEmpty').classList.toggle('hidden', state.images.length > 0);
    grid.innerHTML = '';
    for (const img of state.images) {
      const src = `/api/images/${img.id}/${img.has_thumb ? 'thumb' : 'raw'}`;
      const el = document.createElement('div');
      el.className = 'image-card';
      const direct = `${location.origin}/api/images/${img.id}/raw`;
      el.innerHTML = `
        <div class="image-thumb"><img src="${src}" loading="lazy" alt="${esc(img.name)}"></div>
        <div class="image-info">
          <div class="image-name" title="${esc(img.name)}">${esc(img.name)} ${img.mime === 'image/webp' ? '<span class="badge-webp">WebP</span>' : ''}</div>
          <div class="image-meta">${fmtSize(img.size)}${img.width ? ` · ${img.width}×${img.height}` : ''} · ${fmtTime(img.created_at)}</div>
        </div>
        <div class="image-actions">
          <button class="img-act" data-cp="direct" title="复制图片直链">直链</button>
          <button class="img-act" data-cp="md" title="复制 Markdown 格式">MD</button>
          <button class="img-act" data-cp="html" title="复制 HTML 标签">HTML</button>
          ${img.mime !== 'image/webp' ? `<button class="img-act" data-convert="${img.id}">转 WebP</button>` : ''}
          <button class="img-act" data-share="${img.id}">分享</button>
          <a class="img-act" href="/api/images/${img.id}/raw?dl=1" download>下载</a>
          <button class="img-act danger" data-del="${img.id}">删除</button>
        </div>`;
      grid.appendChild(el);
    }
    $$('#imageGrid [data-cp]').forEach(b => b.addEventListener('click', async () => {
      const card = b.closest('.image-card');
      const id = Number(card.querySelector('[data-del]').dataset.del);
      const img = state.images.find(x => x.id === id);
      const direct = `${location.origin}/api/images/${id}/raw`;
      const kind = b.dataset.cp;
      const text = kind === 'direct' ? direct : kind === 'md' ? `![img](${direct})` : `<img src="${direct}" alt="${esc(img?.name || 'img')}" />`;
      if (await copyText(text)) toast(kind === 'direct' ? '直链已复制' : kind === 'md' ? 'Markdown 已复制' : 'HTML 已复制', 'ok');
    }));
    $$('#imageGrid [data-convert]').forEach(b => b.addEventListener('click', () => {
      const img = state.images.find(x => x.id == b.dataset.convert);
      convertImageToWebP(img);
    }));
    $$('#imageGrid [data-share]').forEach(b => b.addEventListener('click', () => {
      const card = b.closest('.image-card');
      const id = Number(card.querySelector('[data-del]').dataset.del);
      const img = state.images.find(x => x.id === id);
      openShareModal('image', id, img?.name || '图片');
    }));
    $$('#imageGrid [data-del]').forEach(b => b.addEventListener('click', async () => {
      await api(`/api/images/${b.dataset.del}`, { method: 'DELETE' });
      toast('图片已删除');
      loadImages();
    }));
  }

  /* ============ 仪表盘 ============ */
  async function loadDashboard() {
    try {
      const [d, shares] = await Promise.all([api('/api/system/dashboard'), api('/api/share/list')]);
      renderFirewallCheck(); // 不阻塞仪表盘主体渲染
      const grid = $('#statGrid');
      const df = d.diskFree, dt = d.diskTotal;
      grid.innerHTML = `
        <div class="card stat-card">
          <div class="stat-label">已用存储</div>
          <div class="stat-value">${fmtSize(d.totalSize)}</div>
          <div class="stat-sub">文件 ${fmtSize(d.files.size)} · 图片 ${fmtSize(d.images.size)}</div>
        </div>
        <div class="card stat-card">
          <div class="stat-label">磁盘剩余空间</div>
          <div class="stat-value">${df != null ? fmtSize(df) : '未知'}</div>
          <div class="stat-sub">${df != null && dt ? `总容量 ${fmtSize(dt)} · 已用 ${Math.round(((dt - df) / dt) * 100)}%` : '无法获取磁盘信息'}</div>
        </div>
        <div class="card stat-card">
          <div class="stat-label">在线设备</div>
          <div class="stat-value">${d.onlineDevices}</div>
          <div class="stat-sub">通过 WebSocket 实时连接</div>
        </div>
        <div class="card stat-card">
          <div class="stat-label">条目统计</div>
          <div class="stat-value">${d.clips.count + d.files.count + d.images.count}</div>
          <div class="stat-sub">剪贴板 ${d.clips.count} · 文件 ${d.files.count} · 图片 ${d.images.count}</div>
        </div>`;
      const c = d.cleaner;
      const last = c?.lastResult;
      $('#cleanupInfo').innerHTML = `
        <div>自动清理:<b>${d.autoCleanup ? '已开启' : '已关闭'}</b> · 每 ${d.cleanupIntervalMinutes} 分钟执行一次</div>
        <div>内容保留时长:<b>${d.retentionMinutes === 0 ? '永久保留' : fmtMinutes(d.retentionMinutes)}</b> · 分享过期后自动移除</div>
        <div>上次执行:${c?.lastRun ? fmtTime(c.lastRun) : '尚未执行'}${last ? ` · 清理分享 ${last.sharesDeleted} / 剪贴板 ${last.clipsDeleted} / 文件 ${last.filesDeleted} / 图片 ${last.imagesDeleted} / 孤儿 ${last.orphansDeleted}` : ''}</div>`;
      // 分享管理
      $('#shareCount').textContent = `${shares.items.length} 条`;
      const sm = $('#shareManageList');
      sm.innerHTML = shares.items.length ? '' : '<div class="empty" style="padding:18px 0">还没有分享链接</div>';
      for (const s of shares.items) {
        const expired = s.expires_at && s.expires_at < Date.now();
        const el = document.createElement('div');
        el.className = 'share-row';
        el.innerHTML = `
          <span class="s-name" title="${esc(s.target_name || '')}">${esc(s.target_name || '(内容已删除)')}</span>
          <span class="s-meta">${s.code ? `提取码 <b>${esc(s.code)}</b> · ` : ''}${s.burn_after_read ? '<span class="burn-chip">阅后即焚</span> · ' : ''}${expired ? '<span class="share-expired">已过期</span>' : (s.expires_at ? `剩余 ${fmtRemaining(s.expires_at)}` : '永久')} · 被访问 ${s.access_count} 次</span>
          <a class="icon-btn" href="/s/${esc(s.slug)}${s.code ? '' : ''}" target="_blank" title="打开">↗</a>
          <button class="icon-btn danger" data-revoke="${s.id}" title="撤销">🗑</button>`;
        sm.appendChild(el);
      }
      $$('#shareManageList [data-revoke]').forEach(b => b.addEventListener('click', async () => {
        await api(`/api/share/${b.dataset.revoke}`, { method: 'DELETE' });
        toast('分享已撤销');
        loadDashboard();
      }));
    } catch (e) { if (e.status !== 401) console.warn(e.message); }
  }
  /* 连通性自检卡片:检测防火墙对手机入站的影响 */
  async function renderFirewallCheck() {
    const box = $('#firewallCheck');
    const fixBtn = $('#fwFixBtn');
    if (!box) return;
    let fw;
    try { fw = await api('/api/system/firewall'); }
    catch (e) { if (e.status !== 401) box.innerHTML = `<div class="fw-row">连通性检测不可用:${esc(e.message)}</div>`; return; }

    box.innerHTML = `
      ${fw.items.map(it => `
        <div class="fw-row ${it.ok ? 'ok' : 'bad'}">
          <span class="fw-ico">${it.ok ? '✓' : (it.warnOnly ? '⚠️' : '✗')}</span>
          <span>${esc(it.label)}</span>
        </div>`).join('')}
      <div class="fw-verdict ${fw.needsFix ? 'bad' : ''}">${esc(fw.verdict)}</div>
      ${(fw.alternative || []).map(a => `
        <div class="fw-alt">💡 免防火墙备用通道:<b>${esc(a.url)}</b> — ${esc(a.note)}
          <button class="btn btn-ghost btn-sm" data-fw-alt="${esc(a.url)}">复制地址</button>
        </div>`).join('')}`;
    fixBtn.classList.toggle('hidden', fw.supported !== true);
    fixBtn.disabled = false;
    fixBtn.textContent = fw.needsFix ? '🔧 一键修复防火墙' : '🔧 添加放行规则(保险)';

    $$('#firewallCheck [data-fw-alt]').forEach(b => b.addEventListener('click', async () => {
      if (await copyText(b.dataset.fwAlt)) toast('备用地址已复制', 'ok');
    }));
  }

  // 面板定时自刷新,推动过期条目自动消失
  setInterval(() => { if (state.remoteUploads.size) renderRemoteUploads(); }, 5000);

  $('#fwFixBtn').addEventListener('click', async () => {
    const btn = $('#fwFixBtn');
    btn.disabled = true;
    btn.textContent = '请在弹出的 UAC 窗口点击"是"…';
    toast('正在发起提权请求,请在屏幕弹窗中确认');
    try {
      const r = await api('/api/system/firewall/fix', { method: 'POST' });
      if (r.ok) toast(r.message, 'ok');
      else toast(r.message, 'err');
      renderFirewallCheck();
    } catch (e) {
      if (e.status !== 401) { toast('修复失败:' + e.message, 'err'); renderFirewallCheck(); }
    }
  });

  function fmtMinutes(m) {
    if (m >= 1440) return (m / 1440) % 1 === 0 ? `${m / 1440} 天` : `${(m / 1440).toFixed(1)} 天`;
    return `${m} 分钟`;
  }

  $('#runCleanupBtn').addEventListener('click', async () => {
    toast('正在执行清理…');
    try {
      const r = await api('/api/system/cleanup', { method: 'POST' });
      const t = r.result.deletedTotal ?? (r.result.sharesDeleted + r.result.clipsDeleted + r.result.filesDeleted + r.result.imagesDeleted + r.result.orphansDeleted);
      toast(`清理完成,共删除 ${t} 项`, 'ok');
      loadDashboard();
    } catch (e) { toast('清理失败:' + e.message, 'err'); }
  });

  /* ============ 设置页 ============ */
  async function renderSettings() {
    try {
      const data = await api('/api/system/settings');
      state.settingsItems = data.items;
      const groups = [
        { title: '传输与存储', keys: ['max_file_size_mb', 'port'] },
        { title: '图床', keys: ['image_default_format', 'webp_quality'] },
        { title: '自动清理', keys: ['auto_cleanup_enabled', 'cleanup_interval_minutes', 'item_retention_minutes'] },
        { title: '访问保护', keys: ['access_password_enabled', 'access_password'] },
        { title: 'IPv6', keys: ['ipv6_enabled'] },
        { title: '远程访问(DDNS 动态域名)', keys: ['ddns_enabled', 'ddns_provider', 'ddns_domain', 'ddns_token', 'ddns_zone_id', 'ddns_url_template', 'ddns_interval_minutes'] },
      ];
      const DDNS_FIELDS = {
        dnspod: ['ddns_domain', 'ddns_token', 'ddns_interval_minutes'],
        aliyun: ['ddns_domain', 'ddns_token', 'ddns_interval_minutes'],
        cloudflare: ['ddns_domain', 'ddns_token', 'ddns_zone_id', 'ddns_interval_minutes'],
        desec: ['ddns_domain', 'ddns_token', 'ddns_interval_minutes'],
        godaddy: ['ddns_domain', 'ddns_token', 'ddns_interval_minutes'],
        duckdns: ['ddns_domain', 'ddns_token', 'ddns_interval_minutes'],
        dynv6: ['ddns_domain', 'ddns_token', 'ddns_interval_minutes'],
        dynu: ['ddns_domain', 'ddns_token', 'ddns_interval_minutes'],
        noip: ['ddns_domain', 'ddns_token', 'ddns_interval_minutes'],
        custom: ['ddns_domain', 'ddns_token', 'ddns_url_template', 'ddns_interval_minutes'],
      };
      const provider = data.items.find(x => x.key === 'ddns_provider')?.value || 'dnspod';
      const enabled = !!data.items.find(x => x.key === 'ddns_enabled')?.value;
      const wrap = $('#settingsWrap');
      wrap.innerHTML = '';
      for (const g of groups) {
        const card = document.createElement('div');
        card.className = 'settings-group';
        card.innerHTML = `<h3>${g.title}</h3>`;
        // DDNS 状态行(显示检测结果;测试按钮不依赖启用状态)
        if (g.keys.includes('ddns_enabled')) {
          const statusRow = document.createElement('div');
          statusRow.className = 'setting-row';
          statusRow.innerHTML = `<div class="setting-info"><div class="setting-desc" id="ddnsStatus">读取状态中…</div></div>
            <div class="setting-ctrl">
              <button id="ddnsTestBtn" class="btn btn-soft btn-sm" title="不启用 DDNS 也能测试,分步诊断问题">🧪 测试</button>
              <button id="ddnsRunBtn" class="btn btn-soft btn-sm" ${enabled ? '' : 'disabled'}>⚡ 立即更新</button>
            </div>`;
          card.appendChild(statusRow);
        }
        for (const key of g.keys) {
          const it = data.items.find(x => x.key === key);
          if (!it) continue;
          // 按服务商隐藏无关字段
          if (['ddns_domain', 'ddns_token', 'ddns_zone_id', 'ddns_url_template'].includes(key)
            && !DDNS_FIELDS[provider].includes(key)) continue;
          const row = renderSettingRow(it, data.restartRequired);
          if (key === 'ddns_provider') {
            // 服务商切换后刷新显示的字段
            row.querySelector('[data-set]').addEventListener('change', () => setTimeout(renderSettings, 600));
          }
          card.appendChild(row);
        }
        wrap.appendChild(card);
        if (g.keys.includes('ddns_enabled')) loadDdnsStatus();
      }
    } catch (e) { if (e.status !== 401) console.warn(e.message); }
  }

  function renderSettingRow(it, restartRequired) {
    const row = document.createElement('div');
    row.className = 'setting-row';
    const restart = restartRequired?.includes(it.key) ? '<span class="restart-chip">重启生效</span>' : '';
    let ctrl = '';
    if (it.type === 'switch') {
      ctrl = `<label class="switch"><input type="checkbox" data-set="${it.key}" ${it.value ? 'checked' : ''}><span class="track"></span></label>`;
    } else if (it.type === 'select') {
      ctrl = `<select class="select" data-set="${it.key}" style="width:auto">${it.options.map(o => `<option value="${o}" ${it.value === o ? 'selected' : ''}>${esc(it.optionLabels?.[o] || o)}</option>`).join('')}</select>`;
    } else if (it.type === 'text') {
      ctrl = `<input class="number-input" style="width:240px;text-align:left" type="text" data-set="${it.key}" value="${esc(it.value || '')}" autocomplete="off">`;
    } else if (it.type === 'slider') {
      ctrl = `<div class="slider-row"><input type="range" data-set="${it.key}" min="${it.min}" max="${it.max}" step="${it.step}" value="${it.value}"><span class="slider-val" data-slider-val>${Math.round(it.value * 100)}%</span></div>`;
    } else if (it.type === 'password') {
      // 密文显示:已保存时输入框为空、占位符显示圆点;小眼睛可查看明文(访问口令为哈希,不可查看)
      const isAccess = it.key === 'access_password';
      const saved = isAccess ? it.passwordSet : !!it.value;
      const ph = isAccess
        ? (saved ? '••••••••(已设置,留空=不变)' : '4~64 位口令')
        : (saved ? '••••••••(已保存,留空=不变)' : '令牌');
      ctrl = `<div class="token-box"><input class="number-input" style="width:200px;text-align:left" type="text" data-set="${it.key}" value="" placeholder="${ph}" data-original="${esc(it.value || '')}" autocomplete="new-password">${isAccess ? '' : '<button type="button" class="icon-btn" data-reveal="1" title="查看/隐藏明文">👁</button>'}</div>`;
    } else {
      const unit = it.key.includes('mb') ? 'MB' : '分钟';
      ctrl = `<input class="number-input" type="number" data-set="${it.key}" min="${it.min}" max="${it.max}" value="${it.value}"><span class="unit">${unit}</span>`;
    }
    let desc = it.desc || '';
    if (it.key === 'item_retention_minutes') {
      desc += ` 当前:约 ${it.value === 0 ? '永久保留' : fmtMinutes(it.value)}` + (restart ? '' : '');
    }
    row.innerHTML = `
      <div class="setting-info">
        <div class="setting-label">${esc(it.label)}${restart}</div>
        <div class="setting-desc">${esc(desc)}</div>
      </div>
      <div class="setting-ctrl">${ctrl}</div>`;
    const input = row.querySelector('[data-set]');
    input.addEventListener('change', () => saveSetting(input));
    // 小眼睛:查看/隐藏已保存的令牌明文(DDNS 令牌为明文存储以供 API 调用)
    const eye = row.querySelector('[data-reveal]');
    if (eye) {
      let shown = false;
      eye.addEventListener('click', () => {
        shown = !shown;
        if (shown) { input.value = it.value || ''; eye.textContent = '🙈'; }
        else { input.value = ''; eye.textContent = '👁'; }
      });
    }
    if (input.type === 'range') {
      input.addEventListener('input', () => {
        row.querySelector('[data-slider-val]').textContent = Math.round(Number(input.value) * 100) + '%';
      });
    }
    return row;
  }

  async function saveSetting(input) {
    const key = input.dataset.set;
    let value;
    if (input.type === 'checkbox') value = input.checked;
    else if (input.type === 'range') value = Number(input.value);
    else if (input.type === 'number') value = Number(input.value);
    else value = input.value;
    // 密文态字段:值未实际修改时不提交(眼睛查看后失焦不会误存)
    if (input.dataset.original !== undefined && value === input.dataset.original) {
      return;
    }
    // 访问口令留空 = 保持不变(服务端不会覆盖),不发请求
    if (key === 'access_password' && !String(value).trim()) {
      toast('口令未修改(留空保持原值)');
      return;
    }
    isLocalSettingsEdit = true;
    try {
      const res = await api('/api/system/settings', { method: 'PUT', body: { [key]: value } });
      toast(res.notice || '设置已保存', res.notice ? 'ok' : 'ok');
      await loadSettings();
    } catch (e) {
      toast(e.message || '保存失败', 'err');
      renderSettings();
    } finally {
      setTimeout(() => { isLocalSettingsEdit = false; }, 400);
    }
  }

  async function loadSettings() {
    try {
      const data = await api('/api/system/settings');
      state.settings = Object.fromEntries(data.items.map(i => [i.key, i.value]));
    } catch { /* ignore */ }
  }

  /* 其他设备上传的实时面板 */
  function renderRemoteUploads() {
    const panel = $('#remoteUploads');
    const list = $('#remoteUploadList');
    if (!panel || !list) return;
    // 过期清理:45 秒无更新的条目视为已中断,自动消失
    const now = Date.now();
    for (const [id, p] of [...state.remoteUploads]) {
      if (p.ts && now - p.ts > 45000) state.remoteUploads.delete(id);
    }
    const items = [...state.remoteUploads.values()];
    panel.classList.toggle('hidden', items.length === 0);
    list.innerHTML = items.map(p => {
      const known = !!p.size;
      const pct = known ? Math.min(100, Math.round((p.loaded / p.size) * 100)) : 0;
      return `
        <div class="ru-item">
          <div class="ru-row">
            <span class="ru-name">${esc(p.name)}</span>
            <span class="ru-meta">${known ? `${fmtSize(p.loaded)} / ${fmtSize(p.size)} · ${pct}%` : `已上传 ${fmtSize(p.loaded)}`}</span>
            <span class="ru-device">${esc(p.device || '设备')}</span>
          </div>
          <div class="progress"><div class="progress-bar" style="width:${known ? pct : 100}%;${known ? '' : 'opacity:.35'}"></div></div>
        </div>`;
    }).join('');
  }

  /* ============ 在线设备面板 ============ */
  function renderDevList() {
    const list = $('#devList');
    if (!list) return;
    const items = state.devices;
    $('#devCount').textContent = String(items.length);
    list.innerHTML = items.length ? '' : '<div class="empty" style="padding:16px 0">当前没有设备在线</div>';
    for (const d of items) {
      const self = d.key === CLIENT_KEY;
      const icon = /windows|linux|macos/i.test(d.device) ? '💻' : /android|iphone|ipad/i.test(d.device) ? '📱' : '🖥️';
      // 回环地址 = 设备与服务器在同一台电脑,展示为"本机";其余显示真实来源 IP
      const addr = (d.address === '127.0.0.1' || d.address === '::1')
        ? '本机(与服务器同一台设备)'
        : `${esc(d.address)}`;
      const el = document.createElement('div');
      el.className = 'dev-row';
      el.innerHTML = `
        <span class="dev-ico">${icon}</span>
        <div class="dev-info">
          <div class="dev-name">${esc(d.device)}${self ? ' <span class="dev-self">本设备</span>' : ''}${d.connections > 1 ? ` <span class="dev-conn">${d.connections} 个标签页</span>` : ''}</div>
          <div class="dev-addr">来源地址:${addr} · 接入于 ${fmtTime(d.connectedAt)}</div>
        </div>`;
      list.appendChild(el);
    }
  }

  function openDevModal() {
    $('#devModal').classList.remove('hidden');
    if (state.devices.length) renderDevList();
    else api('/api/system/devices').then(d => { state.devices = d.items; renderDevList(); }).catch(() => { $('#devList').textContent = '读取失败'; });
  }
  $('#onlineBadge').addEventListener('click', openDevModal);
  $('#onlineBadgeTop').addEventListener('click', openDevModal);
  $('#onlineText').parentElement.style.cursor = 'pointer';

  /* 🧪 测试按钮:免启用诊断(探测地址 → 连接服务商 → 写入解析)
     ⚠️ 按钮位于动态渲染的状态行中,必须用事件委托绑定,不能在加载时直接 attach */
  async function runDdnsTest() {
    const btn = $('#ddnsTestBtn');
    if (btn) { btn.disabled = true; btn.textContent = '🧪 测试中…'; }
    try {
      const r = await api('/api/system/ddns/test', { method: 'POST' });
      const dur = r.durationMs ? `(${(r.durationMs / 1000).toFixed(1)}s)` : '';
      toast(`${r.ok ? '测试通过' : '测试失败'}:${r.message} ${dur}`, r.ok ? 'ok' : 'err');
    } catch (e) { if (e.status !== 401) toast('测试失败:' + e.message, 'err'); }
    loadDdnsStatus();
    const again = $('#ddnsTestBtn');
    if (again) { again.disabled = false; again.textContent = '🧪 测试'; }
  }

  /* DDNS 状态显示与手动更新 */
  async function loadDdnsStatus() {
    const box = $('#ddnsStatus');
    if (!box) return;
    try {
      const d = await api('/api/system/ddns');
      const last = d.lastResult;
      const time = d.lastRun ? fmtTime(d.lastRun) : '尚未执行';
      const ipPart = [];
      if (d.localIPv6) ipPart.push(`IPv6 <b>${esc(d.localIPv6)}</b>`);
      if (d.ipv4Local) ipPart.push(`IPv4(局域网) ${esc(d.ipv4Local)}`);
      const offHint = d.enabled
        ? ''
        : `<div style="color:var(--warn)">已关闭:停止解析更新,并<b>拒绝来自公网的连接</b>(局域网与 Tailscale 不受影响,远端访问在下次请求时即被拒)。如需彻底下线域名,请到服务商后台删除对应记录。</div>`;
      const fullDdnsUrl = d.domain ? `http://${d.domain}:${location.port}` : null;
      box.innerHTML = `
        <div>定时任务:<b>${d.enabled ? '已启用' : '未启用'}</b> · 每 ${d.intervalMinutes} 分钟 · 上次:${time}${last ? ` · ${esc(last.message)}` : ''}</div>
        <div>将发布的地址:${ipPart.length ? ipPart.join(' · ') : '未检测到全局 IPv6(公网 IPv4 需联网探测)'}${d.domain ? ` · 目标:<b>${esc(d.domain)}</b> <button class="btn btn-ghost btn-sm" data-ddns-url="${esc(fullDdnsUrl)}">复制完整地址(含端口)</button>` : ''}</div>
        ${offHint}
        <div style="color:var(--warn)">公网可访问时请务必开启「访问口令保护」,并确认路由器未拦截 IPv6 入站。</div>`;
    } catch (e) { if (e.status !== 401) box.textContent = '状态读取失败:' + e.message; }
  }

  async function runDdnsNow() {
    const btn = $('#ddnsRunBtn');
    if (btn) { btn.disabled = true; btn.textContent = '正在更新…'; }
    try {
      const r = await api('/api/system/ddns/run', { method: 'POST' });
      toast(r.message, r.ok ? 'ok' : 'err');
    } catch (e) { if (e.status !== 401) toast('更新失败:' + e.message, 'err'); }
    loadDdnsStatus();
    const again = $('#ddnsRunBtn');
    if (again) { again.disabled = false; again.textContent = '⚡ 立即更新'; }
  }

  // 状态行按钮每次渲染都会重建,统一走事件委托,避免 attach 时机问题
  document.addEventListener('click', (e) => {
    if (e.target.closest('#ddnsRunBtn')) { e.preventDefault(); runDdnsNow(); }
    else if (e.target.closest('#ddnsTestBtn')) { e.preventDefault(); runDdnsTest(); }
    else if (e.target.closest('[data-ddns-url]')) {
      e.preventDefault();
      copyText(e.target.closest('[data-ddns-url]').dataset.ddnsUrl)
        .then(ok => toast(ok ? '完整访问地址已复制(含端口)' : '复制失败', ok ? 'ok' : 'err'));
    }
  });

  /* ============ 扫码连接弹窗 ============ */
  let qrHosts = [];
  let qrProtected = false;
  async function openQrModal() {
    $('#qrModal').classList.remove('hidden');
    // 异步生成完成前,禁用复制按钮并显示占位,避免复制到剪贴板里的旧内容(如裸域名)
    const copyBtn = $('#qrCopyBtn');
    copyBtn.disabled = true;
    $('#qrUrls').innerHTML = '<span class="muted">正在获取访问地址…</span>';
    try {
      const lan = await api('/api/system/lan');
      qrProtected = !!lan.protected;
      qrHosts = lan.urls.length ? lan.urls : [{ host: '127.0.0.1', label: '本机', url: `http://127.0.0.1:${lan.port}` }];
      const sel = $('#qrIpSelect');
      sel.innerHTML = qrHosts.map(u => {
        const short = u.host.replace(/\[|\]/g, '');
        const shown = short.length > 24 ? short.slice(0, 22) + '…' : short;
        return `<option value="${esc(u.host)}" title="${esc(u.url)}">${u.label} · ${esc(shown)}</option>`;
      }).join('');
      await renderQr(qrHosts[0].host);
    } catch (e) {
      $('#qrUrls').textContent = '获取失败:' + e.message;
      $('#qrBox').textContent = '二维码生成失败:' + e.message;
    }
  }
  async function renderQr(host) {
    const copyBtn = $('#qrCopyBtn');
    try {
      const data = await api(`/api/system/lan/qr?host=${encodeURIComponent(host)}`);
      $('#qrBox').innerHTML = data.svg;
      $('#qrUrls').innerHTML = `手机访问:<b>${esc(data.url)}</b>` +
        (qrProtected ? '<br><span style="color:var(--warn)">已包含免密授权参数,扫码即可自动登录</span>' : '');
      $('#qrCopyBtn').disabled = false;
      $('#qrCopyBtn').onclick = async () => { if (await copyText(data.url)) toast('链接已复制(含端口与免密参数)', 'ok'); };
    } catch (e) {
      $('#qrBox').textContent = '二维码生成失败:' + e.message;
      $('#qrUrls').textContent = '';
      copyBtn.disabled = true;
    }
  }
  $('#qrIpSelect').addEventListener('change', (e) => renderQr(e.target.value));
  $('#qrBtn').addEventListener('click', openQrModal);
  $('#qrBtnSide').addEventListener('click', openQrModal);

  /* ============ 分享弹窗 ============ */
  function openShareModal(type, id, name) {
    state.shareCtx = { type, id, name };
    $('#shareTargetName').textContent = `分享对象:${name}`;
    $('#shareResult').classList.add('hidden');
    $('#shareModal').classList.remove('hidden');
    const codeOn = $('#shareCodeOn');
    codeOn.checked = true;
    genShareCode();
  }
  function genShareCode() {
    $('#shareCode').value = String(Math.floor(1000 + Math.random() * 9000));
  }
  $('#shareCodeGen').addEventListener('click', genShareCode);
  $('#shareCodeOn').addEventListener('change', (e) => {
    $('#shareCode').style.visibility = e.target.checked ? 'visible' : 'hidden';
  });
  $('#shareCreateBtn').addEventListener('click', async () => {
    const ctx = state.shareCtx;
    if (!ctx) return;
    const codeOn = $('#shareCodeOn').checked;
    const codeVal = codeOn ? ($('#shareCode').value || 'auto') : null;
    if (codeOn && !/^\d{4}$/.test(codeVal)) return toast('提取码须为 4 位数字', 'err');
    try {
      const r = await api('/api/share', {
        method: 'POST',
        body: { target_type: ctx.type, target_id: ctx.id, expiry: $('#shareExpiry').value, code: codeVal },
      });
      const url = `${location.origin}${r.url}`;
      $('#shareResult').classList.remove('hidden');
      $('#shareUrl').value = url + (r.code ? `(提取码 ${r.code})` : '');
      $('#shareOpenBtn').href = r.url;
      $('#shareCopyBtn').onclick = async () => {
        if (await copyText(r.code ? `${url} 提取码: ${r.code}` : url)) toast('分享链接已复制', 'ok');
      };
      toast('分享链接已生成', 'ok');
    } catch (e) { toast('生成失败:' + e.message, 'err'); }
  });

  /* 弹窗关闭 */
  $$('.modal').forEach(m => {
    m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); });
  });
  $$('.modal-close').forEach(b => b.addEventListener('click', () => $(`#${b.dataset.close}`).classList.add('hidden')));

  /* ============ 启动 ============ */
  async function boot() {
    connectWS();
    await loadSettings();
    switchView('files');
    // 检查 URL 中的 key 参数(免密授权后清理地址栏)
    if (location.search.includes('key=')) {
      history.replaceState(null, '', location.pathname);
    }
  }

  initAuth().then((ok) => { if (ok) boot(); });
})();
