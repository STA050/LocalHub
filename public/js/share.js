/* LocalHub 分享页逻辑(公开访问,带提取码) */
(function () {
  'use strict';
  const slug = location.pathname.split('/').pop() || '';
  const $ = (s) => document.querySelector(s);
  const qs = new URLSearchParams(location.search);
  let code = qs.get('code') || '';
  let info = null;

  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtSize(n) {
    if (!Number.isFinite(n)) return '-';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(v >= 100 ? 0 : 2)) + ' ' + u[i];
  }
  function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 2200);
  }
  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; }
    catch {
      const ta = document.createElement('textarea');
      ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { return document.execCommand('copy'); } catch { return false; }
      finally { ta.remove(); }
    }
  }

  function showError(title, desc) {
    $('#shareContent').innerHTML = `
      <div class="share-title">${esc(title)}</div>
      <p class="share-meta">${esc(desc)}</p>
      <div class="share-actions"><a class="btn btn-soft" href="/">打开 LocalHub 工作台</a></div>`;
  }

  async function loadInfo() {
    try {
      const url = `/api/share/${encodeURIComponent(slug)}/info` + (code ? `?code=${encodeURIComponent(code)}` : '');
      const res = await fetch(url);
      if (res.status === 404) return showError('分享不存在', '链接无效或已被撤回、清理。');
      if (res.status === 410) return showError('分享已过期', '该分享链接已超过有效期。');
      if (res.status === 403) return showCodeInput('提取码不正确,请重新输入');
      info = await res.json();
      render();
    } catch (e) {
      showError('加载失败', e.message);
    }
  }

  function showCodeInput(err) {
    $('#shareContent').innerHTML = `
      <div class="share-title">需要提取码</div>
      <p class="share-meta">这是一个受保护的分享,请输入 4 位提取码</p>
      ${err ? `<p style="color:var(--danger);font-size:13px;margin-top:8px">${esc(err)}</p>` : ''}
      <div class="share-body">
        <input class="share-code-input" id="codeInput" maxlength="4" inputmode="numeric" placeholder="····" autocomplete="off">
      </div>
      <div class="share-actions"><button class="btn btn-primary" id="codeBtn">解锁</button></div>`;
    const input = $('#codeInput');
    input.focus();
    const go = async () => {
      code = input.value.trim();
      if (!/^\d{4}$/.test(code)) return toast('请输入 4 位数字提取码', 'err');
      await loadInfo();
    };
    $('#codeBtn').addEventListener('click', go);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }

  function render() {
    const typeNames = { file: '文件', image: '图片', clip: '文本' };
    let body = '';
    if (info.type === 'image') {
      body = `<img class="share-preview-img" src="/api/share/${slug}/content?preview=1${code ? '&code=' + encodeURIComponent(code) : ''}" alt="${esc(info.name)}">`;
    } else if (info.type === 'clip') {
      body = `<div class="share-clip-text" id="clipBody">加载中…</div>`;
    } else {
      const ext = (info.name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase();
      body = `<div class="file-card" style="box-shadow:none">
        <div class="file-ico">📦</div>
        <div class="file-info">
          <div class="file-name">${esc(info.name)}</div>
          <div class="file-meta">${fmtSize(info.size)}</div>
        </div>
      </div>`;
    }
    $('#shareContent').innerHTML = `
      ${info.burn ? '<div class="share-burn">🔥 阅后即焚:本次访问后,该分享链接将立即失效</div>' : ''}
      <div class="share-title">${esc(info.name)}</div>
      <div class="share-meta">${typeNames[info.type]} · ${info.type === 'clip' ? '' : fmtSize(info.size) + ' · '}${info.expires_at ? '有效期剩余 ' + esc(remaining(info.expires_at)) : '永久有效'}</div>
      <div class="share-body">${body}</div>
      <div class="share-actions" id="actions"></div>`;

    const actions = $('#actions');
    if (info.type === 'clip') {
      fetchClip();
      actions.innerHTML = `
        <button class="btn btn-primary" id="copyBtn">📋 复制文本</button>
        <button class="btn btn-soft" id="dlBtn">下载为 .txt</button>`;
      $('#copyBtn').addEventListener('click', async () => {
        const text = $('#clipBody').textContent;
        if (await copyText(text)) toast('已复制', 'ok');
      });
      $('#dlBtn').addEventListener('click', () => {
        location.href = `/api/share/${slug}/content${code ? '?code=' + encodeURIComponent(code) : ''}`;
      });
    } else if (info.type === 'image') {
      actions.innerHTML = `
        <a class="btn btn-primary" href="/api/share/${slug}/content?dl=1${code ? '&code=' + encodeURIComponent(code) : ''}" download>⬇ 下载图片</a>
        <button class="btn btn-soft" id="copyLink">复制直链</button>`;
      $('#copyLink').addEventListener('click', async () => {
        if (await copyText(`${location.origin}/api/share/${slug}/content${code ? '?code=' + encodeURIComponent(code) : ''}`)) toast('直链已复制', 'ok');
      });
    } else {
      actions.innerHTML = `<a class="btn btn-primary" href="/api/share/${slug}/content${code ? '?code=' + encodeURIComponent(code) : ''}" download>⬇ 下载文件</a>`;
    }
    if (info.burn) {
      const warn = document.createElement('div');
      warn.style.cssText = 'margin-top:10px;color:var(--text-3);font-size:12px';
      warn.textContent = '注意:下载或查看即视为已阅读,链接随后自动销毁';
      actions.appendChild(warn);
    }
  }

  function remaining(ts) {
    const diff = ts - Date.now();
    if (diff <= 0) return '0';
    if (diff < 3600e3) return Math.ceil(diff / 60e3) + ' 分钟';
    if (diff < 86400e3) return Math.ceil(diff / 3600e3) + ' 小时';
    return Math.ceil(diff / 86400e3) + ' 天';
  }

  async function fetchClip() {
    try {
      const url = `/api/share/${slug}/content?format=json${code ? '&code=' + encodeURIComponent(code) : ''}`;
      const res = await fetch(url);
      if (res.status === 403) return showCodeInput('提取码不正确,请重新输入');
      if (!res.ok) return showError('加载失败', `HTTP ${res.status}`);
      const clip = await res.json();
      const body = $('#clipBody');
      if (clip.content_type === 'code' && clip.lang && clip.lang !== 'text') {
        const pre = document.createElement('pre');
        pre.className = 'codeblock';
        pre.innerHTML = `<code>${window.LHHighlight.highlight(clip.content, clip.lang)}</code>`;
        body.replaceWith(pre);
      } else {
        body.textContent = clip.content;
      }
    } catch (e) {
      $('#clipBody').textContent = '加载失败:' + e.message;
    }
  }

  loadInfo();
})();
