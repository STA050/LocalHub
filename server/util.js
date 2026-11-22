'use strict';
const crypto = require('crypto');

/** 解析 User-Agent 得到设备标识(如 "Windows · Chrome"、"Android · Firefox") */
function deviceFromUA(ua) {
  ua = ua || '';
  let os = 'Unknown';
  if (/iPhone/i.test(ua)) os = 'iPhone';
  else if (/iPad/i.test(ua)) os = 'iPad';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Macintosh|Mac OS X/i.test(ua)) os = 'macOS';
  else if (/CrOS/i.test(ua)) os = 'ChromeOS';
  else if (/Linux/i.test(ua)) os = 'Linux';
  let browser = '';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\//i.test(ua)) browser = 'Opera';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/Safari\//i.test(ua)) browser = 'Safari';
  return browser ? `${os} · ${browser}` : os;
}

/** 安全文件名:去掉路径分隔符与非法字符,保留中文 */
function safeName(name) {
  let n = String(name || 'file');
  n = n.replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/^\.+/, '_').trim();
  if (!n) n = 'file';
  return n.slice(0, 180);
}

function shortId(len = 10) {
  return crypto.randomBytes(24).toString('base64url').slice(0, len);
}

/** 分享 slug:可读随机串 */
function makeSlug() {
  return crypto.randomBytes(6).toString('hex');
}

function genCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function nowMs() { return Date.now(); }

/** Content-Disposition(支持中文文件名, RFC 5987) */
function contentDisposition(filename, inline = false) {
  const type = inline ? 'inline' : 'attachment';
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** 简易语言检测:根据内容特征判断代码语言 */
function detectLang(text) {
  if (!text) return null;
  const t = text.trim();
  if (t.length < 3) return null;
  if (/^<\?xml|<!DOCTYPE html/i.test(t)) return 'xml';
  if (/^#!\s*\/bin\/(ba)?sh/.test(t)) return 'bash';
  if (/^#!\s*\/usr\/bin\/env\s+python|^#!/.test(t) && /python/.test(t)) return 'python';
  if (/^(curl |sudo |apt |yum |brew |npm |pnpm |yarn |git |docker |ls |cd |mkdir |echo |rm |mv |cp |grep |ssh |pip )/m.test(t) && !/[{};]/.test(t.slice(0, 200))) return 'bash';
  if (/^\{[\s\S]*\}$|^\[[\s\S]*\]$/.test(t) && /"\s*:/.test(t)) {
    try { JSON.parse(t); return 'json'; } catch { /* not json */ }
  }
  if (/^\s*(<!DOCTYPE|<html|<div|<span|<p[ >]|<script|<section)/i.test(t) || /^<\/?[a-z][\w-]*(\s+[\w-]+=)?/m.test(t.slice(0, 120))) {
    if (/^\s*<(div|span|html|section|p[ >]|script|body|head)/i.test(t)) return 'html';
  }
  const kw = {
    javascript: /\b(const|let|var|function|=>|async|await|console\.log|require\(|import\s|export\s|null|undefined)\b/,
    typescript: /\b(interface|type\s+\w+\s*=|implements|readonly|: string|: number|enum\s)/,
    python: /\b(def |import |from \w+ import|print\(|elif|None|True|False|self\.|lambda |__name__)/,
    java: /\b(public\s+class|private\s|System\.out|void |package\s|@Override)\b/,
    c: /\b(#include|printf\(|int main|std::|malloc\()/,
    cpp: /\b(std::|cout\s*<<|#include\s*<iostream)/,
    go: /\b(func |package main|fmt\.|import \(\s*"|\bgo \w+\()/,
    rust: /\b(fn |let mut|impl |match\s+\w+\s*\{|println!)/,
    sql: /\b(SELECT .+ FROM|INSERT INTO|UPDATE .+ SET|CREATE TABLE|ALTER TABLE)\b/i,
    bash: /\b(echo |export |if \[|fi$|&& |apt-get|chmod|sudo )/,
  };
  if (kw.typescript.test(t) && /(interface|: (string|number|boolean)|import type)/.test(t)) return 'typescript';
  if (/^[^{]*\{[^}]*:[^}]*;/m.test(t) && /(font|color|margin|padding|display|width|height|border)/.test(t)) return 'css';
  for (const [lang, re] of Object.entries(kw)) {
    if (re.test(t)) return lang;
  }
  // 代码特征:大量分号/花括号/缩进 → 标记为通用代码
  const lines = t.split('\n');
  if (lines.length > 1 && /[{;}]/.test(t) && /^(\s{2,}|\t)/m.test(t)) return 'plaintext-code';
  return null;
}

/** 人类可读字节 */
function humanSize(n) {
  if (!Number.isFinite(n) || n < 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)) + ' ' + units[i];
}

/**
 * 失败计数限速器(内存态):windowMs 内失败次数达到 max 即封锁。
 * 只计失败,成功调用 reset() 清零。用于登录/提取码防爆破。
 */
function createRateLimiter(windowMs, max) {
  const hits = new Map();
  const prune = () => {
    const now = Date.now();
    for (const [k, rec] of hits) if (now - rec.start > windowMs) hits.delete(k);
  };
  return {
    /** 是否已被封锁 */
    blocked(key) {
      prune();
      const rec = hits.get(key);
      return !!rec && rec.n >= max;
    },
    /** 记录一次失败 */
    fail(key) {
      prune();
      const now = Date.now();
      const rec = hits.get(key);
      if (!rec || now - rec.start > windowMs) hits.set(key, { start: now, n: 1 });
      else rec.n++;
    },
    /** 成功后清零 */
    reset(key) { hits.delete(key); },
    /** 清空全部(测试用) */
    resetAll() { hits.clear(); },
  };
}

module.exports = { deviceFromUA, safeName, shortId, makeSlug, genCode, sha256, nowMs, contentDisposition, detectLang, humanSize, createRateLimiter };
