// Generic drill-down modal: reused by any clickable tile. Columns are
// passed in by the caller since different tiles show different shapes
// (property/unit/balance for delinquency, property/unit/rent for occupied
// units, etc. — per the project brief).

// FIXED 2026-07-30, per Sentinel's security review: cell values used to go
// straight into an innerHTML string with no escaping. Most columns are
// numbers/dates this app computed itself, but several show real free-text
// fields from Buildium/RentEngine (tenant names, prospect names) — data
// entered by someone outside Limehouse staff. Every cell is now escaped by
// default (escapeHtml, shared.js). The one existing column that
// intentionally renders real markup for styling (Team Performance's
// reconciliation "Not Reconciled" badge) opts out via `html: true` on its
// column definition — see that column's own comment.
function openDrillDownModal({ title, subtitle, formula, note, columns, rows, emptyText = "No records for this period." }) {
  closeDrillDownModal();

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "drill-down-overlay";

  const formulaHtml = formula ? `<p class="modal-formula"><strong>Formula:</strong> ${formula}</p>` : "";
  // "Note" box — same idea as the vendor site's own explainer box on tiles
  // whose data isn't a straightforward live number, so Jason can see how a
  // figure was put together without having to ask.
  const noteHtml = note
    ? `<div class="modal-note"><p class="modal-note-label">Note</p><p class="modal-note-text">${note}</p></div>`
    : "";

  function cellHtml(column, row) {
    const value = column.render ? column.render(row) : row[column.key] ?? "—";
    return column.html ? value : escapeHtml(value);
  }

  const bodyHtml =
    rows.length === 0
      ? `${noteHtml}${formulaHtml}<p class="loading-text">${escapeHtml(emptyText)}</p>`
      : `
        ${noteHtml}
        ${formulaHtml}
        <table class="drill-table">
          <thead>
            <tr>${columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("")}</tr>
          </thead>
          <tbody>
            ${rows
              .map((row) => `<tr>${columns.map((c) => `<td>${cellHtml(c, row)}</td>`).join("")}</tr>`)
              .join("")}
          </tbody>
        </table>
      `;

  const subtitleHtml = subtitle ? `<span class="modal-subtitle">${subtitle}</span>` : "";

  overlay.innerHTML = `
    <div class="modal-panel">
      <div class="modal-header">
        <div class="modal-heading">
          <span class="modal-title">${title}</span>
          ${subtitleHtml}
        </div>
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
