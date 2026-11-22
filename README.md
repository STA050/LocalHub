# LocalHub · 本地多设备快传工作台

局域网内 **PC / 手机 / 平板** 即开即用的全栈 Web 工作台:不限速无损大文件互传、实时剪贴板同步、粘贴截图即图床、带提取码与有效期的安全外链分享。所有数据存储在本机文件系统 + SQLite,不经任何第三方服务器。

![技术栈](https://img.shields.io/badge/Node.js-%E226424-blue) 依赖仅 4 个纯 JS 包(express / ws / archiver / qrcode),SQLite 使用 Node 22+ 内置 `node:sqlite`,**无需任何原生编译**。

## 一键启动

```bash
# 要求 Node.js ≥ 22.5(推荐 24 LTS)
npm install
npm start
# → http://localhost:5217
```

运行测试(47 项集成测试:流式上传下载字节校验、剪贴板增删改查、过期清理、提取码、访问保护等):

```bash
npm test
```

## 手机扫码秒连

1. 电脑打开工作台,点击右上角 **「手机连接」**;
2. 自动检测本机局域网 IP 并生成二维码(多网卡时可在弹窗中切换);
3. 手机微信 / 浏览器扫码,直接进入同一工作台 —— 剪贴板、文件、图床全部实时同步。

## 功能总览

| 模块 | 说明 |
| --- | --- |
| 📄 **文件快传** | 全屏拖拽 / Ctrl+V 粘贴 / 拍照上传;流式读写不占内存、不限速不压缩;实时速率(MB/s)与剩余时间;批量勾选 ZIP 打包下载;保留原始文件名与设备标识(Windows / Android / iPhone…) |
| 📋 **剪贴板同步** | WebSocket 实时双向推送,发完对方立即弹出;自动识别代码语言并语法高亮;置顶 / 收藏 / 标签 / 全文检索 |
| 🖼️ **临时图床** | 任意位置 Ctrl+V 粘贴截图即生成局域网直链;一键转 WebP(浏览器端完成,实测可省 90%+ 体积);直链 / Markdown / HTML 三种格式一键复制 |
| 🔗 **分享链接** | 任意条目生成独立分享页;有效期 1 小时 / 24 小时 / 7 天 / 阅后即焚 / 永久;可选 4 位提取码;过期与链接由后台定时任务自动清理 |
| 📊 **仪表盘** | 已用存储、磁盘剩余空间、在线设备数、条目统计;分享链接管理(倒计时 / 撤销);一键手动清理 |
| ⚙️ **可视化设置** | 端口、单文件大小上限、图床默认格式、压缩质量、清理周期、内容保留时长、访问口令 —— 全部为开关 / 下拉 / 滑块 / 数字框,零代码配置 |

## 手机连不上?防火墙自检与一键修复

手机无法访问几乎都是 **Windows 防火墙拦截**所致:WiFi 若被归类为"公用网络",默认拦截一切入站连接(与本程序用什么语言编写无关)。三种解决方式任选:

1. **工作台内自检**:打开 **仪表盘 → 电脑连通性自检**,自动检测网络类型 / 防火墙状态 / 端口放行规则,点 **"一键修复防火墙"** 并在 UAC 弹窗点击"是"即可;
2. **双击 `setup-firewall.bat`**(自动提权,放行 TCP 5217);
3. **把 WLAN 切为"专用网络"**:设置 → 网络和 Internet → WLAN → 网络配置文件类型 → 专用。

**免防火墙备用通道**:若电脑装有 Tailscale(网卡为专用类型,通常已放行),手机安装 Tailscale 并登录同一账号,直接访问 `http://<Tailscale IP>:5217` 即可,无需任何防火墙改动。自检卡片会自动给出该地址。

> 若以上都无效,检查路由器是否开启了 **AP 隔离**(访客网络常见),需在路由器后台关闭。

## 局域网访问保护(可选)

设置页开启 **「访问口令保护」** 后:

- 新设备首次打开需输入口令,已授权设备记住登录状态(会话持久化在 SQLite,重启不失效);
- 扫码二维码自动携带 **免密授权参数**,手机扫码即自动登录;
- 图片直链(`​/api/images/:id/raw`)保持局域网公开 —— 这是图床功能的基础。

## IPv6 与 DDNS 远程访问(默认关闭)

> **默认状态 = 仅局域网**:IPv6 与 DDNS 两个开关默认关闭,新装实例只在局域网内可见。要启用公网访问,在设置页手动开启它们,并务必配合「访问口令保护」。
> **开关是硬性大门**:关闭 IPv6 开关后,服务器会实时拒绝一切来自外部 IPv6 的连接(含通过 DDNS 域名的访问,返回 403),局域网与 Tailscale 不受影响——不是只停止更新,而是真正关门。

服务始终**双栈监听**(`::` 同时接受 IPv4 与 IPv6 连接)。开启 IPv6 开关后,若宽带运营商分配了**全局 IPv6**(地址以 `2` 或 `3` 开头),手机在流量网络(国内移动网络普遍有 IPv6)也能直接连回家,无需端口映射:

- 扫码弹窗会列出所有可用地址(IPv4 / IPv6 自动加方括号),选择生成对应二维码;
- ⚠️ 全局 IPv6 理论上可从公网直达,**请务必开启「访问口令保护」**;
- 部分路由器默认拦截 IPv6 入站,需在路由器后台放行(常叫"IPv6 防火墙"开关)。

**DDNS 动态域名**(设置 → 远程访问):公网地址会随重拨变化,开启后自动把最新地址更新到你的域名,手机永远访问同一个域名:

| 服务商 | 令牌 | 域名填写 | 国内直连可达性 |
| --- | --- | --- | --- |
| DNSPod(腾讯云) | 控制台「经典 Token」:`ID,Token` | `hub.example.com` | ✅ |
| 阿里云 DNS | RAM 用户 AK:`AccessKeyID,AccessKeySecret`(需授权 DNS 权限) | `hub.example.com` | ✅ |
| Cloudflare | API Token + Zone ID | `hub.example.com` | ✅ |
| Dynv6 | 页面 token | `mypc.dynv6.net` | ✅ |
| deSEC.io(免费) | 账户 token | `hub.example.com` | ✅ |
| Dynu | API-Key,或「ClientID,ClientSecret」 | `mypc.dynu.net` | ❌ 被墙,需代理 |
| GoDaddy | API `key:secret` | `hub.example.com` | ❌ 需代理 |
| DuckDNS(免费) | 页面 token | `mypc.duckdns.org` | ❌ 需代理 |
| No-IP(免费) | `用户名,密码` | `mypc.ddns.net` | ⚠️ 视网络而定 |
| 自定义 URL | 任意 | 模板支持 `{ipv4} {ipv6} {domain} {token}` 占位符 | — |

> 被"墙"的服务商可让服务带代理启动:Node 24 支持 `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 npm start`。
> 设置页的 **🧪 测试** 按钮无需启用 DDNS 即可诊断:分步执行"探测地址 → 连接服务商 → 写入解析",并报告耗时(超时通常意味着网络不可达)。

逻辑:优先发布全局 IPv6(AAAA 记录),同时探测公网 IPv4(api.ipify.org)发布 A 记录;按设置周期定时执行,也可在设置页点"⚡ 立即更新"。启用 DDNS 后建议把「访问口令保护」一起打开。

## 存储目录说明

```
data/
├── localhub.db          # SQLite 数据库(条目 / 设置 / 会话 / 分享记录,WAL 模式)
└── storage/
    ├── files/           # 上传的文件(原始字节)
    ├── images/          # 图床图片 + *.thumb.webp 缩略图
    └── tmp/             # 上传临时文件(断电安全:先写临时文件再入库改名)
```

删除条目时磁盘文件同步删除;每次清理任务还会回收「数据库已删但磁盘遗留」的孤儿文件。

## 常驻运行

### Windows:开机自启(计划任务)

```powershell
schtasks /Create /TN "LocalHub" /TR "cmd /c cd /d D:\path\to\localhub-transfer && npm start" /SC ONLOGON
```

### 任意平台:pm2 守护

```bash
npm i -g pm2
pm2 start server/index.js --name localhub
pm2 save && pm2 startup   # 开机自启
```

### Docker

```dockerfile
FROM node:24-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server ./server
COPY public ./public
VOLUME /app/data
EXPOSE 5217
CMD ["node", "server/index.js"]
```

```bash
docker build -t localhub .
docker run -d --name localhub --network host -v ./data:/app/data localhub
# Windows/Mac 无 host 网络时:-p 5217:5217
```

> 数据库挂载在 `data/` 卷中,容器重建不丢数据。

## 配置端口 / 数据目录

默认端口 `5217`(可在设置页修改,重启生效),也可用环境变量覆盖启动参数:

```js
// server/index.js 导出可编程接口
const { startServer } = require('./server/index.js');
startServer({ port: 8080, dataDir: 'D:/localhub-data' });
```

## 目录结构

```
localhub-transfer/
├── server/
│   ├── index.js        # 服务入口:HTTP + 静态资源 + 路由装配
│   ├── db.js           # SQLite(node:sqlite,零原生依赖)
│   ├── settings.js     # 可视化设置定义与校验
│   ├── auth.js         # 访问口令 / 会话 / URL 免密授权
│   ├── ws.js           # WebSocket 推送中心(心跳保活)
│   ├── cleanup.js      # 定时清理:过期分享、超期内容、孤儿文件、磁盘统计
│   ├── net.js          # 局域网 IP 检测
│   ├── util.js         # 设备识别、语言检测、安全文件名…
│   └── routes/         # clips / files / images / share / system
├── public/
│   ├── index.html      # 工作台 SPA(桌面侧边栏 + 移动端底部导航)
│   ├── share.html      # 独立分享页(提取码门禁)
│   ├── css/style.css   # Notion/Linear 风格浅色主题
│   └── js/             # app.js / highlighter.js(自研语法高亮)/ share.js
└── test/integration.test.mjs
```

## 安全说明

- 本应用面向**可信局域网**;访问口令用于防误入,不是加密传输(HTTP);
- **口令哈希存储**:访问口令以 scrypt 加盐哈希落库,数据库泄露也不会泄露口令(旧明文启动时自动迁移);
- **防爆破限速**:登录同 IP 15 分钟 4 次失败即临时封锁;分享提取码同 IP 10 分钟 8 次错误即封锁,正确后自动清零;
- **WebSocket 鉴权**:开启访问保护后,实时推送连接同样需要会话,未授权设备无法窃听剪贴板流;
- **会话有效期**:登录会话 30 天自动过期,过期会话由清理任务回收;
- **安全响应头**:nosniff / SAMEORIGIN / no-referrer;
- 提取码、会话 token、免密 key 均随机生成;上传文件名做了路径安全净化,超限文件在收到第一个字节前即拒绝;
- 忘记口令:停止服务后执行 `node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/localhub.db');db.prepare(\"DELETE FROM settings WHERE key IN ('access_password','access_password_enabled')\").run()"` 再启动,即可重新设置。
