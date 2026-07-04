const chatLog = document.getElementById("chat-log");
const form = document.getElementById("ask-form");
const askButton = document.getElementById("ask-button");
const questionInput = document.getElementById("question");

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

async function init() {
  const meRes = await fetch("/api/auth/me");
  if (!meRes.ok) {
    window.location.href = "/login.html";
    return;
  }
  const me = await meRes.json();
  document.getElementById("user-name").textContent = me.user.name;

  const statusRes = await fetch("/api/chat/status");
  const status = await statusRes.json();
  if (!status.connected) {
    document.getElementById("not-connected").style.display = "block";
  }
}

document.getElementById("logout-link").addEventListener("click", async (e) => {
  e.preventDefault();
  await fetch("/api/auth/logout", { method: "POST" });
  window.location.href = "/login.html";
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = questionInput.value.trim();
  if (!question) return;

  appendMessage("user", question);
  questionInput.value = "";
  askButton.disabled = true;

  try {
    const res = await fetch("/api/chat/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    const body = await res.json();
    if (!res.ok) {
      appendMessage("bot", body.error || "Something went wrong.");
    } else {
      appendMessage("bot", body.answer, body.citations);
    }
  } catch {
    appendMessage("bot", "Something went wrong reaching the server.");
  } finally {
    askButton.disabled = false;
  }
});

init();
