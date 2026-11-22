/* LocalHub 轻量语法高亮器:正则 tokenizer,支持常见语言 */
(function () {
  'use strict';

  const kw = (words) => new RegExp(`(?:${words.join('|')})(?![\\w$])`, 'y');

  const LANGS = {
    javascript: {
      rules: [
        { type: 'com', re: /\/\/[^\n]*|\/\*[\s\S]*?\*\//y },
        { type: 'str', re: /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/y },
        { type: 'num', re: /\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b|\b0x[0-9a-fA-F]+\b/iy },
        { type: 'key', re: kw(['const','let','var','function','return','if','else','for','while','do','switch','case','break','continue','new','delete','typeof','instanceof','in','of','class','extends','super','this','async','await','yield','try','catch','finally','throw','import','export','from','default','void','null','undefined','true','false','static','get','set']) },
        { type: 'fn', re: /[A-Za-z_$][\w$]*(?=\s*\()/y },
        { type: 'punct', re: /[{}()[\];,.:?=+\-*/%<>!&|^~]+/y },
      ],
    },
    typescript: {
      rules: [
        { type: 'com', re: /\/\/[^\n]*|\/\*[\s\S]*?\*\//y },
        { type: 'str', re: /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/y },
        { type: 'num', re: /\b\d[\d_]*(?:\.\d+)?\b/iy },
        { type: 'key', re: kw(['const','let','var','function','return','if','else','for','while','class','extends','implements','interface','type','enum','readonly','public','private','protected','async','await','import','export','from','default','new','this','super','null','undefined','true','false','string','number','boolean','any','void','never','unknown']) },
        { type: 'fn', re: /[A-Za-z_$][\w$]*(?=\s*\()/y },
        { type: 'punct', re: /[{}()[\];,.:?=+\-*/%<>!&|^~]+/y },
      ],
    },
    python: {
      rules: [
        { type: 'com', re: /#[^\n]*/y },
        { type: 'str', re: /'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/y },
        { type: 'num', re: /\b\d[\d_]*(?:\.\d+)?\b/iy },
        { type: 'key', re: kw(['def','class','import','from','as','return','if','elif','else','for','while','break','continue','pass','with','try','except','finally','raise','lambda','yield','global','nonlocal','assert','del','and','or','not','in','is','None','True','False','self','async','await','match','case']) },
        { type: 'fn', re: /[A-Za-z_]\w*(?=\s*\()/y },
        { type: 'punct', re: /[{}()[\];,.:=+\-*/%<>!&|^~]+/y },
      ],
    },
    json: {
      rules: [
        { type: 'attr', re: /"(?:[^"\\]|\\.)*"(?=\s*:)/y },
        { type: 'str', re: /"(?:[^"\\]|\\.)*"/y },
        { type: 'num', re: /-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/iy },
        { type: 'key', re: /\b(?:true|false|null)\b/y },
        { type: 'punct', re: /[{}[\]:,]+/y },
      ],
    },
    html: {
      rules: [
        { type: 'com', re: /<!--[\s\S]*?-->/y },
        { type: 'tag', re: /<\/?[A-Za-z][\w-]*|\/?>/y },
        { type: 'attr', re: /[A-Za-z-]+(?==)/y },
        { type: 'str', re: /"(?:[^"]*)"|'(?:[^']*)'/y },
        { type: 'punct', re: /[=]+/y },
      ],
    },
    xml: null, // 同 html
    css: {
      rules: [
        { type: 'com', re: /\/\*[\s\S]*?\*\//y },
        { type: 'str', re: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/y },
        { type: 'attr', re: /[a-zA-Z-]+(?=\s*:)/y },
        { type: 'num', re: /#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|em|rem|vh|vw|%|s|ms)?\b/iy },
        { type: 'key', re: /@media|@import|@supports|@keyframes|@font-face|!important/y },
        { type: 'punct', re: /[{}();:,>+~]+/y },
      ],
    },
    bash: {
      rules: [
        { type: 'com', re: /#[^\n]*/y },
        { type: 'str', re: /"(?:[^"\\]|\\.)*"|'(?:[^'])*'/y },
        { type: 'num', re: /\$\{?[A-Za-z_]\w*\}?|\b\d+\b/iy },
        { type: 'key', re: kw(['if','then','else','elif','fi','for','while','do','done','case','esac','function','return','export','local','echo','cd','ls','mkdir','rm','cp','mv','cat','grep','sed','awk','curl','wget','sudo','apt','apt-get','yum','brew','npm','pnpm','yarn','node','python','pip','git','docker','chmod','chown','ssh','scp','tar','zip','unzip','kill','ps','source','set','read','exit','printf']) },
        { type: 'fn', re: /[A-Za-z_][\w.-]*(?=\s)/y },
        { type: 'punct', re: /[|&;<>(){}[\]!$*?+=\/-]+/y },
      ],
    },
    sql: {
      rules: [
        { type: 'com', re: /--[^\n]*|\/\*[\s\S]*?\*\//y },
        { type: 'str', re: /'(?:[^'\\]|\\.)*'/y },
        { type: 'num', re: /\b\d+(?:\.\d+)?\b/iy },
        { type: 'key', re: /\b(?:SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|DROP|ALTER|ADD|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AS|AND|OR|NOT|NULL|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|DISTINCT|COUNT|SUM|AVG|MIN|MAX|PRIMARY|KEY|FOREIGN|REFERENCES|INDEX|UNIQUE|DEFAULT|TEXT|INTEGER|REAL|BLOB|EXISTS|CASE|WHEN|THEN|ELSE|END)\b/iy },
        { type: 'punct', re: /[(),;*.=<>!+-]+/y },
      ],
    },
    java: {
      rules: [
        { type: 'com', re: /\/\/[^\n]*|\/\*[\s\S]*?\*\//y },
        { type: 'str', re: /"(?:[^"\\\n]|\\.)*"/y },
        { type: 'num', re: /\b\d[\d_]*(?:\.\d+)?[fFdDlL]?\b/iy },
        { type: 'key', re: kw(['public','private','protected','static','final','void','class','interface','extends','implements','new','return','if','else','for','while','switch','case','break','continue','try','catch','finally','throw','throws','import','package','this','super','null','true','false','int','long','double','float','boolean','char','String','var']) },
        { type: 'fn', re: /[A-Za-z_$][\w$]*(?=\s*\()/y },
        { type: 'punct', re: /[{}()[\];,.:?=+\-*/%<>!&|^~]+/y },
      ],
    },
    go: {
      rules: [
        { type: 'com', re: /\/\/[^\n]*|\/\*[\s\S]*?\*\//y },
        { type: 'str', re: /"(?:[^"\\\n]|\\.)*"|`(?:[^`]*)`/y },
        { type: 'num', re: /\b\d[\d_]*(?:\.\d+)?\b/iy },
        { type: 'key', re: kw(['func','package','import','var','const','type','struct','interface','map','chan','go','defer','return','if','else','for','range','switch','case','default','break','continue','select','nil','true','false','make','new','len','cap','append','error','string','int','int64','float64','bool','byte']) },
        { type: 'fn', re: /[A-Za-z_$][\w$]*(?=\s*\()/y },
        { type: 'punct', re: /[{}()[\];,.:?=+\-*/%<>!&|^~]+/y },
      ],
    },
    c: {
      rules: [
        { type: 'com', re: /\/\/[^\n]*|\/\*[\s\S]*?\*\//y },
        { type: 'str', re: /"(?:[^"\\\n]|\\.)*"/y },
        { type: 'num', re: /\b\d[\d_]*(?:\.\d+)?[fFuUlL]*\b/iy },
        { type: 'key', re: kw(['#include','#define','#ifndef','#endif','int','char','float','double','void','long','short','unsigned','signed','struct','union','enum','typedef','const','static','return','if','else','for','while','switch','case','break','continue','sizeof','malloc','free','NULL','printf','scanf','main']) },
        { type: 'fn', re: /[A-Za-z_$][\w$]*(?=\s*\()/y },
        { type: 'punct', re: /[{}()[\];,.:?=+\-*/%<>!&|^~]+/y },
      ],
    },
    rust: {
      rules: [
        { type: 'com', re: /\/\/[^\n]*/y },
        { type: 'str', re: /"(?:[^"\\]|\\.)*"/y },
        { type: 'num', re: /\b\d[\d_]*(?:\.\d+)?\b/iy },
        { type: 'key', re: kw(['fn','let','mut','const','struct','enum','impl','trait','pub','use','mod','match','if','else','for','while','loop','return','self','Self','crate','super','as','in','ref','move','where','dyn','async','await','Some','None','Ok','Err','println','vec','i32','u32','i64','u64','f64','usize','str','String','bool']) },
        { type: 'fn', re: /[A-Za-z_$][\w$]*(?=\s*[!(])/y },
        { type: 'punct', re: /[{}()[\];,.:?=+\-*/%<>!&|^~]+/y },
      ],
    },
  };
  LANGS.xml = LANGS.html;
  LANGS['c++'] = LANGS.cpp = LANGS.c;
  LANGS['plaintext-code'] = { rules: [{ type: 'str', re: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\n])*'/y }, { type: 'num', re: /\b\d+(?:\.\d+)?\b/iy }, { type: 'punct', re: /[{}()[\];,.:?=+\-*/%<>!&|^~]+/y }] };

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** 高亮源码,返回 HTML(已转义) */
  function highlight(src, lang) {
    const cfg = LANGS[lang] || null;
    if (!cfg || !src) return esc(src);
    let out = '', i = 0, plain = '';
    const flush = () => { if (plain) { out += esc(plain); plain = ''; } };
    const len = src.length;
    outer: while (i < len) {
      for (const rule of cfg.rules) {
        rule.re.lastIndex = i;
        const m = rule.re.exec(src);
        if (m && m.index === i && m[0]) {
          flush();
          out += `<span class="tk-${rule.type}">${esc(m[0])}</span>`;
          i += m[0].length;
          continue outer;
        }
      }
      plain += src[i++];
    }
    flush();
    return out;
  }

  /** 与服务端一致的轻量语言检测 */
  function detectLang(text) {
    if (!text || text.trim().length < 3) return null;
    const t = text.trim();
    if (/^<\?xml|<!DOCTYPE html/i.test(t)) return 'html';
    if (/^#!\s*\/bin\/(ba)?sh/.test(t)) return 'bash';
    if (/^\{[\s\S]*\}$|^\[[\s\S]*\]$/.test(t) && /"\s*:/.test(t)) {
      try { JSON.parse(t); return 'json'; } catch { /* no */ }
    }
    if (/^\s*<(div|span|html|section|p[ >]|script|body|head|table|ul|li)/i.test(t)) return 'html';
    const tests = [
      ['typescript', /\b(interface\s+\w+|type\s+\w+\s*=|implements|readonly\s|: string|: number|enum\s)/, true],
      ['javascript', /\b(const\s|let\s|var\s|function|=>|async\s|await\s|console\.log|require\(|document\.|window\.|null|undefined)\b/, false],
      ['python', /\b(def\s|import\s|from\s\w+\simport|print\(|elif|None|True|False|self\.|lambda\s|__name__)/, false],
      ['sql', /\b(SELECT\s[\s\S]+FROM|INSERT INTO|UPDATE\s[\s\S]+SET|CREATE TABLE)\b/i, true],
      ['go', /\b(func\s|package main|fmt\.)/, false],
      ['rust', /\b(fn\s|let\s mut|println!)/, false],
      ['java', /\b(public\s class|System\.out|@Override)/, false],
      ['c', /\b(#include|printf\(|int main)/, false],
      ['css', /[.#@]?[\w-]+\s*\{[^}]*:[^}]*;/m.test(t) && /(font|color|margin|padding|display|width|border)/.test(t), true],
      ['bash', /\b(echo\s|export\s|sudo\s|apt(-get)?\s|chmod|git\s|docker\s|npm\s)/, false],
    ];
    for (const [lang, re] of tests) if (re.test(t)) return lang;
    const lines = t.split('\n');
    if (lines.length > 1 && /[{;}]/.test(t) && /^(\s{2,}|\t)/m.test(t)) return 'plaintext-code';
    return null;
  }

  window.LHHighlight = { highlight, detectLang };
})();
