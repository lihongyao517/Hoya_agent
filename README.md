# Hoya Agent

一个本地 AI Agent MVP，目标是高效率、高精确度地完成你给出的本地工作区任务。

它支持 OpenAI-compatible 的 Chat Completions / Responses 中转站、Anthropic 官方或兼容 Messages API 的中转站，也支持通过 Ollama 使用本地部署模型。远程模式配置 `HOYA_BASE_URL`、`HOYA_API_KEY` 和 `HOYA_MODEL`；Ollama 模式配置本地 `http://127.0.0.1:11434/v1` endpoint 和已安装模型名即可。项目提供命令行 CLI、Textual TUI、Electron + Vue 3 + Element Plus 桌面端和本地 HTTP 后端服务，支持读取文件、搜索、写入、建立索引、记录历史、可选执行 PowerShell 命令等能力。

## 产品定位与适用边界

Hoya Agent 当前更适合作为“本地工作区任务助手”MVP：让模型在受保护的项目目录里阅读文件、检索上下文、写入文本文件，并在明确授权后辅助运行检查命令。它不适合直接承担无人值守的高风险自动化，例如批量删除文件、跨目录改动、联网采购或操作账号后台。

建议使用时遵循三个原则：

1. 先让 Agent 读文件再下结论。
2. 涉及写入时优先打开 `HOYA_REQUIRE_WRITE_APPROVAL=1` 查看 diff。
3. 涉及命令执行时保持 `HOYA_REQUIRE_SHELL_APPROVAL=1`，由人确认后再放行。

## 项目分层

项目按“共享核心 + 两种本地交互端”组织：

| 部分 | 目录 | 职责 |
| --- | --- | --- |
| 共享 Agent 核心 | `hoya_agent/` | 模型适配、工具调用、会话、工作区安全、HTTP 后端和配置 |
| 终端部分 | `hoya_agent/terminal/` | 轻量 CLI 与 Textual TUI，只负责终端交互和事件展示 |
| 桌面客户端 | `desktop/` | Electron 主进程、Vue + Element Plus 界面、工作区与会话管理 |

终端和桌面客户端复用同一个 `HoyaAgent`、配置文件与 `.hoya/` 工作区状态，不各自复制业务逻辑。

## 功能

- 对话式任务输入。
- OpenAI-compatible Chat Completions / Responses 调用。
- Anthropic Messages API 调用，支持文本流和客户端工具调用。
- Ollama 本地模型模式，使用本地 OpenAI-compatible `/v1/chat/completions` endpoint。
- 工具调用：
  - 查看工作区文件。
  - 读取文件。
  - 读取 `.docx` / `.xlsx` / `.pdf`。
  - 写入文件。
  - 全文搜索。
  - 建立和搜索轻量文件索引。
  - 记录和读取长期记忆。
  - 记录历史会话和工具步骤。
  - 可选在桌面创建 txt 文件。
  - 可选执行 PowerShell 命令。
- 任务 Run 工作流：
  - 按任务相关性装配会话、长期记忆和工作区索引上下文，并生成可见摘要。
  - 持久化四阶段任务计划、运行状态、审批检查点和局部文件版本。
  - 写入后执行 UTF-8 回读、内容哈希及 JSON/Python 语法校验，失败时自动回滚。
  - 审批后把真实工具结果接回原模型循环继续执行，拒绝操作也会恢复原任务收尾。
  - 支持对已验证的局部文件版本进行冲突保护回滚。
- 工作区路径保护，避免写到项目目录外。
- Shell 命令默认关闭；开启后仍建议保留人工审批。
- Shell 工具只适合运行测试、查看环境等简单工作区内命令，不应执行跨目录操作或破坏性命令。

## 技术栈

| 分类 | 技术 |
| --- | --- |
| 语言 | Python |
| TUI | Textual |
| 桌面端 | Electron + Vue 3 + Element Plus + Vite |
| 文档解析 | pypdf，以及项目内置的 docx/xlsx/pdf 读取逻辑 |
| 模型接口 | OpenAI-compatible Chat Completions / Responses；Anthropic Messages；Ollama 本地 OpenAI-compatible endpoint |
| 数据存储 | 本地 JSON / JSONL 历史、记忆、索引和待审批写入 |

## 环境要求

- Python 3.10 或更高版本。
- 一个可用的 OpenAI-compatible / Anthropic API 或中转站，或本地 Ollama 服务。
- Windows PowerShell 环境（Shell 工具按 PowerShell 场景设计）。
- 桌面端开发需要 Node.js 18+ 和 npm。

## 快速开始

### 1. 安装依赖

```powershell
cd D:\projects\projects\Hoya_agent
python -m pip install -r requirements.txt
```

`requirements.txt` 当前包含：

- `textual>=0.80`：TUI 界面。
- `pypdf>=4.0`：PDF 文档读取。

桌面端依赖在 `desktop/package.json` 中，由 npm 管理。

### 2. 复制环境变量示例

```powershell
Copy-Item .env.example .env
```

### 3. 编辑 `.env`

OpenAI-compatible 中转站示例：

```env
HOYA_LLM_PROVIDER=openai-compatible
HOYA_API_KEY=你的中转站key
HOYA_BASE_URL=https://你的中转站API地址/v1
HOYA_MODEL=你的模型名
HOYA_WIRE_API=chat
```

Anthropic 官方或 Anthropic-compatible 中转站示例：

```env
HOYA_LLM_PROVIDER=anthropic
HOYA_API_KEY=你的API密钥
HOYA_BASE_URL=https://api.anthropic.com
HOYA_MODEL=你账号可用的Claude模型名
HOYA_WIRE_API=messages
```

Ollama 本地模型示例：

```powershell
ollama pull qwen2.5-coder:7b
ollama serve
```

```env
HOYA_LLM_PROVIDER=ollama
HOYA_API_KEY=
HOYA_BASE_URL=http://127.0.0.1:11434/v1
HOYA_MODEL=qwen2.5-coder:7b
HOYA_WIRE_API=chat
```

Ollama 模式使用 `/v1/chat/completions`，不是直接调用 `/api/chat`。

## 终端部分

终端源码位于 `hoya_agent/terminal/`，只依赖 Python 环境。CLI 适合快速任务，TUI 适合需要持续观察状态、工具调用和审批流程的任务。

### 启动 CLI

```powershell
python -m hoya_agent
```

### 启动 Textual TUI

```powershell
python -m hoya_agent --tui
```

| 模式 | 启动命令 | 适合场景 |
| --- | --- | --- |
| CLI | `python -m hoya_agent` | 简单对话、快速任务、普通终端环境 |
| TUI | `python -m hoya_agent --tui` | 流式事件、工具状态、快捷键和待审批写入管理 |

TUI 支持模型回复流式输出、工具参数预览、响应式布局，以及 `Ctrl+S` / `Ctrl+J` 发送、`Ctrl+C` 退出、`Ctrl+L` 清空、`Ctrl+T` 切换工具详情、`Esc` 聚焦输入框。

TUI 本地命令：

```text
/help                 查看命令
/import <路径>        导入文件或目录到 imports/
/index                建立工作区索引
/search <关键词>      搜索索引
/history [数量]       查看最近历史会话
/pending              查看待审批写入 diff
/apply <id>           应用待审批写入
/clear                清空当前界面
```

## 桌面客户端部分

桌面客户端源码位于 `desktop/`：`desktop/src/` 是 Vue 3 + Element Plus 界面，`desktop/electron/` 是 Electron 主进程与 preload。客户端通过本地 HTTP 服务复用 Python Agent 核心。

### 开发模式

```powershell
cd desktop
npm install
npm run dev
```

Electron 主进程会自动启动 `python -m hoya_agent --server`，Vue 前端通过 `http://127.0.0.1:8787` 调用 Agent。

### 构建 Windows 客户端

```powershell
cd desktop
npm install
npm run dist:full
```

`npm run dist:full` 会先构建 Python 后端，再通过 electron-builder 生成 Windows 安装包和 portable 程序。产物统一写入 `artifacts/desktop/`，安装包和便携版分别使用 `Hoya-Agent-Setup-*` 与 `Hoya-Agent-Portable-*` 文件名。

Windows 无感更新使用 `electron-updater` 和 NSIS 安装版。客户端启动后会在后台检查 GitHub Release；发现新版本后静默下载，下载完成后可立即重启安装，也会在用户正常退出时自动安装。portable 程序只作为免安装备用版本，不支持 Electron 自动更新。

发布新版本时需要先设置具备仓库 Release 权限的 `GH_TOKEN`，再执行：

```powershell
cd desktop
$env:GH_TOKEN='你的 GitHub Token'
npm run release:github
```

发布命令会把 NSIS 安装包、blockmap 和 `latest.yml` 一起上传到 GitHub Release。三者必须来自同一次构建，否则客户端无法验证或下载更新。

桌面客户端支持：

- 原生窗口化聊天与流式响应，可停止当前运行。
- 对话重命名、颜色标记、删除及工作区切换。
- OpenAI-compatible、Anthropic Messages 和 Ollama 配置，已保存 API Key 会在重启后回填。
- 输入 API Key 与 URL 后调用 `/models` 一键发现模型，并可保存带凭据的模型预设。
- 在聊天输入区直接切换模型和推理强度，选择会同步到当前工作区配置。
- 工具活动、参数预览、索引搜索、历史与待审批写入管理。
- Enter 发送、Shift+Enter 换行。

## 其他接入方式

### 单独启动本地 HTTP 后端

桌面端会通过本地 HTTP 服务调用 Python agent 后端。也可以单独启动服务便于调试：

```powershell
python -m hoya_agent --server --host 127.0.0.1 --port 8787
```

### QQ 私聊桥接

如果你使用 NapCatQQ、Lagrange.OneBot 等 OneBot 兼容 QQ Bot，可以让 Hoya 接收 QQ 私聊消息并回复：

```powershell
python -m hoya_agent --qq
```

然后在 QQ Bot 的反向 HTTP / webhook 配置里填：

```text
http://127.0.0.1:8765/onebot
```

当前 QQ 桥接只支持白名单 QQ 用户的私聊消息，不处理 QQ 群消息。建议 QQ 场景保持：

```env
HOYA_ALLOW_SHELL=0
HOYA_REQUIRE_SHELL_APPROVAL=1
HOYA_REQUIRE_WRITE_APPROVAL=1
HOYA_ALLOW_DESKTOP=0
```

输入任务示例：

```text
帮我阅读 README.md，然后总结项目还能补什么
```

## 环境变量说明

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOYA_LLM_PROVIDER` | `openai-compatible` | 模型来源：`openai-compatible`、`anthropic` 或 `ollama` |
| `HOYA_API_KEY` | 空 | OpenAI-compatible / Anthropic 模式必填；Ollama 模式可为空 |
| `HOYA_BASE_URL` | 空 | API 地址；OpenAI-compatible 可填 `/v1` 或完整接口，Anthropic 可填服务根地址、`/v1` 或完整 `/v1/messages` |
| `HOYA_MODEL` | 空 | 远程模式必填；Ollama 为空时默认 `qwen2.5-coder:7b` |
| `HOYA_WIRE_API` | `chat` | OpenAI-compatible 使用 `chat` / `responses`，Anthropic 固定为 `messages`，Ollama 固定为 `chat` |
| `HOYA_REASONING_EFFORT` | `medium` | 推理强度：`low` / `medium` / `high` / `xhigh` / `max` |
| `HOYA_SHOW_REASONING` | `1` | 是否在界面显示简短公开推理/状态摘要 |
| `HOYA_ALLOW_SHELL` | `0` | 是否允许 Agent 执行 PowerShell 命令 |
| `HOYA_REQUIRE_SHELL_APPROVAL` | `1` | Shell 命令是否需要人工审批 |
| `HOYA_REQUIRE_WRITE_APPROVAL` | `0` | 写文件前是否先进入待审批 diff 队列 |
| `HOYA_ALLOW_DESKTOP` | `0` | 是否允许在桌面创建 txt 文件 |
| `HOYA_TEMPERATURE` | `0.2` | 生成温度 |
| `HOYA_MAX_STEPS` | `8` | 单轮任务最大工具/模型循环步数 |
| `HOYA_HISTORY_CONTEXT_LIMIT` | `12` | 注入最近多少条历史作为上下文 |
| `HOYA_HISTORY_ENTRY_MAX_CHARS` | `4000` | 每条历史最大注入字符数 |
| `HOYA_TOOL_RESULT_MAX_CHARS` | `12000` | 工具结果回填模型前的最大字符数 |

QQ 私聊桥接相关变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOYA_QQ_HOST` | `127.0.0.1` | QQ 桥接 HTTP 服务监听地址 |
| `HOYA_QQ_PORT` | `8765` | QQ 桥接 HTTP 服务监听端口 |
| `HOYA_QQ_WEBHOOK_PATH` | `/onebot` | OneBot 反向 HTTP 上报路径 |
| `HOYA_QQ_WEBHOOK_TOKEN` | 空 | 入站 webhook 校验 token，必填 |
| `HOYA_QQ_ALLOWED_USERS` | 空 | 允许私聊 Hoya 的 QQ 号，逗号分隔，必填 |
| `HOYA_QQ_ONEBOT_API_URL` | 空 | OneBot HTTP API 地址，例如 `http://127.0.0.1:3000`，必填 |
| `HOYA_QQ_ONEBOT_TOKEN` | 空 | OneBot HTTP API access token，可选但建议配置 |
| `HOYA_QQ_MAX_MESSAGE_CHARS` | `4000` | 单条 QQ 输入最大字符数 |
| `HOYA_QQ_REPLY_CHUNK_CHARS` | `1500` | QQ 回复分段字符数 |
| `HOYA_QQ_QUEUE_SIZE` | `1` | 等待队列大小，默认一次只处理一个任务 |
| `HOYA_QQ_REQUEST_TIMEOUT` | `10` | 调用 OneBot HTTP API 的超时时间（秒） |
| `HOYA_QQ_SEND_STATUS` | `1` | 是否向 QQ 发送简短工具调用状态 |

`.env.example` 示例：

```env
HOYA_LLM_PROVIDER=openai-compatible
HOYA_API_KEY=replace_with_your_api_key
HOYA_BASE_URL=https://your-relay.example.com/v1
HOYA_MODEL=gpt-4o-mini
HOYA_WIRE_API=chat

# Ollama local example:
# HOYA_LLM_PROVIDER=ollama
# HOYA_API_KEY=
# HOYA_BASE_URL=http://127.0.0.1:11434/v1
# HOYA_MODEL=qwen2.5-coder:7b
# HOYA_WIRE_API=chat
HOYA_ALLOW_SHELL=0
HOYA_REQUIRE_SHELL_APPROVAL=1
HOYA_REQUIRE_WRITE_APPROVAL=0
HOYA_ALLOW_DESKTOP=0
HOYA_REASONING_EFFORT=medium
HOYA_SHOW_REASONING=1
HOYA_TEMPERATURE=0.2
HOYA_MAX_STEPS=8
HOYA_HISTORY_CONTEXT_LIMIT=12
HOYA_HISTORY_ENTRY_MAX_CHARS=4000
HOYA_TOOL_RESULT_MAX_CHARS=12000

HOYA_QQ_HOST=127.0.0.1
HOYA_QQ_PORT=8765
HOYA_QQ_WEBHOOK_PATH=/onebot
HOYA_QQ_WEBHOOK_TOKEN=replace_with_strong_random_token
HOYA_QQ_ALLOWED_USERS=123456789
HOYA_QQ_ONEBOT_API_URL=http://127.0.0.1:3000
HOYA_QQ_ONEBOT_TOKEN=replace_with_onebot_access_token
HOYA_QQ_MAX_MESSAGE_CHARS=4000
HOYA_QQ_REPLY_CHUNK_CHARS=1500
HOYA_QQ_QUEUE_SIZE=1
HOYA_QQ_REQUEST_TIMEOUT=10
HOYA_QQ_SEND_STATUS=1
```

## 工作方式建议

当需求比较模糊时，Agent 应先用产品经理方式收敛问题：明确目标用户、成功标准、输入输出、风险边界和最小可交付结果。复杂任务应先给出简短计划，再读取文件、写入文件或运行检查。

CLI、TUI 和桌面端都会写入：

| 文件 | 说明 |
| --- | --- |
| `.hoya/history.jsonl` | 用户输入和模型回复历史 |
| `.hoya/runs.jsonl` | 任务开始、结束、错误和工具调用事件 |
| `.hoya/task_runs.json` | 持久化任务计划、上下文摘要、审批检查点和 Run 状态 |
| `.hoya/versions.json`、`.hoya/versions/` | 局部文件版本元数据和回滚快照 |
| `.hoya/memory.json` | 长期记忆 |
| `.hoya/index.json` | 工作区轻量索引 |
| `.hoya/pending_writes.json` | 待审批写入队列 |
| `.hoya/conversations.json`、`.hoya/conversations/` | 桌面端、CLI 和 TUI 的会话数据 |
| `imports/` | `/import` 导入的文件或目录 |

旧版本放在工作区根目录的 `.hoya_*` 文件和会话目录会在首次启动时自动迁移到 `.hoya/`。

Agent 每轮任务会按当前请求的相关性选择会话历史和长期记忆；如果工作区索引存在，还会注入得分最高的文件导航片段。对于“继续”“刚才那个文件”“上一句提到的问题”等明确跟进请求，则保留最近对话顺序。Run 面板会展示本轮实际复用的上下文摘要。可用 `HOYA_HISTORY_CONTEXT_LIMIT` 控制最多注入多少条历史，用 `HOYA_HISTORY_ENTRY_MAX_CHARS` 控制每条历史最多注入多少字符，避免上下文过长导致成本、延迟或跑题。工具结果回填模型前也会按 `HOYA_TOOL_RESULT_MAX_CHARS` 截断。

本地 Ollama 模型对长上下文更敏感。使用 Ollama 且这些变量未显式设置时，Hoya 会自动使用更小默认值：`HOYA_MAX_STEPS=4`、`HOYA_HISTORY_CONTEXT_LIMIT=4`、`HOYA_HISTORY_ENTRY_MAX_CHARS=1200`、`HOYA_TOOL_RESULT_MAX_CHARS=4000`。如果回答开始复读旧内容或不理新问题，请使用 CLI/TUI 的 `/reset`，或桌面端“新建对话 / 重置上下文”。长期记忆不会因此删除。

## 可选：允许执行命令

默认不允许 Agent 执行命令。若你希望它能跑测试、查看环境等，可以在 `.env` 中打开：

```env
HOYA_ALLOW_SHELL=1
```

命令仍会限制在当前工作区内执行，并有超时保护。默认还需要人工审批：

```env
HOYA_REQUIRE_SHELL_APPROVAL=1
```

如果你确认要让 Agent 直接执行命令，可以改成：

```env
HOYA_REQUIRE_SHELL_APPROVAL=0
```

建议只把 Shell 用于：

- 运行测试。
- 查看版本和环境。
- 执行项目内构建或检查命令。

不要让 Agent 执行跨目录删除、系统设置修改、账号后台操作等高风险命令。

## 可选：写文件前先生成 diff

如果你希望 Agent 写文件前先进入待审批队列，可以打开：

```env
HOYA_REQUIRE_WRITE_APPROVAL=1
```

之后可以在 TUI 里用：

```text
/pending
/apply <id>
```

也可以在桌面端的“待审批”面板里查看风险和 diff 后批准或拒绝。桌面端会自动恢复原 Run；TUI 的 `/apply` 和 `/deny` 也会执行同样的恢复流程。批准时返回实际写入/命令结果，拒绝时返回明确的拒绝结果，模型会在同一任务上下文中继续收尾。

所有工作区文本写入都会创建局部版本并完成回读与基础语法校验。可在桌面端 Run 面板查看版本和校验状态并回滚；如果目标文件在版本创建后又被修改，回滚会拒绝覆盖较新的内容。

## 可选：允许在桌面创建 txt

默认不允许 Agent 写入项目目录之外。若你希望它能完成“在桌面新建 txt 文件”这类任务，可以在 `.env` 中打开：

```env
HOYA_ALLOW_DESKTOP=1
```

## 模型服务要求

### OpenAI-compatible 中转站

OpenAI-compatible 模式走 Chat Completions：

```text
POST {HOYA_BASE_URL}/chat/completions
Authorization: Bearer {HOYA_API_KEY}
```

如果你的中转站路径不是 `/v1/chat/completions` 这种格式，把 `HOYA_BASE_URL` 设置到 `/v1` 这一层即可。

注意：`HOYA_BASE_URL` 要填 API 地址，不要填中转站网页后台地址。若填错，返回内容通常会是 HTML 页面，例如 `<!doctype html>`。

也可以直接填完整接口：

```env
HOYA_BASE_URL=https://你的中转站API地址/v1/chat/completions
HOYA_WIRE_API=chat
```

如果你的中转站使用 Responses API：

```env
HOYA_BASE_URL=https://你的中转站API地址
HOYA_WIRE_API=responses
```

Agent 会请求：

```text
https://你的中转站API地址/v1/responses
```

如果你的中转站给的是完整 Responses 地址，也可以直接填：

```env
HOYA_BASE_URL=https://你的中转站API地址/v1/responses
HOYA_WIRE_API=responses
```

### Anthropic 官方 API 与中转站

Anthropic 模式走 Messages API，并使用 Anthropic 的消息内容块和工具调用协议：

```text
POST {HOYA_BASE_URL}/v1/messages
x-api-key: {HOYA_API_KEY}
anthropic-version: 2023-06-01
```

官方地址配置：

```env
HOYA_LLM_PROVIDER=anthropic
HOYA_API_KEY=你的API密钥
HOYA_BASE_URL=https://api.anthropic.com
HOYA_MODEL=你账号可用的Claude模型名
HOYA_WIRE_API=messages
```

兼容 Anthropic Messages API 的中转站可以把 `HOYA_BASE_URL` 设置为中转站根地址、以 `/v1` 结尾的地址，或完整 `/v1/messages` 地址。客户端会同时发送 `x-api-key` 和 Bearer Authorization，兼容常见网关鉴权方式。

### Ollama 本地模型

Ollama 模式使用 Ollama 的 OpenAI-compatible endpoint：

```text
POST http://127.0.0.1:11434/v1/chat/completions
```

示例配置：

```env
HOYA_LLM_PROVIDER=ollama
HOYA_API_KEY=
HOYA_BASE_URL=http://127.0.0.1:11434/v1
HOYA_MODEL=qwen2.5-coder:7b
HOYA_WIRE_API=chat
```

Ollama 模式不会发送 `Authorization` 请求头。`HOYA_WIRE_API` 会固定为 `chat`，即使 `.env` 里写了 `responses` 也会按 `chat` 运行。

注意：Hoya Agent 依赖 OpenAI-compatible tool/function calling。部分 Ollama 模型可以聊天，但工具调用不稳定，可能影响读取、搜索、写入等 Agent 能力。建议升级 Ollama，并使用支持工具调用的代码模型。

## 子项目：本地文档 AI 学习助手

仓库内还包含一个独立的 RAG 学习助手项目：

```text
local_ai_study_assistant/
```

它用于上传本地文档、构建本地知识库并基于检索片段回答问题。详细说明见：

```text
local_ai_study_assistant/README.md
```

## 项目结构

```text
Hoya_agent/
├── hoya_agent/
│   ├── __main__.py             # CLI / TUI / QQ / server 入口选择
│   ├── terminal/
│   │   ├── cli.py              # 轻量命令行入口
│   │   └── tui.py              # Textual 终端界面
│   ├── agent.py                # 共享 Agent 调度核心
│   ├── config.py               # HOYA_* 配置读取
│   ├── server.py               # Electron 调用的本地 HTTP 后端
│   └── ...                     # 工具、模型客户端、会话、索引等共享模块
├── desktop/
│   ├── electron/               # Electron 主进程和 preload
│   └── src/                    # Vue 3 + Element Plus 桌面客户端
├── tests/                      # Python 核心自动化测试
├── docs/                       # 项目说明和补充文档
├── local_ai_study_assistant/   # 独立 RAG 学习助手
├── artifacts/                  # 本地构建产物（Git 忽略）
├── archive/                    # 本地历史文件归档（Git 忽略）
├── .hoya/                      # 本地运行状态（Git 忽略）
├── build_backend.ps1           # Python 后端打包脚本
├── .env.example
├── requirements.txt
└── README.md
```

## 测试与验证

Python 核心测试：

```powershell
python -m unittest discover -s tests -v
```

桌面客户端类型检查与生产构建：

```powershell
cd desktop
npm run build:renderer
```

建议再做以下手动验证：

1. 执行 `python -m hoya_agent`，输入一个只读任务。
2. 执行 `python -m hoya_agent --tui`，确认终端界面能启动。
3. 执行 `cd desktop && npm run dev`，确认桌面客户端可连接本地后端。
4. 如开启写入或 Shell 权限，保持审批开关并验证对应流程。

## 常见问题

### 提示缺少 `HOYA_API_KEY` / `HOYA_BASE_URL` / `HOYA_MODEL`

OpenAI-compatible 和 Anthropic 模式都需要填写 API key、base URL 和 model。Anthropic 模式还需要设置 `HOYA_LLM_PROVIDER=anthropic`，接口类型会固定为 `messages`。请复制 `.env.example` 为 `.env`，并填写必需变量。

如果你使用 Ollama，请设置：

```env
HOYA_LLM_PROVIDER=ollama
HOYA_API_KEY=
HOYA_BASE_URL=http://127.0.0.1:11434/v1
HOYA_MODEL=qwen2.5-coder:7b
HOYA_WIRE_API=chat
```

### 返回内容是 HTML 或 `<!doctype html>`

通常是 `HOYA_BASE_URL` 填成了中转站网页后台地址，而不是 API 地址。请改成 `/v1`、`/v1/chat/completions` 或 `/v1/responses` 形式的接口地址。

### Ollama 连接失败怎么办？

先确认 Ollama 已启动并已拉取模型：

```powershell
ollama pull qwen2.5-coder:7b
ollama serve
```

如果 `ollama serve` 提示端口已被占用，通常说明服务已经在运行。也可以直接检查：

```powershell
Invoke-RestMethod http://127.0.0.1:11434/api/tags
```

### 模型不支持工具调用怎么办？

请换用支持 OpenAI-compatible tool/function calling 的模型或中转站配置。否则 Agent 可能无法稳定调用读取、搜索、写入等工具。Ollama 场景下尤其要注意：能正常聊天不代表一定能稳定执行工具调用。

### 为什么不能执行命令？

默认 `HOYA_ALLOW_SHELL=0`。如需执行命令，改为：

```env
HOYA_ALLOW_SHELL=1
HOYA_REQUIRE_SHELL_APPROVAL=1
```

### 写入为什么没有直接落盘？

如果开启了 `HOYA_REQUIRE_WRITE_APPROVAL=1`，写入会先进入待审批队列。请在 TUI 中执行：

```text
/pending
/apply <id>
```

### TUI 启动提示 Textual 未安装

执行：

```powershell
python -m pip install -r requirements.txt
```

## 安全注意事项

- 不要把 `.env`、API Key、Token、真实账号密码提交到仓库。
- Shell 权限默认关闭，除非明确需要，否则不要开启。
- 即使开启 Shell，也建议保留人工审批。
- 对写入文件、执行命令、桌面写入等操作保持最小权限原则。
- 不建议用于无人值守、高风险或跨目录自动化任务。

## 隐私、许可证与更新

- 本项目使用 [MIT License](LICENSE)。
- 数据处理与联网行为见 [隐私政策](PRIVACY.md)。
- Windows 客户端通过 GitHub Releases 获取版本信息、更新元数据和安装包；检测到新版本后在后台下载，并在退出或用户确认后完成安装。
- Windows 正式版本通过 SignPath Foundation 提供的免费开源证书签名，签名流程见 [代码签名政策](CODE_SIGNING_POLICY.md)。
- Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).
