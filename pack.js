'use strict';
/**
 * 打包"体验版"分发包:
 *   node pack.js
 * 产出 LocalHub-v<版本>-便携版.zip,内含代码 + 依赖 + 启动脚本,
 * 不含 data/(个人数据)。对方解压后装好 Node.js 即可双击启动。
 */
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
// CI 中优先使用 git 标签名作为版本号(GITHUB_REF_NAME 由 Actions 注入)
const tagVer = (process.env.GITHUB_REF_NAME || '').replace(/^v/, '');
const ver = tagVer || pkg.version;
const OUT = `LocalHub-v${ver}-便携版.zip`;

const FILES = [
  'Start-LocalHub.bat',
  '快速开始.txt',
  'setup-firewall.bat',
  'README.md',
  'package.json',
  'package-lock.json',
];
const DIRS = ['server', 'public', 'test', 'node_modules'];

const output = fs.createWriteStream(OUT);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => {
  console.log(`已生成: ${path.resolve(OUT)}`);
  console.log(`大小: ${(archive.pointer() / 1024 / 1024).toFixed(1)} MB`);
  console.log('内容: 代码 + 依赖 + 启动脚本(不含 data/ 个人数据)');
  console.log('对方使用: 安装 Node.js 22.5+ → 解压 → 双击 Start-LocalHub.bat');
});

archive.on('warning', (err) => {
  if (err.code !== 'ENOENT') throw err;
});
archive.on('error', (err) => { throw err; });

archive.pipe(output);
for (const f of FILES) {
  if (!fs.existsSync(f)) { console.error(`缺少文件: ${f}`); process.exit(1); }
  archive.file(f, { name: f });
}
for (const d of DIRS) {
  if (!fs.existsSync(d)) { console.error(`缺少目录: ${d}`); process.exit(1); }
  archive.directory(d, d);
}
archive.finalize();
