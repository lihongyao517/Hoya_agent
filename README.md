# Hoya Agent

一个本地 AI Agent MVP，目标是高效率、高精确度地完成你给出的任务。

它默认使用 OpenAI-compatible 的中转站接口，只需要配置 `BASE_URL`、`API_KEY` 和 `MODEL`。

## 产品定位与适用边界

Hoya Agent 当前更适合作为“本地工作区任务助手”MVP：让模型在受保护的项目目录里阅读文件、检索上下文、写入文本文件，并在明确授权后辅助运行检查命令。它不适合直接承担无人值守的高风险自动化，例如批量删除文件、跨目录改动、联网采购或操作账号后台。

建议使用时遵循三个原则：先让 Agent 读文件再下结论；涉及写入时优先打开 `HOYA_REQUIRE_WRITE_APPROVAL=1` 查看 diff；涉及命令执行时保持 `HOYA_REQUIRE_SHELL_APPROVAL=1`，由人确认后再放行。

## 功能

- 对话式任务输入
- OpenAI-compatible Chat Completions 调用
- 工具调用：
  - 查看工作区文件
  - 读取文件
  - 读取 `.docx` / `.xlsx` / `.pdf`
  - 写入文件
  - 全文搜索
  - 建立和搜索轻量文件索引
  - 记录和读取长期记忆
  - 记录历史会话和工具步骤
  - 可选在桌面创建 txt 文件
  - 可选执行 PowerShell 命令
- 工作区路径保护，避免写到项目目录外
- Shell 命令默认关闭；开启后仍建议保留人工审批
- Shell 工具只适合运行测试、查看环境等简单工作区内命令，不应执行跨目录操作或破坏性命令

## 快速开始

1. 复制环境变量示例：

```powershell
Copy-Item .env.example .env
```

2. 编辑 `.env`：

```env
HOYA_API_KEY=你的中转站key
HOYA_BASE_URL=https://你的中转站API地址/v1
HOYA_MODEL=你的模型名
HOYA_WIRE_API=chat
```

3. 启动：

```powershell
python -m hoya_agent
```

也可以启动 Textual 图形终端界面：

```powershell
python -m pip install -r requirements.txt
python -m hoya_agent --tui
```

Textual 界面支持：

- 模型回复流式输出
- 响应式布局：宽屏显示侧栏，窄屏自动隐藏侧栏和按钮
- 主会话区 + 右侧状态栏 + 底部多行输入栏
- 工具调用状态显示
- 模型、工作区、Shell 权限、桌面写入权限显示
- 快捷键：`Ctrl+S` / `Ctrl+J` 发送，`Ctrl+C` 退出，`Ctrl+L` 清空，`Esc` 聚焦输入框

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

4. 输入任务，例如：

```text
帮我阅读 README.md，然后总结项目还能补什么
```

## 工作方式建议

当需求比较模糊时，Agent 应先用产品经理方式收敛问题：明确目标用户、成功标准、输入输出、风险边界和最小可交付结果。复杂任务应先给出简短计划，再读取文件、写入文件或运行检查。涉及文件修改时，建议打开 `HOYA_REQUIRE_WRITE_APPROVAL=1`，让写入先进入待审批队列；涉及命令执行时，建议保留 Shell 人工审批。

CLI 和 TUI 都会写入 `.hoya_history.jsonl` 记录用户输入和模型回复，并写入 `.hoya_runs.jsonl` 记录任务开始、结束、错误和非流式工具调用摘要。Agent 每轮任务会读取最近的会话历史作为短期上下文，因此可以理解“继续”“刚才那个文件”“上一句提到的问题”等跨轮引用。可用 `HOYA_HISTORY_CONTEXT_LIMIT` 控制注入最近多少条历史，用 `HOYA_HISTORY_ENTRY_MAX_CHARS` 控制每条历史最多注入多少字符，避免上下文过长导致成本、延迟或跑题。工具结果回填模型前也会按 `HOYA_TOOL_RESULT_MAX_CHARS` 截断，避免大文件读取或大量搜索结果撑爆上下文；需要更完整的工具结果时可以调高该值。TUI 还会实时显示工具调用状态，便于复盘 Agent 做过什么。

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
```

如果你的中转站配置类似：

```toml
wire_api = "responses"
base_url = "https://xuseny.online"
```

则 `.env` 可以写：

```env
HOYA_BASE_URL=https://xuseny.online
HOYA_WIRE_API=responses
```

Agent 会请求：

```text
https://xuseny.online/v1/responses
```

如果你的中转站给的是完整 Responses 地址，也可以直接填：

```env
HOYA_BASE_URL=https://你的中转站API地址/v1/responses
HOYA_WIRE_API=responses
```
