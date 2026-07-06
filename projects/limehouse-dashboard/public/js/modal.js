// Generic drill-down modal: reused by any clickable tile. Columns are
// passed in by the caller since different tiles show different shapes
// (property/unit/balance for delinquency, property/unit/rent for occupied
// units, etc. — per the project brief).

function openDrillDownModal({ title, formula, columns, rows, emptyText = "No records for this period." }) {
  closeDrillDownModal();

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "drill-down-overlay";

  const formulaHtml = formula ? `<p class="modal-formula"><strong>Formula:</strong> ${formula}</p>` : "";

  const bodyHtml =
    rows.length === 0
      ? `${formulaHtml}<p class="loading-text">${emptyText}</p>`
      : `
        ${formulaHtml}
        <table class="drill-table">
          <thead>
            <tr>${columns.map((c) => `<th>${c.label}</th>`).join("")}</tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (row) =>
                  `<tr>${columns.map((c) => `<td>${c.render ? c.render(row) : row[c.key] ?? "—"}</td>`).join("")}</tr>`
              )
              .join("")}
          </tbody>
        </table>
      `;

  overlay.innerHTML = `
    <div class="modal-panel">
      <div class="modal-header">
        <span class="modal-title">${title}</span>
        <button class="modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="modal-body">${bodyHtml}</div>
    </div>
  `;

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeDrillDownModal();
  });
  overlay.querySelector(".modal-close").addEventListener("click", closeDrillDownModal);

  document.body.appendChild(overlay);
}

function closeDrillDownModal() {
  const existing = document.getElementById("drill-down-overlay");
  if (existing) existing.remove();
}

function openLoadingModal(title) {
  closeDrillDownModal();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "drill-down-overlay";
  overlay.innerHTML = `
    <div class="modal-panel">
      <div class="modal-header">
        <span class="modal-title">${title}</span>
        <button class="modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="modal-body"><p class="loading-text">Loading…</p></div>
    </div>
  `;
  overlay.querySelector(".modal-close").addEventListener("click", closeDrillDownModal);
  document.body.appendChild(overlay);
}
