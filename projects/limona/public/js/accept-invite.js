const params = new URLSearchParams(window.location.search);
const token = params.get("token");
const emailEl = document.getElementById("invite-email");
const errorEl = document.getElementById("error");
const form = document.getElementById("accept-form");

async function init() {
  if (!token) {
    emailEl.textContent = "";
    errorEl.textContent = "No invite token was provided in the link.";
    errorEl.style.display = "block";
    return;
  }

  const res = await fetch(`/api/auth/invite/${encodeURIComponent(token)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    emailEl.textContent = "";
    errorEl.textContent = body.error || "This invite link is invalid or has already been used.";
    errorEl.style.display = "block";
    return;
  }
  const body = await res.json();
  emailEl.textContent = `Setting up access for ${body.email}`;
  form.style.display = "block";
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorEl.style.display = "none";

  const name = document.getElementById("name").value;
  const password = document.getElementById("password").value;

  const res = await fetch("/api/auth/redeem-invite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, name, password }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    errorEl.textContent = body.error || "Something went wrong.";
    errorEl.style.display = "block";
    return;
  }

  window.location.href = "/login.html";
});

init();
