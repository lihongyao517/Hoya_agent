# HoyaAgent

HoyaAgent 是面向本地开发的 AI 编程助手桌面端。

- **前端**：Electron + SolidJS（OpenCode Desktop 风格 UI）
- **内核**：Pi（`D:\程序\hoyaagent\pi` / `@earendil-works/pi-coding-agent`）
- **桥接**：`packages/pi-bridge` 提供 OpenCode 兼容的 HTTP/SSE，让现有前端正常显示

仓库：https://github.com/lihongyao517/Hoya_agent

## 架构

```text
桌面 UI (packages/app)
    │  HTTP + SSE（/session /provider /global/event …）
    ▼
pi-bridge (packages/pi-bridge)   ← OpenCode 合同适配层
    │  进程内 SDK
    ▼
Pi coding-agent / agent-core / pi-ai
```

## 功能概览

- 桌面应用（Windows 优先）
- Pi 多提供商模型（Anthropic / OpenAI / Google / OpenRouter 等）
- 会话、流式回复、工具调用（read / bash / edit / write）
- 经典布局默认
- 本地数据：`~/.hoya`（Pi agent 配置在 `~/.hoya/pi-agent`）

## 环境要求

- [Bun](https://bun.sh) `1.3+`
- [Node.js](https://nodejs.org) `>= 22.19`（构建 Pi 需要）
- 本地 Pi 源码：`D:\程序\hoyaagent\pi`（或设置 `HOYA_PI_ROOT`）

## 准备 Pi 内核

```powershell
cd D:\程序\hoyaagent\pi
npm install --ignore-scripts
npm run hydrate:model-data
npm run build:offline
```

确认存在：

```text
D:\程序\hoyaagent\pi\packages\coding-agent\dist\index.js
```

## 从源码运行

```powershell
cd D:\程序\hoyaagent\Hoya_agent
bun install

# 指向 Pi monorepo
$env:HOYA_PI_ROOT = "D:\程序\hoyaagent\pi"
$env:HOYA_KERNEL = "pi"

# 开发模式
bun --cwd packages/desktop dev
```

## 单独调试 pi-bridge

```powershell
$env:HOYA_PI_ROOT = "D:\程序\hoyaagent\pi"
$env:HOYA_HOME = "$env:USERPROFILE\.hoya"
$env:OPENCODE_SERVER_PASSWORD = "dev"
$env:PORT = "4096"
bun packages/pi-bridge/src/cli.ts

# 另开终端探测
curl http://127.0.0.1:4096/global/health
```

## 打包 Windows

```powershell
$env:HOYA_PI_ROOT = "D:\程序\hoyaagent\pi"
$env:HOYA_KERNEL = "pi"
$env:OPENCODE_CHANNEL = "prod"
$env:OPENCODE_VERSION = "1.18.4"
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_CACHE = "D:\cache\electron-builder"

bun --cwd packages/desktop build
bun --cwd packages/desktop package:win
```

产物：

```text
packages/desktop/dist/HoyaAgent-win-x64.exe
```

## 使用说明

1. 启动应用
2. 设置 → 提供商 → 连接 API Key（写入 `~/.hoya/pi-agent/auth.json`）
3. 选择模型，新建会话，开始对话
4. 工具调用会以卡片形式出现在时间线

## 当前限制（Pi MVP）

| 能力 | 状态 |
|------|------|
| 会话 / 流式回复 | 已实现 |
| 工具卡片（bash/read/edit/write） | 已实现（基础映射） |
| 提供商 API Key | 已实现 |
| MCP | 未实现（UI 可忽略） |
| 内置终端 PTY | 未接 Pi |
| OpenCode 会话迁移 | 不兼容，使用 Pi JSONL |
| WSL sidecar | 未适配 Pi |

## 项目结构

```text
Hoya_agent/
├── packages/
│   ├── desktop/      # Electron 壳（sidecar 加载 pi-bridge）
│   ├── app/          # Solid 前端
│   ├── pi-bridge/    # ★ Pi 内核适配层（OpenCode HTTP 合同）
│   ├── opencode/     # 旧内核（仅 fallback，默认不用）
│   └── ...
└── README.md
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `HOYA_PI_ROOT` | Pi monorepo 路径 |
| `HOYA_KERNEL` | `pi`（默认）或 `opencode` |
| `HOYA_HOME` | 本地配置根目录 |
| `PI_CODING_AGENT_DIR` | Pi agent 配置目录（默认 `HOYA_HOME/pi-agent`） |
| `OPENCODE_SERVER_PASSWORD` | sidecar Basic 密码 |

## 版本

桌面端：`1.18.4`  
内核：Pi coding-agent（本地 monorepo）

## 许可证

MIT
