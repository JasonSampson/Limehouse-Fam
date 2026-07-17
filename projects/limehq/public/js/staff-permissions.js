// Staff permissions page: "Apply" a role template's default permission
// set to the checklist below. The list of templates (id/name/keys) is
// server-rendered into the <select>'s data-templates attribute as JSON
// (see staffRoutes.ts) since this script has no other way to receive it
// under a strict script-src 'self' CSP (no inline <script> allowed).
(function () {
  const applyBtn = document.getElementById("apply-template-btn");
  const sel = document.getElementById("role-template-select");
  if (!applyBtn || !sel) return;

  let templates = [];
  try {
    templates = JSON.parse(sel.dataset.templates || "[]");
  } catch {
    templates = [];
  }

  applyBtn.addEventListener("click", () => {
    const roleId = parseInt(sel.value, 10);
    if (!roleId) return;
    const tmpl = templates.find((t) => t.id === roleId);
    if (!tmpl) return;
    const keySet = new Set(tmpl.keys);
    document.querySelectorAll('input[type="checkbox"][data-key]').forEach((cb) => {
      cb.checked = keySet.has(cb.dataset.key);
    });
  });
})();
