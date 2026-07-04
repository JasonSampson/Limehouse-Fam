document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("error");
  errorEl.style.display = "none";

  const email = document.getElementById("email").value;
  const password = document.getElementById("password").value;

  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    errorEl.textContent = body.error || "Login failed.";
    errorEl.style.display = "block";
    return;
  }

  const me = await fetch("/api/auth/me").then((r) => r.json());
  window.location.href = me.user.role === "admin" ? "/dashboard.html" : "/chat.html";
});
