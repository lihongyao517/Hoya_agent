# Hoya Agent

一个本地 AI Agent MVP，目标是高效率、高精确度地完成你给出的本地工作区任务。

它默认使用 OpenAI-compatible 的中转站接口，只需要配置 `HOYA_BASE_URL`、`HOYA_API_KEY` 和 `HOYA_MODEL`。项目提供命令行 CLI 和 Textual TUI 两种入口，支持读取文件、搜索、写入、建立索引、记录历史、可选执行 PowerShell 命令等能力。

## 产品定位与适用边界

Hoya Agent 当前更适合作为“本地工作区任务助手”MVP：让模型在受保护的项目目录里阅读文件、检索上下文、写入文本文件，并在明确授权后辅助运行检查命令。它不适合直接承担无人值守的高风险自动化，例如批量删除文件、跨目录改动、联网采购或操作账号后台。

建议使用时遵循三个原则：

1. 先让 Agent 读文件再下结论。
2. 涉及写入时优先打开 `HOYA_REQUIRE_WRITE_APPROVAL=1` 查看 diff。
3. 涉及命令执行时保持 `HOYA_REQUIRE_SHELL_APPROVAL=1`，由人确认后再放行。

## 功能

- 对话式任务输入。
- OpenAI-compatible Chat Completions / Responses 调用。
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
- 工作区路径保护，避免写到项目目录外。
- Shell 命令默认关闭；开启后仍建议保留人工审批。
- Shell 工具只适合运行测试、查看环境等简单工作区内命令，不应执行跨目录操作或破坏性命令。

## 技术栈

| 分类 | 技术 |
| --- | --- |
| 语言 | Python |
| TUI | Textual |
| 文档解析 | pypdf，以及项目内置的 docx/xlsx/pdf 读取逻辑 |
| 模型接口 | OpenAI-compatible Chat Completions / Responses |
| 数据存储 | 本地 JSON / JSONL 历史、记忆、索引和待审批写入 |

## 环境要求

- Python 3.10 或更高版本。
- 一个可用的 OpenAI-compatible 模型中转站或模型服务。
- Windows PowerShell 环境（Shell 工具按 PowerShell 场景设计）。

## 快速开始

### 1. 安装依赖

```powershell
cd D:\projects\projects\Hoya_agent
python -m pip install -r requirements.txt
```

`requirements.txt` 当前包含：

- `textual>=0.80`：TUI 界面。
- `pypdf>=4.0`：PDF 文档读取。

### 2. 复制环境变量示例

```powershell
Copy-Item .env.example .env
```

### 3. 编辑 `.env`

```env
HOYA_API_KEY=你的中转站key
HOYA_BASE_URL=https://你的中转站API地址/v1
HOYA_MODEL=你的模型名
HOYA_WIRE_API=chat
```

### 4. 启动 CLI

```powershell
python -m hoya_agent
```

### 5. 启动 TUI

```powershell
python -m hoya_agent --tui
```

### 6. 可选：启动 QQ 私聊桥接

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

## CLI 与 TUI 的区别

| 模式 | 启动命令 | 适合场景 |
| --- | --- | --- |
| CLI | `python -m hoya_agent` | 简单对话、快速任务、终端环境 |
| TUI | `python -m hoya_agent --tui` | 需要事件流、工具调用状态、快捷键、待审批写入管理的交互式任务 |
| QQ 私聊桥接 | `python -m hoya_agent --qq` | 通过 OneBot 兼容 QQ Bot 私聊 Hoya 并发送任务 |

TUI 本身依赖 Textual。如果提示未安装，请先执行：

```powershell
python -m pip install -r requirements.txt
```

## Textual TUI 支持能力

- 类 Claude Code CLI 的终端式事件流：用户输入、状态、工具调用、最终回答在同一条时间线中显示。
- 模型回复流式输出，不必等任务结束才看到答案。
- 工具调用状态和参数预览；工具结果默认折叠，按 `Ctrl+T` 切换后续工具结果详情。
- 响应式布局：宽屏显示轻量上下文栏，中窄屏自动隐藏侧栏和按钮，把空间留给消息流。
- 底部 prompt 风格多行输入栏，适合直接键入任务或本地命令。
- 模型、工作区、Shell 权限、桌面写入权限显示。
- 快捷键：`Ctrl+S` / `Ctrl+J` 发送，`Ctrl+C` 退出，`Ctrl+L` 清空，`Ctrl+T` 切换工具详情，`Esc` 聚焦输入框。

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

## 环境变量说明

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOYA_API_KEY` | 空 | 模型服务 API Key，必填 |
| `HOYA_BASE_URL` | 空 | API 地址，可填 `/v1`、完整 `/v1/chat/completions` 或完整 `/v1/responses` |
| `HOYA_MODEL` | 空 | 模型名，必填 |
| `HOYA_WIRE_API` | `chat` | 接口类型：`chat` 或 `responses` |
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
HOYA_API_KEY=replace_with_your_api_key
HOYA_BASE_URL=https://your-relay.example.com/v1
HOYA_MODEL=gpt-4o-mini
HOYA_WIRE_API=chat
HOYA_ALLOW_SHELL=0
HOYA_REQUIRE_SHELL_APPROVAL=1
HOYA_REQUIRE_WRITE_APPROVAL=0
HOYA_ALLOW_DESKTOP=0
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

CLI 和 TUI 都会写入：

| 文件 | 说明 |
| --- | --- |
| `.hoya_history.jsonl` | 用户输入和模型回复历史 |
| `.hoya_runs.jsonl` | 任务开始、结束、错误和工具调用事件 |
| `.hoya_memory.json` | 长期记忆 |
| `.hoya_index.json` | 工作区轻量索引 |
| `.hoya_pending_writes.json` | 待审批写入队列 |
| `imports/` | `/import` 导入的文件或目录 |

Agent 每轮任务会读取最近的会话历史作为短期上下文，因此可以理解“继续”“刚才那个文件”“上一句提到的问题”等跨轮引用。可用 `HOYA_HISTORY_CONTEXT_LIMIT` 控制注入最近多少条历史，用 `HOYA_HISTORY_ENTRY_MAX_CHARS` 控制每条历史最多注入多少字符，避免上下文过长导致成本、延迟或跑题。工具结果回填模型前也会按 `HOYA_TOOL_RESULT_MAX_CHARS` 截断。

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

之后在 TUI 里用：

```text
/pending
/apply <id>
```

这样可以先人工查看 diff，再决定是否应用。

## 可选：允许在桌面创建 txt

默认不允许 Agent 写入项目目录之外。若你希望它能完成“在桌面新建 txt 文件”这类任务，可以在 `.env` 中打开：

```env
HOYA_ALLOW_DESKTOP=1
```

## 中转站要求

默认中转站走 OpenAI Chat Completions：

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
│   ├── __main__.py             # CLI / TUI 入口选择
│   ├── cli.py                  # 命令行入口
│   ├── config.py               # HOYA_* 配置读取
│   ├── tui.py                  # Textual TUI
│   └── ...                     # 工具、模型客户端、历史、索引等模块
├── local_ai_study_assistant/   # 独立 RAG 学习助手
├── .env.example
├── requirements.txt
└── README.md
```

## 测试与验证

当前项目未提供统一自动化测试脚本，建议手动验证：

1. 执行 `python -m pip install -r requirements.txt`。
2. 复制 `.env.example` 为 `.env` 并填写 API 配置。
3. 执行 `python -m hoya_agent`，输入一个只读任务，例如“总结当前目录文件”。
4. 执行 `python -m hoya_agent --tui`，确认 TUI 能启动并显示模型、工作区和权限状态。
5. 如开启 `HOYA_REQUIRE_WRITE_APPROVAL=1`，测试写文件任务是否进入 `/pending` 队列。
6. 如开启 `HOYA_ALLOW_SHELL=1`，保持 `HOYA_REQUIRE_SHELL_APPROVAL=1` 并测试简单命令审批流程。

## 常见问题

### 提示缺少 `HOYA_API_KEY` / `HOYA_BASE_URL` / `HOYA_MODEL`

请复制 `.env.example` 为 `.env`，并填写三个必需变量。

### 返回内容是 HTML 或 `<!doctype html>`

通常是 `HOYA_BASE_URL` 填成了中转站网页后台地址，而不是 API 地址。请改成 `/v1`、`/v1/chat/completions` 或 `/v1/responses` 形式的接口地址。

### 模型不支持工具调用怎么办？

请换用支持 OpenAI-compatible tool/function calling 的模型或中转站配置。否则 Agent 可能无法稳定调用读取、搜索、写入等工具。

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
