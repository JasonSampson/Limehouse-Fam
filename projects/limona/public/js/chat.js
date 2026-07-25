const chatLog = document.getElementById("chat-log");
const form = document.getElementById("ask-form");
const askButton = document.getElementById("ask-button");
const questionInput = document.getElementById("question");
const chatWelcome = document.getElementById("chat-welcome");
const historyBtn = document.getElementById("history-btn");
const historyPanel = document.getElementById("history-panel");
const historyList = document.getElementById("history-list");
const newChatBtn = document.getElementById("new-chat-btn");

// Tracks which conversation new questions get appended to. Null means "no
// conversation started yet" — the next question creates a brand new one
// (see /api/chat/ask, which creates a conversation server-side whenever no
// conversationId is sent).
let currentConversationId = null;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function showWelcome(show) {
  chatWelcome.style.display = show ? "block" : "none";
  chatLog.style.display = show ? "none" : "flex";
}

function appendMessage(role, text, citations) {
  const el = document.createElement("div");
  el.className = `chat-msg ${role}`;
  if (role === "bot") {
    const avatar = document.createElement("img");
    avatar.src = "/images/limona-avatar.png";
    avatar.alt = "";
    avatar.className = "chat-msg-avatar";
    el.appendChild(avatar);
  }
  const content = document.createElement("div");
  content.className = "chat-msg-content";
  content.textContent = text;
  if (citations && citations.length > 0) {
    const cite = document.createElement("div");
    cite.className = "citations";
    cite.textContent =
      "Source: " +
      citations
        .map((c) => (c.pageOrSectionLabel ? `${c.documentFilename} (${c.pageOrSectionLabel})` : c.documentFilename))
        .join(", ");
    content.appendChild(cite);
  }
  el.appendChild(content);
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function askQuestion(question) {
  appendMessage("user", question);
  askButton.disabled = true;

  try {
    const res = await fetch("/api/chat/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, conversationId: currentConversationId }),
    });
    const body = await res.json();
    if (!res.ok) {
      appendMessage("bot", body.error || "Something went wrong.");
    } else {
      currentConversationId = body.conversationId;
      appendMessage("bot", body.answer, body.citations);
    }
  } catch {
    appendMessage("bot", "Something went wrong reaching the server.");
  } finally {
    askButton.disabled = false;
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = questionInput.value.trim();
  if (!question) return;

  showWelcome(false);
  historyPanel.style.display = "none";
  questionInput.value = "";
  await askQuestion(question);
});

document.querySelectorAll(".starter-question").forEach((btn) => {
  btn.addEventListener("click", async () => {
    showWelcome(false);
    await askQuestion(btn.textContent);
  });
});

newChatBtn.addEventListener("click", () => {
  currentConversationId = null;
  chatLog.innerHTML = "";
  historyPanel.style.display = "none";
  showWelcome(true);
});

historyBtn.addEventListener("click", async () => {
  const isOpen = historyPanel.style.display !== "none";
  if (isOpen) {
    historyPanel.style.display = "none";
    return;
  }
  historyPanel.style.display = "block";
  historyList.innerHTML = `<div class="history-empty">Loading…</div>`;

  const res = await fetch("/api/chat/conversations");
  if (!res.ok) {
    historyList.innerHTML = `<div class="history-empty">Failed to load history.</div>`;
    return;
  }
  const body = await res.json();
  if (body.conversations.length === 0) {
    historyList.innerHTML = `<div class="history-empty">No past conversations yet.</div>`;
    return;
  }
  historyList.innerHTML = body.conversations
    .map(
      (c) => `
      <div class="history-item" data-id="${c.id}">
        <span class="history-item-title">${escapeHtml(c.title)}</span>
        <span class="history-item-when">${new Date(c.updated_at).toLocaleDateString()}</span>
      </div>
    `
    )
    .join("");

  historyList.querySelectorAll(".history-item").forEach((item) => {
    item.addEventListener("click", () => openConversation(item.dataset.id));
  });
});

async function openConversation(id) {
  const res = await fetch(`/api/chat/conversations/${id}`);
  if (!res.ok) return;
  const body = await res.json();

  currentConversationId = id;
  chatLog.innerHTML = "";
  showWelcome(false);
  historyPanel.style.display = "none";

  body.messages.forEach((m) => {
    appendMessage("user", m.question);
    appendMessage("bot", m.answer, m.citations);
  });
}

async function init() {
  const meRes = await fetch("/api/auth/me");
  if (!meRes.ok) {
    window.location.href = "/auth/login";
    return;
  }
  const me = await meRes.json();
  renderSidebar({ activePage: "/chat.html", user: me.user });

  const statusRes = await fetch("/api/chat/status");
  const status = await statusRes.json();
  if (!status.connected) {
    document.getElementById("not-connected").style.display = "block";
  }

  showWelcome(true);
}

init();
