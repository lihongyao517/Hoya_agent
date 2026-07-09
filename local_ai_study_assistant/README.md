# 基于本地文档的 AI 学习助手

这是一个面向学习资料问答的 RAG 小项目。用户上传本地文档后，系统会解析文档、切分文本片段、构建本地知识库；用户提问时，系统先自动检索相关片段，再结合大模型生成回答，并展示引用来源。

## 功能

- 上传并解析 `txt`、`md`、`docx` 文档
- 可选支持 `pdf`：需要额外安装 `pypdf`
- 本地知识库持久化到 `data/index.json`
- 基于 TF-IDF 和余弦相似度自动检索相关片段
- 调用 OpenAI-compatible Chat Completions 生成回答
- 未配置 API Key 时，也能返回最相关文档片段，方便演示检索流程
- 简单 Web 页面：文档上传、知识库列表、问答、引用展示

## 项目结构

```text
local_ai_study_assistant/
  app.py                 # HTTP 服务入口
  assistant/
    config.py            # 环境变量配置
    documents.py         # 文档解析与切片
    knowledge_base.py    # 本地知识库索引
    retriever.py         # 关键词/中文字符检索
    rag.py               # RAG Prompt 与回答生成
    llm_client.py        # OpenAI-compatible API 调用
  web/
    index.html
    static/
      app.js
      styles.css
  data/
    uploads/             # 上传的原始文档
    index.json           # 自动生成的知识库索引
```

## 快速开始

进入项目目录：

```powershell
cd D:\projects\Hoya_agent\local_ai_study_assistant
```

复制配置文件：

```powershell
Copy-Item .env.example .env
```

编辑 `.env`，填入你的 OpenAI-compatible 接口：

```env
LSA_API_KEY=你的API_KEY
LSA_BASE_URL=https://你的中转站地址/v1
LSA_MODEL=你的模型名
```

启动服务：

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
解析正文
  ↓
切分为多个文本片段
  ↓
写入本地知识库索引
  ↓
用户提问
  ↓
问题关键词化
  ↓
检索 Top-K 相关片段
  ↓
问题 + 片段组成 Prompt
  ↓
调用大模型生成回答
  ↓
展示答案和引用来源
```

## 后续扩展

- 将当前 TF-IDF 检索替换为 Embedding + FAISS / Chroma
- 增加用户登录和个人知识库隔离
- 增加文档总结、知识点提纲、复习题生成等工具调用
- 增加 Agent 路由：根据用户意图自动选择“检索问答 / 文档总结 / 习题生成”等工具
