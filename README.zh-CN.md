# Linux LLM Server Manager

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/wqwd1dfse/linux-llm-server-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/wqwd1dfse/linux-llm-server-manager/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

一套面向 Linux 服务器与本地大模型（LLM）推理工作站的轻量级 Web 管理控制台，采用现代 Windows 11 风格界面。

包含 Linux 系统监控、SSH/WebSocket 终端、SFTP 文件管理、Docker 管理、Systemd 进程控制、风扇/PWM 散热控制、GPU 硬件监控、Hugging Face 模型下载与本地 LLM 推理控制台。

## 目录

- [核心特性](#-核心特性)
- [快速开始](#-快速开始)
- [安全说明](#️-安全说明)
- [前端结构](#-前端结构)
- [自动化测试](#-自动化测试)
- [生产部署](#-生产环境反向代理部署)
- [许可证](#-开源许可证)

---

## ⚠️ 安全说明

> [!IMPORTANT]
> 这是拥有 SSH、Docker、systemd 和硬件控制能力的高权限管理工具。请优先绑定到 `127.0.0.1`，并通过可信 VPN 或启用 HTTPS 的反向代理访问。不要把管理端口直接暴露到公网。
>
> 如果历史开发或测试环境曾使用真实 SSH 密码、私钥或访问令牌，请在部署前轮换相关凭据，并确认它们没有进入 Git 历史。

---

## ✨ 核心特性

- 📊 **真实硬件遥测与多卡监控 (Hardware Telemetry)**: 采集 CPU 负载、多核占用、RAM 与 Swap、磁盘 I/O 及分区容量、网络吞吐、多 GPU（AMD / NVIDIA / Intel）温度、功耗与显存占用。无传感器时真实上报 `null`，拒绝模拟假数据。
- 💻 **安全交互终端 (Web SSH Terminal)**: 集成 `xterm.js`，支持全功能 Bash/Zsh 交互、ANSI 真彩色、自动尺寸自适应、严格的 WebSocket Origin 与统一 Session 升级认证。
- 📁 **完整 SFTP 文件管理器 (SFTP Explorer)**: 目录导航、按服务器隔离的收藏路径、可恢复远程回收站、大文件分片/拖拽上传（单文件 512MB 限制、超限 413、临时文件自动清理）、下载、代码与配置文件在线编辑、权限 Chmod、Tar/Zip 压缩解压、图片即时预览。
- 🤖 **大模型工作室与云端下载器 (LLM Studio)**: 严格参数校验（NGL、Context、KV Cache Type 白名单、端口 1-65535、路径边界隔离），动态跟踪 `llama-server` 实例端口，多轮 SSE 流式对话；在线浏览 Hugging Face 开源模型库，一键下载到 `.part` 临时文件，校验成功后原子入库。HF Token 仅持久化在管理端权限为 0600 的配置文件中；远程下载使用临时 0600 curl 配置并在任务结束时删除，不会出现在进程命令行。
- 🌪️ **硬件级闭环风扇与温控 (Fan & Cooling Console)**: 专为高性能加速卡优化的多路 PWM 转速调节与模式切换（自动温控/极速强冷/静音巡航），具备硬件节点探针、PWM 回读校验（Readback Verification）及写失败自动恢复守护进程（Fail-Safe）。
- 🐳 **Docker 容器与镜像看板 (Docker Manager)**: 严格参数与标识符校验，纯 DOM 事件绑定，容器状态与实时资源消耗、启停/重启/删除、日志查看、镜像拉取。
- ⚙️ **Systemd 服务与进程管控 (Services & Processes)**: 进程资源排行与 PID 终止、系统服务状态检索与启停重载。
- 🖥️ **多服务器档案与快速切换**: 保存多个 SSH 主机档案，在标题栏一键切换目标服务器；切换后文件、监控、Docker、进程、风扇和 LLM 状态同步刷新。凭据仅存放在本机受忽略的 `data/servers.json`。
- ♿ **自适应与无障碍界面**: 支持桌面、平板与窄屏导航，提供跳转链接、完整焦点态、弹窗焦点锁定、键盘文件操作及减少动画偏好。
- 🌐 **中英双语界面**: 新用户默认使用英语，可在设置中即时切换简体中文；浏览器会持久保存用户选择。
- 🛡️ **生产级安全边界 (Security Hardening)**:
  - 默认安全本地监听 `127.0.0.1:3888`。
  - PBKDF2-HMAC-SHA512（220,000 次迭代）加盐哈希密码认证，首次密码至少 12 位，持久化原子存储于 `data/auth.json` (0600 权限)。
  - 用户名 + 密码双重严格校验，防暴力破解频率限制（5 次失败锁定 5 分钟）。
  - HMAC-SHA256 签名会话 Cookie (`HttpOnly`, `SameSite=Lax`)。
  - SSH 主机密钥首次信任（TOFU）指纹校验，抵御中间人攻击。
  - 全后端统一数组参数化执行器 (`executeCommand(executable, argv[])`)，彻底杜绝命令注入。
  - 静态前端全面 DOM API 重构，移除动态内联事件并使用 `script-src-attr 'none'` CSP，显著收紧 XSS 攻击面。
  - SSH 凭据默认仅保存在当前进程内；只有用户显式勾选时才写入本机 `data/config.json` (0600 权限)。
  - `TRUST_PROXY` 显式配置（默认 `false`），防止反向代理 IP 伪造。

---

## 🚀 快速开始

### 1. 环境要求

- Node.js >= 18.0.0（推荐 Node.js 20 LTS 或 22）
- npm >= 9.0.0
- 一台可通过 SSH 访问的 Linux 服务器

### 2. 克隆项目与安装依赖

```bash
git clone https://github.com/wqwd1dfse/linux-llm-server-manager.git
cd linux-llm-server-manager
npm ci
```

### 3. 环境配置 (可选)

复制配置模板文件：

```bash
cp .env.example .env
```

按需编辑 `.env`：

```ini
# 服务端监听端口与绑定地址 (默认 127.0.0.1 确保本地安全)
PORT=3888
HOST=127.0.0.1

# Web 管理后台初始管理员凭据 (首次访问也可在 Web 界面进行初始化设置)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your_secure_password_here

# 生产环境请使用稳定、随机且足够长的值
SESSION_SECRET=change_this_to_a_random_long_string_in_production

# 反向代理信任设置 (默认 false，若位于 Nginx/Caddy 后可设为 loopback 或 1)
TRUST_PROXY=false

# 启动时是否自动连接已保存的 SSH 配置；维护或隔离测试时可设为 false
AUTO_CONNECT=true

# 首次初始化默认仅允许本机访问
ALLOW_REMOTE_SETUP=false

# 运维脚本安全限制（默认禁止任意自定义 Shell 脚本执行）
ENABLE_CUSTOM_SCRIPTS=false

# 本地大模型扫描根目录
MODEL_ROOTS=/mnt/models,/opt/models

# llama-server 默认仅监听远程回环地址，后台通过 SSH 隧道访问
LLM_BIND_HOST=127.0.0.1

# 上传文件限制 (MB)
MAX_UPLOAD_FILE_MB=512
MAX_UPLOAD_FILES=10
```

### 4. 启动服务

```bash
# 生产启动
npm start

# 开发热重载启动
npm run dev
```

### 5. 访问系统

在浏览器打开：

```
http://127.0.0.1:3888
```
首次进入系统将提示设置管理员账号与初始密码。

> Windows 用户可以把上面的 `cp` 替换为 `Copy-Item .env.example .env`。

---

## 🐧 Linux 端 Fan 温控服务（可选）

Dashboard 无需额外守护进程即可读取硬件传感器；自动温控曲线、服务启停和服务日志功能需要在每台目标 Linux 主机上另外下载并安装 fan-control.service。

在目标 Linux 主机上执行：

    git clone --depth 1 https://github.com/wqwd1dfse/linux-llm-server-manager.git
    cd linux-llm-server-manager/linux/fan-control
    sudo ./install.sh

无人值守运行前请检查 /etc/default/fan-control。不同主板与 GPU 的 hwmon PWM 节点可能不同，详细配置和回滚方法见 linux/fan-control/README.md。
## 🧩 前端结构

- `public/index.html`：应用外壳与主要业务视图。
- `public/fragments/modals.html`：弹窗、右键菜单与登录/初始化界面。
- `public/js/bootstrap.js`：在应用初始化前加载并校验可信静态片段，失败时显示明确错误。
- `public/js/i18n.js`：管理语言状态、即时切换和动态 DOM 翻译。
- `public/js/i18nCatalog.js`：集中维护英语和简体中文界面词条。
- `public/js/markdown.js`：为 LLM 对话与模型说明提供统一的转义 Markdown 渲染。
- `public/js/terminal.js`：首次进入终端时再加载 xterm.js；CDN 异常不会阻塞其他后台功能。
- 浏览器会并行加载三份模块化样式；`public/css/style.css` 继续作为兼容入口，依次导入：
  - `base.css`：主题变量、字体与基础规则。
  - `components.css`：导航、卡片、表格、表单、弹窗和功能组件。
  - `polish.css`：视觉优化、响应式布局与可访问性增强。

各功能脚本只在首次打开对应视图时加载，减少首屏下载与解析开销。该拆分保留原生 JavaScript 和 Express 架构，不需要额外构建步骤或运行时依赖。

---

## 🧪 自动化测试

项目自带完整的自动化单元测试与安全校验套件（基于 Node.js 原生 Test Runner，零额外测试依赖）：

```bash
npm test
```

测试覆盖：

- 密码加盐哈希（PBKDF2 220,000 次迭代）与持久化重启恢复验证
- 用户名与密码双重真实匹配校验
- 统一 API 认证中间件与公开端点白名单过滤
- 暴力登录频率限制与会话生命周期（防伪造、过期、登出失效）
- 真实 HTTP 初始化、登录、受保护接口、退出和会话失效流程
- WebSocket Upgrade 跨站来源检查与会话状态同步
- 统一数组执行器 (`executeCommand(executable, argv[])`) 与防注入回归测试
- LLM 参数边界校验、KV Cache 白名单与路径穿越防御
- CSP 安全响应头与真实硬件遥测指标缓冲区
- 前端无内联事件、响应式能力、模块化样式与可信片段加载回归测试

---

## 🔒 生产环境反向代理部署

1. **反向代理与 HTTPS**:
   推荐保持应用监听 `127.0.0.1:3888`，并通过 Nginx / Caddy 反向代理并配置 SSL/TLS 证书。
2. **启用 TRUST_PROXY**:
   当处于反向代理后端时，请在 `.env` 中设置 `TRUST_PROXY=loopback` 或 `TRUST_PROXY=1`，以便准确记录客户端 IP 进行防爆破限流。
3. **LLM 网络边界**:
   默认保持 `LLM_BIND_HOST=127.0.0.1`，后台会通过 SSH 隧道访问远程 `llama-server`。只有在确认防火墙和模型 API 认证策略后才应设为 `0.0.0.0`。
4. **Nginx 配置示例**:
   ```nginx
   server {
       listen 443 ssl http2;
       server_name manager.example.com;

       ssl_certificate /path/to/fullchain.pem;
       ssl_certificate_key /path/to/privkey.pem;

       location / {
           proxy_pass http://127.0.0.1:3888;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }

       location /ws/ {
           proxy_pass http://127.0.0.1:3888;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection "upgrade";
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_read_timeout 86400s;
       }
   }
   ```

---

## 📄 开源许可证

本项目由 **wqwd1dfse** 维护，并基于 [MIT License](LICENSE) 开源发布。
