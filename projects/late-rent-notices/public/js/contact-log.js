    (async function () {
      const me = await initLayout("contact-log");
      if (!me) return;

      const content = document.getElementById("app-content");
      const params = new URLSearchParams(window.location.search);
      const leaseIdParam = params.get("leaseId") ? Number(params.get("leaseId")) : null;

      const outcomeLabels = {
        reached_tenant: "Reached tenant",
        left_voicemail_no_answer: "Left voicemail / no answer",
        promised_to_pay: "Promised to pay",
        disputed_charge: "Disputed the charge",
      };

      const methodLabels = { phone: "Phone", email: "Email", text: "Text" };

      content.innerHTML = `
        <h1>Contact History</h1>
        <p class="subtitle">${leaseIdParam ? "Contact attempts logged for this lease." : "Every contact attempt logged, most recent first."}</p>
        ${leaseIdParam ? `<p><a href="/contact-log.html">Show all leases instead</a></p>` : ""}
        <div id="log-form-area"></div>
        <h2>History</h2>
        <div id="history-area" class="loading">Loading…</div>
      `;

      // Only admin_assistant can actually insert (enforced at the database
      // level) — a plain 'pm' or 'bookkeeping' session gets a 403 from
      // Postgres if it tries, so the form is only shown for admin_assistant.
      // This matches, not duplicates, the real enforcement point.
      if (me.role === "admin_assistant") {
        renderForm();
      } else if (me.role === "bookkeeping") {
        document.getElementById("log-form-area").innerHTML =
          `<div class="alert alert-info">Your account has read-only access — you can view contact history below, but not log new attempts.</div>`;
      } else {
        document.getElementById("log-form-area").innerHTML =
          `<div class="alert alert-info">Logging contact attempts is handled by the Admin Assistant team (Belinda / Vien). You can view history below.</div>`;
      }

      loadHistory();

      function renderForm() {
        const formArea = document.getElementById("log-form-area");
        formArea.innerHTML = `
          <div class="card">
            <h2 style="margin-top:0;">Log a contact attempt</h2>
            <form id="contact-form">
              <label for="leaseId">Lease ID</label>
              <input type="number" id="leaseId" name="leaseId" min="1" required value="${leaseIdParam ?? ""}" />
              <p class="field-hint">This is the internal lease ID. If you got here from a notice page, it's pre-filled.</p>

              <label for="contactMethod">How did you reach out?</label>
              <select id="contactMethod" name="contactMethod" required>
                <option value="">Choose one…</option>
                <option value="phone">Phone</option>
                <option value="email">Email</option>
                <option value="text">Text</option>
              </select>

              <label for="outcome">What happened?</label>
              <select id="outcome" name="outcome" required>
                <option value="">Choose one…</option>
                <option value="reached_tenant">Reached tenant</option>
                <option value="left_voicemail_no_answer">Left voicemail / no answer</option>
                <option value="promised_to_pay">Promised to pay</option>
                <option value="disputed_charge">Disputed the charge</option>
              </select>

              <div id="promised-pay-date-field" style="display:none;">
                <label for="promisedPayDate">Promised pay date</label>
                <input type="date" id="promisedPayDate" name="promisedPayDate" />
              </div>

              <label for="contactNote">Note (optional)</label>
              <textarea id="contactNote" name="contactNote" placeholder="Anything else worth recording about this contact"></textarea>

              <div id="form-result"></div>
              <button type="submit" class="btn-primary btn-block">Save contact attempt</button>
            </form>
          </div>
        `;

        const outcomeSelect = document.getElementById("outcome");
        const payDateField = document.getElementById("promised-pay-date-field");
        const payDateInput = document.getElementById("promisedPayDate");

        outcomeSelect.addEventListener("change", () => {
          const show = outcomeSelect.value === "promised_to_pay";
          payDateField.style.display = show ? "block" : "none";
          if (!show) payDateInput.value = "";
        });

        document.getElementById("contact-form").addEventListener("submit", async (e) => {
          e.preventDefault();
          const form = e.target;
          const resultBox = document.getElementById("form-result");
          const submitBtn = form.querySelector("button[type=submit]");

          const payload = {
            leaseId: Number(form.leaseId.value),
            contactMethod: form.contactMethod.value,
            outcome: form.outcome.value,
            contactNote: form.contactNote.value || undefined,
          };

          if (payload.outcome === "promised_to_pay") {
            if (!payDateInput.value) {
              resultBox.innerHTML = `<div class="alert alert-error">A promised pay date is required when the outcome is "Promised to pay."</div>`;
              return;
            }
            payload.promisedPayDate = payDateInput.value;
          }

          submitBtn.disabled = true;
          submitBtn.textContent = "Saving…";
          resultBox.innerHTML = "";

          try {
            await LimehouseAPI.post("/api/contact-attempts", payload);
            resultBox.innerHTML = `<div class="alert alert-success">Saved.</div>`;
            form.reset();
            payDateField.style.display = "none";
            loadHistory();
          } catch (err) {
            resultBox.innerHTML = `<div class="alert alert-error">${escapeHtml(friendlyError(err))}</div>`;
          } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = "Save contact attempt";
          }
        });
      }

      async function loadHistory() {
        const historyArea = document.getElementById("history-area");
        historyArea.innerHTML = `<div class="loading">Loading…</div>`;
        try {
          const path = leaseIdParam ? `/api/contact-attempts?leaseId=${leaseIdParam}` : "/api/contact-attempts";
          const { contactAttempts } = await LimehouseAPI.get(path);

          if (!contactAttempts.length) {
            historyArea.innerHTML = `<div class="empty-state">No contact attempts logged yet.</div>`;
            return;
          }

          historyArea.innerHTML = `<div class="notice-list">${contactAttempts
            .map(
              (c) => `
              <div class="notice-row status-${c.outcome === "promised_to_pay" ? "draft" : "sent"}">
                <div class="row-top">
                  <span class="tenant-name">Lease #${c.lease_id} &middot; ${methodLabels[c.contact_method] || c.contact_method}</span>
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
            .join("")}</div>`;
        } catch (err) {
          historyArea.innerHTML = `<div class="alert alert-error">${escapeHtml(friendlyError(err))}</div>`;
        }
      }
    })();
