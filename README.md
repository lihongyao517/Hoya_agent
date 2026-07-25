# HoyaAgent

HoyaAgent 是面向本地开发的 AI 编程助手桌面端，基于 Electron + SolidJS 构建，支持多模型提供商、会话工作区与桌面原生体验。

仓库：https://github.com/lihongyao517/Hoya_agent

## 功能概览

- 桌面应用（Windows / macOS / Linux）
- 多 AI 提供商接入（Anthropic、OpenAI、Google、OpenRouter、GitHub Copilot 等）
- 会话式编码协作、文件与终端联动
- 经典布局为默认，可在设置中切换新布局
- 本地配置与数据隔离（`~/.hoya`）

## 环境要求

- [Bun](https://bun.sh) `1.3+`
- Node.js 兼容环境（Windows 开发建议使用较新版本）
- 打包 Windows 安装包时需要可用的磁盘空间（建议 C 盘预留足够空间）

## 快速开始

```powershell
# 安装依赖
bun install

# 启动桌面端（开发模式）
bun --cwd packages/desktop dev
# 或
bun run dev:desktop
```

其他常用开发命令：

```powershell
# 仅启动 Web UI（需后端）
bun run dev:web

# 启动核心 CLI / 服务
bun run dev
```

## 打包

```powershell
# Windows 安装包
$env:OPENCODE_CHANNEL = "prod"
$env:OPENCODE_VERSION = "1.18.4"
bun --cwd packages/desktop build
bun --cwd packages/desktop package:win
```

打包产物默认输出到：

```text
packages/desktop/dist/HoyaAgent-win-x64.exe
packages/desktop/dist/win-unpacked/
```

macOS / Linux：

```powershell
bun --cwd packages/desktop package:mac
bun --cwd packages/desktop package:linux
```

## 项目结构

```text
Hoya_agent/
├── packages/
│   ├── desktop/     # Electron 桌面壳
│   ├── app/         # 桌面 / Web 前端 UI
│   ├── opencode/    # 核心服务与 CLI
│   ├── ui/          # 共享 UI 组件
│   └── ...
├── script/          # 构建与发布脚本
└── README.md
```

## 配置与数据

- 应用协议：`hoyaagent://`
- 本地目录：`~/.hoya`
- 配置文件：`hoya.json` / `hoya.jsonc`
- 设置键前缀：`hoya.*`

## 布局说明

- **默认使用经典（旧）布局**
- 设置 → 通用 →「新布局」可手动切换
- 不会在升级时自动强制切到新布局

## 开发提示

```powershell
# 类型检查（在对应 package 目录执行）
bun --cwd packages/app typecheck
bun --cwd packages/desktop typecheck

# 安装依赖后若有原生模块问题，可按 package 文档处理
bun install
```

若 Windows 打包下载 Electron 失败，可设置镜像：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
$env:ELECTRON_BUILDER_CACHE = "D:\path\to\cache\electron-builder"
```

## 版本

当前桌面端版本：`1.18.4`（见 `packages/desktop/package.json`）

## 许可证

MIT
