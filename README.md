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

- [Bun](https://bun.sh) `1.3+`（推荐与根目录 `package.json` 的 `packageManager` 一致）
- Windows 打包需要足够磁盘空间（建议 C 盘预留 **8GB+**）
- 不依赖 git 分支即可构建（脚本会自动回退 channel/version）

## 从源码运行（开发）

```powershell
git clone https://github.com/lihongyao517/Hoya_agent.git
cd Hoya_agent

# 安装依赖（必须在仓库根目录）
bun install

# 启动桌面端（开发模式）
bun --cwd packages/desktop dev
# 或
bun run dev:desktop
```

其他常用命令：

```powershell
# 仅启动 Web UI（需后端）
bun run dev:web

# 启动核心 CLI / 服务
bun run dev
```

## 打包 Windows 安装包

在仓库根目录执行：

```powershell
# 可选：指定 channel / version（不设也会用默认 prod + package.json version）
$env:OPENCODE_CHANNEL = "prod"
$env:OPENCODE_VERSION = "1.18.4"

# 国内网络建议设置 Electron 镜像，并把缓存放到空间更大的盘
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
$env:ELECTRON_BUILDER_CACHE = "D:\cache\electron-builder"
$env:ELECTRON_CACHE = "D:\cache\electron"

# 构建前端 + 后端 node sidecar
bun --cwd packages/desktop build

# 打 Windows 安装包
bun --cwd packages/desktop package:win
```

产物：

```text
packages/desktop/dist/HoyaAgent-win-x64.exe
packages/desktop/dist/win-unpacked/
```

macOS / Linux：

```powershell
bun --cwd packages/desktop package:mac
bun --cwd packages/desktop package:linux
```

### 打包失败常见原因

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `Cannot find module .../build-node.ts` | 旧克隆缺少该文件 | `git pull` 更新到最新 main |
| `fatal: not a git repository` / channel 解析失败 | 旧脚本依赖 git branch | 已修复；或手动设 `OPENCODE_CHANNEL` / `OPENCODE_VERSION` |
| `connect ETIMEDOUT` 下载 Electron | 网络访问 GitHub releases 失败 | 设置上面的 `ELECTRON_MIRROR` |
| `磁盘空间不足` / 7z / nsis 失败 | C 盘空间不够 | 清理 C 盘，并把 `ELECTRON_BUILDER_CACHE` 指到 D 盘 |
| `bun install` 很慢或失败 | 依赖未装全 | 必须在**仓库根目录**执行 `bun install` |

## 项目结构

```text
Hoya_agent/
├── packages/
│   ├── desktop/     # Electron 桌面壳
│   ├── app/         # 桌面 / Web 前端 UI
│   ├── opencode/    # 核心服务与 CLI（含 script/build-node.ts）
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
```

关键文件（桌面打包依赖）：

- `packages/opencode/script/build-node.ts` — 构建内嵌 Node 服务
- `packages/desktop/scripts/prebuild.ts` / `predev.ts` — 打包/开发前准备
- `packages/desktop/icons/*` — 应用图标源（会复制到 `resources/icons`）

## 版本

当前桌面端版本：`1.18.4`（见 `packages/desktop/package.json`）

## 许可证

MIT
