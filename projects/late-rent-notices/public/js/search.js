    (async function () {
      const me = await initLayout("search");
      if (!me) return;

      const content = document.getElementById("app-content");
      const params = new URLSearchParams(window.location.search);
      const q = params.get("q") || "";

      const noticeStatusLabels = {
        draft: "Draft — not sent",
        sent: "Sent",
        voided: "Voided (never sent)",
        bounced: "Sent — bounced",
      };
      const outcomeLabels = {
        reached_tenant: "Reached tenant",
        left_voicemail_no_answer: "Left voicemail / no answer",
        promised_to_pay: "Promised to pay",
        disputed_charge: "Disputed the charge",
      };
      const methodLabels = { phone: "Phone", email: "Email", text: "Text" };

      content.innerHTML = `
        <h1>Search past notices &amp; history</h1>
        <p class="subtitle">Look up everything on file for a property, by address.</p>
        <div class="card">
          <form id="search-form">
            <label for="search-input">Address</label>
            <input type="search" id="search-input" placeholder="e.g. 9109 Poppy Ct" value="${escapeHtml(q)}" />
            <button type="submit" class="btn-primary" style="margin-top:10px;">Search</button>
          </form>
        </div>
        <div id="results-area"></div>
      `;

      document.getElementById("search-form").addEventListener("submit", (e) => {
        e.preventDefault();
        const newQ = document.getElementById("search-input").value.trim();
        window.location.href = `/search.html?q=${encodeURIComponent(newQ)}`;
      });

      if (q) {
        runSearch(q);
      }

      async function runSearch(query) {
        const area = document.getElementById("results-area");
        area.innerHTML = `<div class="loading">Searching…</div>`;
        try {
          const { notices, contactAttempts } = await LimehouseAPI.get(`/api/search?q=${encodeURIComponent(query)}`);

          if (!notices.length && !contactAttempts.length) {
            area.innerHTML = `<div class="empty-state">No notices or contact history found for "${escapeHtml(query)}".</div>`;
            return;
          }

          area.innerHTML = `
            <h2>Notices (${notices.length})</h2>
            ${
              notices.length
                ? `<div class="notice-list">${notices
                    .map(
                      (n) => `
                      <a href="/notice.html?id=${n.id}" class="notice-row status-${n.status}" style="display:block; text-decoration:none; color:inherit;">
                        <div class="row-top">
                          <span class="tenant-name">${escapeHtml(n.property_name)} — Unit ${escapeHtml(n.unit_label)}</span>
                          <span>${fmtMoney(n.amount_due_at_send ?? n.amount_due_at_draft)}</span>
                        </div>
                        <div class="row-meta">
                          ${noticeStatusLabels[n.status] || n.status} &middot; Drafted ${fmtDate(n.drafted_at)}
                          ${n.sent_at ? ` &middot; Sent ${fmtDate(n.sent_at)}` : ""}
                        </div>
                      </a>
                    `
                    )
                    .join("")}</div>`
                : `<div class="empty-state">No matching notices.</div>`
            }

            <h2>Contact history (${contactAttempts.length})</h2>
            ${
              contactAttempts.length
                ? `<div class="notice-list">${contactAttempts
                    .map(
                      (c) => `
                      <div class="notice-row status-${c.outcome === "promised_to_pay" ? "draft" : "sent"}">
                        <div class="row-top">
                          <span class="tenant-name">${escapeHtml(c.property_name)} — Unit ${escapeHtml(c.unit_label)} &middot; ${methodLabels[c.contact_method] || c.contact_method}</span>
                          <span>${fmtDate(c.occurred_at)}</span>
                        </div>
                        <div class="row-meta">
                          ${outcomeLabels[c.outcome] || c.outcome}
                          ${c.promised_pay_date ? ` &middot; Promised to pay by ${fmtDate(c.promised_pay_date)}` : ""}
                        </div>
                        ${c.contact_note ? `<div class="row-meta" style="margin-top:6px;">${escapeHtml(c.contact_note)}</div>` : ""}
                      </div>
                    `
                    )
                    .join("")}</div>`
                : `<div class="empty-state">No matching contact history.</div>`
            }
          `;
        } catch (err) {
          area.innerHTML = `<div class="alert alert-error">${escapeHtml(friendlyError(err))}</div>`;
        }
      }
    })();
