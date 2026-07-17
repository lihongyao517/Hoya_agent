# 基于本地文档的 AI 学习助手

这是一个面向学习资料问答的 RAG 小项目。用户上传本地文档后，系统会解析文档、切分文本片段、构建本地知识库；用户提问时，系统先检索相关片段，再结合 OpenAI-compatible 大模型生成回答，并展示引用来源。

即使没有配置 API Key，项目也可以返回最相关的检索片段，适合课堂演示 RAG 的“文档入库 → 检索 → 回答”流程。

## 功能特性

- 上传并解析 `txt`、`md`、`docx` 文档。
- 可选支持 `pdf`，需要安装 `pypdf`。
- 上传文件保存到 `data/uploads/`。
- 本地知识库索引持久化到 `data/index.json`。
- 基于 TF-IDF / 字符特征和余弦相似度检索相关片段。
- 调用 OpenAI-compatible Chat Completions 生成回答。
- 未配置 `LSA_API_KEY` 时，仍可返回最相关文档片段。
- 简单 Web 页面：文档上传、知识库列表、问答、引用展示。
- 提供索引重建接口，便于根据本地上传文件恢复知识库。

## 技术栈

| 分类 | 技术 |
| --- | --- |
| 服务端 | Python 标准库 `http.server`、`ThreadingHTTPServer` |
| 文档解析 | txt / md / docx，PDF 依赖 `pypdf` |
| 检索 | 本地知识库、TF-IDF / 余弦相似度 |
| 大模型 | OpenAI-compatible Chat Completions |
| 前端 | 原生 HTML / CSS / JavaScript |
| 数据存储 | 本地文件 `data/uploads/`、`data/index.json` |

## 项目结构

```text
local_ai_study_assistant/
├── app.py                 # HTTP 服务入口
├── .env.example           # 配置模板
├── assistant/
│   ├── config.py          # LSA_* 环境变量配置
│   ├── documents.py       # 文档解析与切片
│   ├── knowledge_base.py  # 本地知识库索引
│   ├── retriever.py       # 检索与相似度计算
│   ├── rag.py             # RAG Prompt 与回答生成
│   ├── llm_client.py      # OpenAI-compatible API 调用
│   ├── agent_tool.py      # Agent 付费工具 schema、请求校验与响应封装
│   ├── payment.py         # off / mock / x402 支付校验边界
│   └── usage_log.py       # Agent 付费端点调用记录 JSONL
├── web/
│   ├── index.html
│   └── static/
│       ├── app.js
│       └── styles.css
└── data/
    ├── uploads/           # 上传的原始文档，运行后自动生成
    └── index.json         # 知识库索引，运行后自动生成
```

## 快速开始

### 1. 进入项目目录

```powershell
cd D:\projects\projects\Hoya_agent\local_ai_study_assistant
```

### 2. 安装依赖

项目主体使用 Python 标准库。若需要解析 PDF，需安装父项目依赖中的 `pypdf`：

```powershell
python -m pip install -r ..\requirements.txt
```

如果只使用 `txt`、`md`、`docx`，可先不安装额外依赖。

### 3. 复制配置文件

```powershell
Copy-Item .env.example .env
```

### 4. 编辑 `.env`

```env
LSA_HOST=127.0.0.1
LSA_PORT=8008
LSA_API_KEY=你的API_KEY
LSA_BASE_URL=https://api.openai.com/v1
LSA_MODEL=gpt-4o-mini
LSA_MAX_CONTEXT_CHARS=6000
```

配置项说明：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LSA_HOST` | `127.0.0.1` | 本地服务监听地址 |
| `LSA_PORT` | `8008` | 本地服务端口 |
| `LSA_API_KEY` | 空 | 大模型 API Key；为空时只返回检索片段 |
| `LSA_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible API 地址 |
| `LSA_MODEL` | `gpt-4o-mini` | 使用的模型名 |
| `LSA_MAX_CONTEXT_CHARS` | `6000` | 发送给模型的最大检索上下文字数 |
| `LSA_AGENT_TOOL_ENABLED` | `1` | 是否启用 `/api/agent/schema` 和 `/api/agent/ask` |
| `LSA_AGENT_MAX_QUESTION_CHARS` | `2000` | Agent 端点允许的问题最大长度 |
| `LSA_AGENT_DEFAULT_TOP_K` | `5` | Agent 端点默认检索片段数 |
| `LSA_AGENT_MAX_TOP_K` | `10` | Agent 端点允许的最大检索片段数 |
| `LSA_PAYMENT_MODE` | `off` | 支付模式：`off` / `mock` / `x402` |
| `LSA_PAYMENT_PRICE` | `$0.001` | Agent 付费端点展示价格 |
| `LSA_PAYMENT_ASSET` | `USDC` | Agent 付费端点展示资产 |
| `LSA_PAYMENT_NETWORK` | `base-sepolia` | Agent 付费端点展示网络 |
| `LSA_PAYMENT_RECIPIENT` | 空 | 收款地址或支付接收方标识 |
| `LSA_PAYMENT_MOCK_TOKEN` | `dev-paid` | mock 模式下的演示支付 token |
| `LSA_X402_VERIFY_URL` | 空 | x402 模式下的外部校验服务地址 |
| `LSA_USAGE_LOG_PATH` | `data/usage.jsonl` | Agent 付费端点调用记录 |

### 5. 启动服务

```powershell
python app.py
```

浏览器打开：

```text
http://127.0.0.1:8008
```

## RAG 流程

```text
用户上传文档
  ↓
保存到 data/uploads/
  ↓
解析正文
  ↓
切分为多个文本片段
  ↓
写入 data/index.json
  ↓
用户提问
  ↓
问题关键词化 / 向量化特征计算
  ↓
检索 Top-K 相关片段
  ↓
问题 + 片段组成 Prompt
  ↓
调用大模型生成回答
  ↓
展示答案和引用来源
```

## 接口说明

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/` | Web 页面 |
| `GET` | `/api/documents` | 获取已入库文档列表 |
| `POST` | `/api/documents` | 上传文档并写入知识库 |
| `POST` | `/api/ask` | 提问并返回答案与引用 |
| `GET` | `/api/agent/schema` | 获取 Agent 可调用工具说明和支付要求 |
| `POST` | `/api/agent/ask` | Agent 付费知识问答端点，支持 mock / x402 支付模式 |
| `POST` | `/api/rebuild` | 根据 `data/uploads/` 重建索引 |

## Paid Agent Tool / GOAT x402 Demo

这个子项目现在可以作为一个最小的 Agent-native 付费知识工具 Demo：

- `/api/ask` 保持原有免费本地接口，Web 页面继续使用它，不会影响课堂或本地演示。
- `/api/agent/ask` 是给外部 Agent / Workflow 调用的端点，返回更稳定的机器可读结构。
- `LSA_PAYMENT_MODE=mock` 可以演示 `402 Payment Required → 携带支付凭证重试 → 返回带引用答案` 的完整流程。
- `LSA_PAYMENT_MODE=x402` 是真实 GOAT/x402 校验的预留边界，后续只需要替换 `assistant/payment.py` 中的 verifier 逻辑。
- 每次 `/api/agent/ask` 调用都会写入 `data/usage.jsonl`，便于展示可验证调用记录。

相关代码拆分：

- `app.py`：负责 HTTP 路由、调用 RAG、调用 payment verifier 和写入 usage log。
- `assistant/agent_tool.py`：负责 Agent 工具 schema、请求解析、错误响应和成功响应结构。
- `assistant/payment.py`：负责 `off` / `mock` / `x402` 支付校验边界；真实 GOAT/x402 接入时主要替换 `X402PaymentVerifier`。
- `assistant/usage_log.py`：负责过滤并写入 `/api/agent/ask` 调用记录，避免把支付 token 等敏感信息写入日志。

### 配置 mock 付费模式

在 `.env` 中设置：

```env
LSA_AGENT_TOOL_ENABLED=1
LSA_PAYMENT_MODE=mock
LSA_PAYMENT_MOCK_TOKEN=dev-paid
LSA_PAYMENT_PRICE=$0.001
LSA_PAYMENT_ASSET=USDC
LSA_PAYMENT_NETWORK=base-sepolia
LSA_PAYMENT_RECIPIENT=replace_with_wallet_or_payment_address
LSA_USAGE_LOG_PATH=data/usage.jsonl
```

启动服务：

```powershell
python app.py
```

### 查看 Agent 工具说明

```powershell
curl http://127.0.0.1:8008/api/agent/schema
```

返回内容包含工具名、输入 schema、支付模式、价格、网络和资源路径。

### 未支付调用

```powershell
curl -X POST http://127.0.0.1:8008/api/agent/ask `
  -H "Content-Type: application/json" `
  -d "{\"question\":\"这份文档主要讲什么？\",\"top_k\":5}"
```

预期返回 HTTP `402`，响应中包含 `payment.requirement`。

### mock 支付后调用

使用请求头：

```powershell
curl -X POST http://127.0.0.1:8008/api/agent/ask `
  -H "Content-Type: application/json" `
  -H "X-Mock-Payment: dev-paid" `
  -d "{\"question\":\"这份文档主要讲什么？\",\"top_k\":5}"
```

或者把 token 放在 JSON 里：

```json
{
  "question": "这份文档主要讲什么？",
  "top_k": 5,
  "payment": {
    "token": "dev-paid"
  }
}
```

成功响应示例结构：

```json
{
  "ok": true,
  "request_id": "req_xxx",
  "tool": {
    "name": "local_ai_study_assistant.ask",
    "version": "1.0",
    "paid": true
  },
  "payment": {
    "ok": true,
    "mode": "mock",
    "status": "paid",
    "payment_id": "mock_xxx"
  },
  "result": {
    "answer": "...",
    "sources": [],
    "mode": "llm"
  },
  "usage": {
    "question_chars": 11,
    "top_k": 5,
    "source_count": 3
  }
}
```

### x402 接入边界

设置 `LSA_PAYMENT_MODE=x402` 后，服务会检查 `X-PAYMENT` 或 `X-402-PAYMENT` 请求头。当前实现保留了一个 HTTP verifier 适配边界：

```env
LSA_PAYMENT_MODE=x402
LSA_X402_VERIFY_URL=https://your-x402-verifier.example.com/verify
LSA_X402_API_KEY=optional_api_key
```

真实 GOAT/x402 SDK 或 verifier API 确认后，只需要在 `assistant/payment.py` 的 `X402PaymentVerifier` 中替换校验逻辑，`/api/agent/ask` 和 RAG 流程不需要重写。

## 数据与隐私说明

- 上传的原始文档会保存到本地 `data/uploads/`。
- 知识库索引会保存到本地 `data/index.json`。
- 配置 `LSA_API_KEY` 后，提问内容和检索到的相关片段会发送到你配置的 `LSA_BASE_URL`。
- 如果文档包含隐私或敏感信息，请确认模型服务和网络环境可信。
- 不要把 `.env` 中的真实 API Key 提交到仓库。

## 测试与验证

当前项目未提供自动化测试脚本，可按下面步骤手动验证。建议先测试不依赖大模型的 mock 支付流程，再测试上传文档后的真实问答。

### 1. 配置 mock 支付模式

如果还没有 `.env`，先复制：

```powershell
Copy-Item .env.example .env
```

然后确认 `.env` 至少包含：

```env
LSA_HOST=127.0.0.1
LSA_PORT=8008

# 可以先留空，不配置大模型也能测试检索和支付流程。
LSA_API_KEY=
LSA_BASE_URL=https://api.openai.com/v1
LSA_MODEL=gpt-4o-mini

LSA_AGENT_TOOL_ENABLED=1
LSA_PAYMENT_MODE=mock
LSA_PAYMENT_MOCK_TOKEN=dev-paid
LSA_USAGE_LOG_PATH=data/usage.jsonl
```

### 2. 启动服务

```powershell
python app.py
```

正常会看到类似输出：

```text
AI 学习助手已启动: http://127.0.0.1:8008
Agent paid endpoint: /api/agent/ask · payment=mock
按 Ctrl+C 停止服务
```

保持这个窗口运行，另开一个 PowerShell 窗口执行下面的测试命令。

### 3. 验证 Agent 工具说明

```powershell
curl.exe http://127.0.0.1:8008/api/agent/schema
```

预期返回 HTTP `200`，JSON 中包含：

- `name: local_ai_study_assistant.ask`
- `endpoint: /api/agent/ask`
- `payment.mode: mock`
- `input_schema.required: ["question"]`

### 4. 验证原免费接口仍可用

```powershell
curl.exe -X POST http://127.0.0.1:8008/api/ask `
  -H "Content-Type: application/json" `
  -d "{\"question\":\"test\",\"top_k\":5}"
```

如果还没上传文档，预期返回：

```json
{
  "answer": "当前知识库中没有找到相关内容。你可以先上传课程资料、技术文档或学习笔记。",
  "sources": [],
  "mode": "no_context"
}
```

这说明旧的 `/api/ask` 和 Web 页面依赖的本地免费流程没有被破坏。

### 5. 验证未支付调用返回 402

```powershell
curl.exe -i -X POST http://127.0.0.1:8008/api/agent/ask `
  -H "Content-Type: application/json" `
  -d "{\"question\":\"test\",\"top_k\":5}"
```

预期返回 HTTP `402 Payment Required`，响应中包含：

```json
{
  "ok": false,
  "error": {
    "code": "payment_required"
  },
  "payment": {
    "mode": "mock",
    "status": "payment_required",
    "requirement": {
      "scheme": "x402",
      "resource": "/api/agent/ask"
    }
  }
}
```

### 6. 验证 mock 支付成功

使用请求头传 mock payment：

```powershell
curl.exe -i -X POST http://127.0.0.1:8008/api/agent/ask `
  -H "Content-Type: application/json" `
  -H "X-Mock-Payment: dev-paid" `
  -d "{\"question\":\"test\",\"top_k\":5}"
```

预期返回 HTTP `200`，响应中包含：

```json
{
  "ok": true,
  "payment": {
    "ok": true,
    "mode": "mock",
    "status": "paid",
    "payment_id": "mock_xxx"
  },
  "result": {
    "answer": "...",
    "sources": [],
    "mode": "no_context"
  }
}
```

也可以把 token 放进 JSON body：

```powershell
curl.exe -i -X POST http://127.0.0.1:8008/api/agent/ask `
  -H "Content-Type: application/json" `
  -d "{\"question\":\"test json payment\",\"payment\":{\"token\":\"dev-paid\"}}"
```

### 7. 检查 usage log

调用几次 `/api/agent/ask` 后查看：

```powershell
Get-Content .\data\usage.jsonl
```

预期能看到一行行 JSONL 记录，包括未支付的 `402` 和支付后的 `200`：

```json
{"request_id":"req_xxx","endpoint":"/api/agent/ask","payment":{"status":"payment_required"},"status":402}
{"request_id":"req_xxx","endpoint":"/api/agent/ask","payment":{"status":"paid","payment_id":"mock_xxx"},"status":200}
```

### 8. 上传文档后测试真实问答

打开浏览器：

```text
http://127.0.0.1:8008
```

上传一份 `txt`、`md` 或 `docx` 文档，然后再次调用付费 Agent 端点：

```powershell
curl.exe -X POST http://127.0.0.1:8008/api/agent/ask `
  -H "Content-Type: application/json" `
  -H "X-Mock-Payment: dev-paid" `
  -d "{\"question\":\"这份文档主要讲什么？\",\"top_k\":5}"
```

如果文档中能检索到相关内容，`result.sources` 会返回引用片段。未配置 `LSA_API_KEY` 时，`mode` 通常是 `retrieval_only`；配置大模型后，`mode` 通常是 `llm`。

### 9. 最小验收清单

确认以下 5 项都通过即可：

1. `GET /api/agent/schema` 返回 `200`。
2. `POST /api/ask` 返回 `200`，原免费接口可用。
3. `POST /api/agent/ask` 不带支付返回 `402`。
4. 带 `X-Mock-Payment: dev-paid` 或 JSON `payment.token` 返回 `200`。
5. `data/usage.jsonl` 记录了 `402` 和 `200` 两种调用。

## 常见问题

### 不配置 API Key 能用吗？

可以。系统不会调用大模型，但会返回最相关的文档片段，适合演示检索流程。

### PDF 上传失败怎么办？

PDF 解析依赖 `pypdf`，请安装：

```powershell
python -m pip install pypdf
```

或直接安装父项目依赖：

```powershell
python -m pip install -r ..\requirements.txt
```

### 中文检索效果一般怎么办？

当前实现偏轻量，适合演示。后续可替换为 Embedding + FAISS / Chroma，提升语义检索效果。

### 如何重建索引？

可以在页面触发重建，或调用 `/api/rebuild`。系统会根据 `data/uploads/` 中已有文件重新生成 `data/index.json`。

## 后续扩展

- 将当前检索替换为 Embedding + FAISS / Chroma。
- 增加用户登录和个人知识库隔离。
- 增加文档总结、知识点提纲、复习题生成等能力。
- 增加 Agent 路由，根据用户意图自动选择“检索问答 / 文档总结 / 习题生成”等工具。
- 增加更丰富的文件类型和批量导入能力。
