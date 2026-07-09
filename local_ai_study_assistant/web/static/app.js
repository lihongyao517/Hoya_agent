const fileInput = document.querySelector("#file-input");
const docList = document.querySelector("#doc-list");
const docCount = document.querySelector("#doc-count");
const askForm = document.querySelector("#ask-form");
const questionInput = document.querySelector("#question-input");
const messages = document.querySelector("#messages");
const rebuildBtn = document.querySelector("#rebuild-btn");
const suggestionButtons = document.querySelectorAll("[data-question]");

function addMessage(role, text, sources = []) {
  const article = document.createElement("article");
  article.className = `message ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "user" ? "你" : "A";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const body = document.createElement("p");
  body.textContent = text;
  bubble.appendChild(body);

  if (sources.length) {
    const sourceWrap = document.createElement("div");
    sourceWrap.className = "sources";
    const sourceHead = document.createElement("div");
    sourceHead.className = "sources-head";
    sourceHead.textContent = "引用来源";
    sourceWrap.appendChild(sourceHead);
    sources.forEach((source) => {
      const item = document.createElement("div");
      item.className = "source";
      const title = document.createElement("div");
      title.className = "source-title";
      title.textContent = `${source.filename} #${source.chunk_index}`;
      const meta = document.createElement("div");
      meta.className = "source-meta";
      meta.textContent = `相关度：${source.score}`;
      const excerpt = document.createElement("div");
      excerpt.className = "source-text";
      excerpt.textContent = source.text.length > 220 ? `${source.text.slice(0, 220)}...` : source.text;
      item.append(title, meta, excerpt);
      sourceWrap.appendChild(item);
    });
    bubble.appendChild(sourceWrap);
  }

  if (role === "assistant") {
    article.appendChild(avatar);
  }
  article.appendChild(bubble);
  if (role === "user") {
    article.appendChild(avatar);
  }
  messages.appendChild(article);
  messages.scrollTop = messages.scrollHeight;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "请求失败");
  }
  return data;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function loadDocuments() {
  const data = await api("/api/documents");
  docCount.textContent = data.documents.length;
  docList.innerHTML = "";
  if (!data.documents.length) {
    const empty = document.createElement("div");
    empty.className = "empty-docs";
    empty.innerHTML = "<strong>暂无文档</strong><span>上传资料后会显示在这里</span>";
    docList.appendChild(empty);
    return;
  }
  data.documents.forEach((doc) => {
    const item = document.createElement("div");
    item.className = "doc-item";
    const name = document.createElement("div");
    name.className = "doc-name";
    name.textContent = doc.filename;
    const meta = document.createElement("div");
    meta.className = "doc-meta";
    meta.textContent = `${doc.chunk_count} 个片段 · ${doc.created_at}`;
    const badge = document.createElement("div");
    badge.className = "doc-badge";
    badge.textContent = "已索引";
    item.append(name, meta, badge);
    docList.appendChild(item);
  });
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  addMessage("assistant", `正在解析并入库：${file.name}`);
  try {
    const contentBase64 = await fileToBase64(file);
    const data = await api("/api/documents", {
      method: "POST",
      body: JSON.stringify({ filename: file.name, content_base64: contentBase64 }),
    });
    addMessage("assistant", `${data.document.filename} 已入库，共 ${data.document.chunk_count} 个片段。`);
    await loadDocuments();
  } catch (error) {
    addMessage("assistant", `上传失败：${error.message}`);
  } finally {
    fileInput.value = "";
  }
});

askForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = questionInput.value.trim();
  if (!question) return;
  questionInput.value = "";
  addMessage("user", question);
  addMessage("assistant", "正在检索本地知识库并生成回答...");

  try {
    const data = await api("/api/ask", {
      method: "POST",
      body: JSON.stringify({ question, top_k: 5 }),
    });
    messages.lastElementChild?.remove();
    addMessage("assistant", data.answer, data.sources || []);
  } catch (error) {
    messages.lastElementChild?.remove();
    addMessage("assistant", `回答失败：${error.message}`);
  }
});

rebuildBtn.addEventListener("click", async () => {
  addMessage("assistant", "正在从 uploads 目录重建知识库...");
  try {
    const data = await api("/api/rebuild", { method: "POST", body: "{}" });
    addMessage("assistant", data.message);
    await loadDocuments();
  } catch (error) {
    addMessage("assistant", `重建失败：${error.message}`);
  }
});

suggestionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    questionInput.value = button.dataset.question || "";
    questionInput.focus();
  });
});

loadDocuments().catch((error) => addMessage("assistant", `加载知识库失败：${error.message}`));
