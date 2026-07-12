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
│   └── llm_client.py      # OpenAI-compatible API 调用
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
| `POST` | `/api/rebuild` | 根据 `data/uploads/` 重建索引 |

## 数据与隐私说明

- 上传的原始文档会保存到本地 `data/uploads/`。
- 知识库索引会保存到本地 `data/index.json`。
- 配置 `LSA_API_KEY` 后，提问内容和检索到的相关片段会发送到你配置的 `LSA_BASE_URL`。
- 如果文档包含隐私或敏感信息，请确认模型服务和网络环境可信。
- 不要把 `.env` 中的真实 API Key 提交到仓库。

## 测试与验证

当前项目未提供自动化测试脚本，可手动验证：

1. 启动 `python app.py`。
2. 打开 `http://127.0.0.1:8008`。
3. 上传一份 `txt` 或 `md` 文档。
4. 在知识库列表中确认文档出现。
5. 提问与文档相关的问题，检查回答和引用片段。
6. 清空或不配置 `LSA_API_KEY`，确认系统仍能返回检索片段。

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
