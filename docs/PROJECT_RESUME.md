# 项目简历：Hoya Agent — 本地 AI 任务助手

## 项目概述

Hoya Agent 是一个面向本地工作区的 AI Agent MVP（最小可行产品），旨在高效率、高精确度地完成用户赋予的本地工作区任务。项目同时包含一个独立的 **RAG 学习助手** 子模块，支持基于本地文档的知识库问答。项目已开源至 Gitee：https://gitee.com/li-hoya/Hoya_agent

## 核心功能

### 1. 多模态交互入口
- **CLI 命令行模式**：简洁的对话式交互，适合快速任务
- **Textual TUI 模式**：Rich 终端 UI，支持事件流、工具调用状态、待审批写入管理、快捷键操作
- **QQ 私聊桥接模式**：通过 OneBot 协议对接 QQ Bot，支持白名单用户通过 QQ 私聊发送任务

### 2. 丰富的工具链
- **文件操作**：查看、读取、写入工作区文件
- **多格式文档解析**：支持 `.txt`、`.md`、`.docx`、`.xlsx`、`.pdf`
- **全文搜索与索引**：轻量级文件索引建立与检索
- **长期记忆**：记录和读取持久化记忆
- **会话历史**：记录历史对话和工具调用步骤，支持跨轮上下文引用
- **PowerShell 命令执行**：可选开启，支持人工审批机制
- **桌面文件创建**：可选在桌面创建 `.txt` 文件

### 3. 安全机制
- 工作区路径保护，防止写到项目目录外
- Shell 命令默认关闭，支持人工审批
- 写文件前可进入待审批 diff 队列（TUI 中 `/pending` + `/apply` 管理）
- 最小权限原则设计

### 4. 配置灵活
- 11 个环境变量全覆盖控制：模型选择、API 地址、权限开关、上下文长度、温度等
- 支持 OpenAI Chat Completions 和 Responses API 两种接口协议
- 可自由切换兼容的模型中转站

## 子项目：本地文档 AI 学习助手 (RAG)

### 功能
- 上传并解析 `.txt`、`.md`、`.docx`、`.pdf` 文档
- 基于 TF-IDF + 余弦相似度的本地知识库检索
- OpenAI-compatible 大模型生成带引用来源的回答
- 无 API Key 时也可返回最相关文档片段（适合课堂演示 RAG 流程）
- 简单 Web 页面：上传、搜索、问答、引用展示

### 技术实现
- 文档解析与切片 → 本地知识库索引 → 检索 → LLM 生成回答
- 索引持久化到本地 JSON 文件

## 技术栈

| 分类 | 技术 |
|------|------|
| 语言 | Python 3.10+ |
| TUI 终端界面 | Textual |
| 文档解析 | pypdf + 内置 docx/xlsx/pdf 解析 |
| 大模型接口 | OpenAI-compatible Chat Completions / Responses API |
| QQ 桥接 | OneBot 协议（兼容 NapCatQQ、Lagrange.OneBot） |
| 数据存储 | 本地 JSON / JSONL 文件 |
| 运行环境 | Windows PowerShell |
| RAG 检索 | TF-IDF + 余弦相似度 |
| RAG Web 界面 | Python http.server + 原生 HTML/CSS/JS |

## 项目结构

```
Hoya_agent/
├── hoya_agent/                  # 主项目源码
│   ├── __main__.py              # CLI / TUI / QQ 入口选择
│   ├── terminal/                # 终端交互层
│   │   ├── cli.py               # 命令行交互入口
│   │   └── tui.py               # Textual 终端 UI
│   ├── agent.py                 # Agent 主循环（工具 + LLM 调度）
│   ├── llm.py                   # OpenAI-compatible 模型客户端
│   ├── tools.py                 # 工具函数集（文件、搜索、索引、记忆等）
│   ├── config.py                # 环境变量配置读取
│   ├── memory.py                # 长期记忆模块
│   ├── workspace_ops.py         # 工作区操作（diff、审批写入等）
│   ├── server.py                # 桌面客户端调用的本地 HTTP 后端
│   └── qq_bridge.py             # QQ 私聊桥接（OneBot 协议）
├── desktop/                     # Electron + Vue 3 + Element Plus 桌面客户端
├── local_ai_study_assistant/    # 独立 RAG 学习助手
│   ├── app.py                   # HTTP 服务入口
│   └── assistant/               # 文档解析、知识库、检索、LLM 等模块
├── .env.example                 # 环境变量模板
├── requirements.txt             # Python 依赖
└── README.md                    # 完整文档
```

## 核心设计亮点

1. **多入口共享核心**：CLI、TUI、Electron 桌面客户端和 QQ 桥接复用同一套 Agent、工具与工作区安全逻辑。
2. **安全优先**：工作区路径白名单、Shell 审批、写入审批三级防护机制，确保 Agent 不会越界操作。
3. **轻量无依赖**：核心 Agent 仅依赖 `textual` 和 `pypdf`，RAG 子模块使用 Python 标准库的 `http.server`，不依赖外部数据库或框架。
4. **跨轮上下文**：持久化的 JSONL 历史记录 + 可配置的上下文注入策略，支持自然的多轮对话引用。
5. **QQ 移动端扩展**：通过 OneBot 协议对接 QQ Bot，实现手机端远程任务分发。

## 适用场景

- 本地项目代码阅读与总结
- 工作区文件搜索与信息提取
- 文档问答与知识库构建（RAG 子模块）
- 快速原型开发辅助
- 教学演示：AI Agent 工具调用、RAG 检索流程

## 个人收获

- 深入实践了 LLM Agent 的工具调用模式（function calling）与循环调度
- 实现了 Textual TUI 框架的终端交互界面开发
- 设计了完整的 RAG 检索流程：文档解析 → 切片 → TF-IDF 索引 → 余弦相似度检索 → LLM 生成
- 通过 OneBot 协议打通了 QQ 即时通讯与 AI Agent 的桥接
- 构建了一套实用的安全防护机制（路径白名单、审批队列、权限开关）
