// Shared top-nav "user menu" dropdown (name + caret button, sign out).
// Used on every server-rendered page that has the nav bar: launcher,
// change password, staff management, roles. Kept as one external file so
// the four pages don't each carry their own copy of the same logic.
(function () {
  const btn = document.getElementById("user-menu-btn");
  const dd = document.getElementById("user-menu-dropdown");
  if (!btn || !dd) return;

  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    dd.classList.toggle("open");
    btn.setAttribute("aria-expanded", String(dd.classList.contains("open")));
  });

  document.addEventListener("click", function () {
    dd.classList.remove("open");
    btn.setAttribute("aria-expanded", "false");
  });

  const signOutBtn = document.getElementById("signout-btn");
  if (signOutBtn) {
    signOutBtn.addEventListener("click", async function () {
      await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
      window.location.href = "/";
    });
  }
})();
