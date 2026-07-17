    (async function () {
      const me = await initLayout("dashboard");
      if (!me) return;

      const content = document.getElementById("app-content");
      const params = new URLSearchParams(window.location.search);
      const noticeId = Number(params.get("id"));

      if (!noticeId) {
        content.innerHTML = `<div class="alert alert-error">No notice specified.</div>`;
        return;
      }

      content.innerHTML = `<div class="loading">Loading notice…</div>`;

      const canReviewAndSend = me.role === "pm";
      const canFallbackSend = me.isFallbackDecisionMaker;
      const readOnly = me.role === "bookkeeping";

      const bucketLabels = {
        rent: "Rent",
        late_fee: "Late fee",
        other: "Other charge",
      };

      try {
        const { notice } = await LimehouseAPI.get(`/api/notices/${noticeId}`);
        renderNotice(notice);
      } catch (err) {
        content.innerHTML = `<div class="alert alert-error">${escapeHtml(friendlyError(err))}</div>`;
      }

      function statusBadge(n) {
        if (n.status === "draft") return `<span class="badge badge-draft">Draft — not sent</span>`;
        if (n.status === "voided") return `<span class="badge badge-voided">Voided</span>`;
        if (n.status === "sent" && n.deliveryStatus === "bounced") return `<span class="badge badge-bounced">Sent — bounced</span>`;
        if (n.status === "sent") return `<span class="badge badge-sent">Sent</span>`;
        return `<span class="badge badge-voided">${n.status}</span>`;
      }

      function renderLedgerRows(notice) {
        const items = notice.lineItems && notice.lineItems.items ? notice.lineItems.items : [];
        if (!items.length) {
          return `
            <div class="alert alert-info" style="margin-top:10px;">
              No itemized breakdown yet for this notice — just the total amount due below. Line-item detail
              (rent vs. late fees vs. other charges) is being built and will show up here automatically once it's
              populated for this notice. The actual live balance is re-checked automatically the moment someone
              clicks Send, before anything happens, regardless of whether the breakdown is itemized yet.
            </div>
          `;
        }
        const rows = items
          .map(
            (li) => `
              <tr>
                <td>${escapeHtml(bucketLabels[li.bucket] || li.bucket)}</td>
                <td>${escapeHtml(li.description || li.glAccountName || "—")}</td>
                <td>${li.chargeDate ? fmtDate(li.chargeDate) : "—"}</td>
                <td>${fmtMoney(li.amount)}</td>
              </tr>
            `
          )
          .join("");
        return `
          <table class="ledger-table">
            <thead>
              <tr><th>Type</th><th>Description</th><th>Charge date</th><th>Amount</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <p class="field-hint">${
            notice.lineItems.snapshotStage === "live"
              ? "Live — re-checked against Buildium just now, not the original draft figure."
              : `Itemized as of the ${notice.lineItems.snapshotStage === "send" ? "send" : "draft"} snapshot.`
          }</p>
        `;
      }

      // One combined email/PDF goes to every "to" recipient on the lease
      // (roommates/co-signers all named together, e.g. "Jane Doe and John
      // Doe") — not a separate preview per tenant.
      function renderLetterPreview(notice) {
        if (!notice.toRecipients || !notice.toRecipients.length) {
          return `<div class="alert alert-warn">No recipients found for this notice — there's nothing to preview.</div>`;
        }
        const toLine = notice.toRecipients.map((r) => `${escapeHtml(r.tenantName)} &lt;${escapeHtml(r.emailAddress)}&gt;`).join("; ");
        const pdfUrl = `/api/notices/${notice.id}/pdf`;
        return `
          <div class="card" style="margin-bottom: 12px;">
            <p class="field-hint" style="margin-top:0;">To: ${toLine}</p>
            <p style="font-weight:600; margin: 4px 0 10px;">${escapeHtml(notice.subject)}</p>
            <p style="margin: 0 0 10px;">
              <a href="${pdfUrl}" target="_blank" rel="noopener" class="btn">
                View / Download PDF (this is what gets attached to the email and can be printed for court)
              </a>
            </p>
            <p class="field-hint" style="margin: 0 0 4px;">Email preview (same wording, plain formatting for the inbox):</p>
            <iframe
              id="letter-frame"
              title="Notice preview"
              sandbox="allow-same-origin"
              referrerpolicy="no-referrer"
              style="width:100%; min-height:220px; border:1px solid var(--gray-border); border-radius: 6px; background:#fff;"
            ></iframe>
          </div>
        `;
      }

      // The iframe's content is set via the frame's own document, not innerHTML
      // or srcdoc string interpolation — this keeps the template's rendered
      // HTML (which is only as trustworthy as the letter template + tenant
      // merge fields) from ever being parsed into the parent page's DOM.
      // sandbox="allow-same-origin" (and nothing else) blocks script
      // execution, form submission, and top-level navigation from inside the
      // frame — allow-scripts is deliberately never granted, so even if the
      // letter content somehow contained a <script> tag, it could not run.
      // allow-same-origin is required only so this function itself can reach
      // frame.contentDocument to write the content in; a bare sandbox=""
      // makes the frame a fully opaque cross-origin document and
      // contentDocument returns null even to this same-page script.
      function paintLetterPreviews(notice) {
        if (!notice.bodyHtml) return;
        const frame = document.getElementById("letter-frame");
        if (!frame) return;
        const doc = frame.contentDocument;
        doc.open();
        doc.write(
          `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.5;margin:0;padding:4px;color:#1f2421;}</style></head><body>${notice.bodyHtml}</body></html>`
        );
        doc.close();
      }

      function renderNotice(notice) {
        content.innerHTML = `
          <p><a href="/index.html">&larr; Back to dashboard</a></p>
          <h1>${escapeHtml(notice.propertyName)} — Unit ${escapeHtml(notice.unitLabel)}</h1>
          <p class="subtitle">Notice #${notice.id} &middot; ${statusBadge(notice)}</p>
          ${
            notice.status === "voided" && notice.voidedReason
              ? `<div class="alert alert-info">${escapeHtml(notice.voidedReason)}</div>`
              : ""
          }

          <div class="card">
            <h2 style="margin-top:0;">Amount &amp; timing</h2>
            <table class="ledger-table">
              <tr><td>${notice.status === "draft" ? "Amount due (live, as of right now)" : "Amount due (at draft time)"}</td><td>${fmtMoney(notice.amountDueAtDraft)}</td></tr>
              <tr><td>${notice.status === "draft" ? "Days late (live)" : "Days late (at draft time)"}</td><td>${notice.daysLateAtDraft}</td></tr>
              ${notice.amountDueAtSend != null ? `<tr><td>Amount due (at send time)</td><td>${fmtMoney(notice.amountDueAtSend)}</td></tr>` : ""}
              <tr><td>Drafted</td><td>${fmtDateTime(notice.draftedAt)}</td></tr>
              ${notice.sentAt ? `<tr><td>Sent</td><td>${fmtDateTime(notice.sentAt)}</td></tr>` : ""}
              <tr><td>Ledger re-verified against Buildium?</td><td>${notice.ledgerVerified ? "Yes" : "Not yet"}</td></tr>
            </table>
            <h2 style="margin-bottom: 4px;">Itemized breakdown</h2>
            ${renderLedgerRows(notice)}
          </div>

          <div class="card">
            <h2 style="margin-top:0;">The notice letter</h2>
            <p class="subtitle" style="margin-top:-6px;">
              Exactly what would be emailed, rendered from the real template — read it before clicking Review &amp; Send.
            </p>
            ${renderLetterPreview(notice)}
            ${notice.ccRecipients && notice.ccRecipients.length ? `<p class="field-hint">Also CC'd: ${notice.ccRecipients.map((c) => escapeHtml(c.emailAddress)).join(", ")}</p>` : ""}
          </div>

          ${renderRecipientsCard(notice)}

          <div id="action-area"></div>

          <h2>Log a contact attempt</h2>
          <p class="subtitle">Record a call, text, or email you made to this tenant about the balance.</p>
          <div id="contact-log-quick" class="card"></div>
          <div id="contact-log-link" class="card">
            <a class="btn btn-primary" href="/contact-log.html?leaseId=${notice.leaseId}">Go to Contact Log for this lease</a>
          </div>
          <div id="contact-log-history"></div>
        `;

        paintLetterPreviews(notice);
        wireResendForms();
        renderActionArea(notice);
        renderContactQuickLog(notice);
        loadContactHistory(notice);
      }

      // Shows every "to" recipient with their delivery status. A bounced
      // recipient gets an inline "correct the email and resend" form right
      // here — no separate page — since a typo'd address is the single most
      // common reason a notice never reaches a tenant, and this must be
      // fixable without waiting on a formal remediation process.
      function renderRecipientsCard(notice) {
        if (!notice.toRecipients || !notice.toRecipients.length) return "";
        const rows = notice.toRecipients
          .map((r) => {
            const bounced = r.deliveryStatus === "bounced";
            return `
              <div class="card" style="margin-bottom:10px;${bounced ? "border-color:#c0392b;" : ""}">
                <p style="margin:0 0 4px;font-weight:600;">${escapeHtml(r.tenantName)}</p>
                <p class="field-hint" style="margin:0 0 8px;">
                  ${bounced ? `<span class="badge badge-bounced">Bounced</span> ${escapeHtml(r.emailAddress)}` : `${escapeHtml(r.emailAddress)} &middot; ${escapeHtml(r.deliveryStatus)}`}
                </p>
                ${bounced && notice.status === "sent" ? renderResendForm(notice.id, r) : ""}
              </div>
            `;
          })
          .join("");
        return `
          <div class="card">
            <h2 style="margin-top:0;">Recipients</h2>
            ${rows}
          </div>
        `;
      }

      function renderResendForm(noticeId, recipient) {
        return `
          <form class="resend-form" data-recipient-id="${recipient.id}" data-notice-id="${noticeId}">
            <label for="resend-email-${recipient.id}">Corrected email address</label>
            <input type="email" id="resend-email-${recipient.id}" name="email" required value="${escapeHtml(recipient.emailAddress)}" />
            <div id="resend-result-${recipient.id}"></div>
            <button type="submit" class="btn-primary">Save corrected email &amp; resend</button>
          </form>
        `;
      }

      // Wired after render since the card HTML above is built from a string
      // template, same pattern as renderActionArea's listeners below.
      function wireResendForms() {
        document.querySelectorAll(".resend-form").forEach((form) => {
          form.addEventListener("submit", async (e) => {
            e.preventDefault();
            const recipientId = form.dataset.recipientId;
            const noticeId = form.dataset.noticeId;
            const resultBox = document.getElementById(`resend-result-${recipientId}`);
            const submitBtn = form.querySelector("button[type=submit]");
            const email = form.email.value.trim();

            submitBtn.disabled = true;
            submitBtn.textContent = "Sending…";
            resultBox.innerHTML = "";
            try {
              const result = await LimehouseAPI.post(`/api/notices/${noticeId}/recipients/${recipientId}/resend`, { email });
              if (result.resent) {
                resultBox.innerHTML = `<div class="alert alert-success">Resent successfully to ${escapeHtml(email)}.</div>`;
                setTimeout(() => window.location.reload(), 2000);
              } else {
                resultBox.innerHTML = `<div class="alert alert-error">The email address was saved, but the resend still failed to deliver. Double-check the address or try an alternate contact method.</div>`;
              }
            } catch (err) {
              resultBox.innerHTML = `<div class="alert alert-error">${escapeHtml(friendlyError(err))}</div>`;
            } finally {
              submitBtn.disabled = false;
              submitBtn.textContent = "Save corrected email & resend";
            }
          });
        });
      }

      // Inline "I spoke with the tenant" checkbox, right on the notice page,
      // so a PM doesn't have to leave to the full Contact Log just to record
      // a quick call/text. Logging a contact attempt is admin_assistant-only
      // at the database level (RLS — see migration 0027's
      // insert_contact_attempts_admin_assistant policy and contact-log.html's
      // same role check), so this mirrors that page's existing convention
      // rather than duplicating a check the DB already enforces: a plain PM
      // sees the same "handled by the Admin Assistant team" note contact-
      // log.html already shows, not a form that would just 403.
      function renderContactQuickLog(notice) {
        const area = document.getElementById("contact-log-quick");
        if (me.role !== "admin_assistant") {
          area.innerHTML = `<div class="alert alert-info">Logging contact attempts is handled by the Admin Assistant team (Belinda / Vien). Use the link below to view history.</div>`;
          return;
        }

        area.innerHTML = `
          <div class="checkbox-row">
            <input type="checkbox" id="spoke-with-tenant" />
            <label for="spoke-with-tenant">I spoke with the tenant about this notice</label>
          </div>
          <div id="spoke-method-row" style="display:none; margin-top:10px;">
            <label for="spoke-method">How did you reach them?</label>
            <select id="spoke-method">
              <option value="phone">Call</option>
              <option value="text">Text</option>
            </select>
            <div id="spoke-result" style="margin-top:8px;"></div>
            <button id="spoke-save-btn" class="btn-primary" style="margin-top:8px;">Save</button>
          </div>
        `;

        const checkbox = document.getElementById("spoke-with-tenant");
        const methodRow = document.getElementById("spoke-method-row");
        const methodSelect = document.getElementById("spoke-method");
        const saveBtn = document.getElementById("spoke-save-btn");
        const resultBox = document.getElementById("spoke-result");

        checkbox.addEventListener("change", () => {
          methodRow.style.display = checkbox.checked ? "block" : "none";
        });

        saveBtn.addEventListener("click", async () => {
          saveBtn.disabled = true;
          saveBtn.textContent = "Saving…";
          resultBox.innerHTML = "";
          try {
            const saved = await LimehouseAPI.post("/api/contact-attempts", {
              leaseId: notice.leaseId,
              contactMethod: methodSelect.value,
              outcome: "reached_tenant",
            });
            resultBox.innerHTML = `<div class="alert alert-success">Recorded by ${escapeHtml(me.displayName)} &middot; ${fmtDateTime(saved.occurred_at)}</div>`;
            checkbox.checked = false;
            methodRow.style.display = "none";
            loadContactHistory(notice);
          } catch (err) {
            resultBox.innerHTML = `<div class="alert alert-error">${escapeHtml(friendlyError(err))}</div>`;
          } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = "Save";
          }
        });
      }

      const spokeMethodLabels = { phone: "Call", email: "Email", text: "Text" };

      // Every past contact attempt for this lease, most recent first, each
      // with its own date/time stamp — not just the most recent one. Reuses
      // the same GET /api/contact-attempts endpoint contact-log.html already
      // uses, filtered to this lease.
      async function loadContactHistory(notice) {
        const area = document.getElementById("contact-log-history");
        area.innerHTML = `<div class="loading">Loading contact history…</div>`;
        try {
          const { contactAttempts } = await LimehouseAPI.get(`/api/contact-attempts?leaseId=${notice.leaseId}`);
          if (!contactAttempts.length) {
            area.innerHTML = "";
            return;
          }
          area.innerHTML = `
            <div class="card">
              <h2 style="margin-top:0;">Contact history for this lease</h2>
              <div class="notice-list">
                ${contactAttempts
                  .map(
                    (c) => `
                    <div class="notice-row">
                      <div class="row-top">
                        <span class="tenant-name">${escapeHtml(spokeMethodLabels[c.contact_method] || c.contact_method)}</span>
                        <span>${fmtDateTime(c.occurred_at)}</span>
                      </div>
                    </div>
                  `
                  )
                  .join("")}
              </div>
            </div>
          `;
        } catch (err) {
          area.innerHTML = `<div class="alert alert-error">${escapeHtml(friendlyError(err))}</div>`;
        }
      }

      function renderActionArea(notice) {
        const area = document.getElementById("action-area");

        if (notice.status !== "draft") {
          area.innerHTML = "";
          return;
        }

        if (readOnly) {
          area.innerHTML = `<div class="alert alert-info">Your account has read-only access. No action is available here.</div>`;
          return;
        }

        if (!canReviewAndSend && !canFallbackSend) {
          area.innerHTML = `<div class="alert alert-info">This draft isn't assigned to your account, and your account isn't set up as a fallback decision-maker, so there's nothing to act on here.</div>`;
          return;
        }

        // Voiding is only possible when this notice is assigned to YOU
        // specifically (the API checks assigned_pm_id, not fallback status,
        // and silently no-ops with a 204 either way) — so only offer the
        // button when that's plausibly true, and re-check the outcome after.
        const voidButtonHtml = canReviewAndSend
          ? `<button id="void-btn" class="btn-danger">Void this draft</button>`
          : "";

        // Approximate only — the real deadline the server enforces is
        // business-day-adjusted (weekends/holidays don't count), this is a
        // calendar-day estimate just so a fallback decision-maker has a
        // rough sense of timing before clicking. The server is the actual
        // gate and will reject with a precise reason if it's too early.
        const draftedAt = new Date(notice.draftedAt);
        const fallbackDeadline = new Date(draftedAt.getTime() + 2 * 24 * 60 * 60 * 1000);
        const fallbackNotice =
          !canReviewAndSend && canFallbackSend
            ? `<div class="alert alert-warn">You're acting as the fallback decision-maker, not the assigned PM. The assigned PM gets 2 full business days first — roughly until ${fmtDate(fallbackDeadline)}. If you try before that, the system will block it and tell you the exact deadline.</div>`
            : "";

        area.innerHTML = `
          <div class="card">
            <h2 style="margin-top:0;">Review &amp; Send</h2>
            ${fallbackNotice}
            <ul class="gate-list">
              <li class="gate-ok">System will re-check the live Buildium balance right before sending</li>
              <li class="gate-ok">If the tenant already paid down below the threshold, this will auto-void instead of sending</li>
              <li class="${notice.ledgerVerified ? "gate-ok" : "gate-bad"}">Ledger verification ${notice.ledgerVerified ? "already confirmed" : "required from you below"}</li>
            </ul>
            <div class="checkbox-row">
              <input type="checkbox" id="ledger-confirm" />
              <label for="ledger-confirm">I read the notice letter above, checked this tenant's balance in Buildium, and it matches ${fmtMoney(notice.amountDueAtDraft)} (or I understand the system will re-check the live balance automatically).</label>
            </div>
            <div id="send-result"></div>
            <div class="btn-row">
              <button id="send-btn" class="btn-primary" disabled>Review &amp; Send</button>
              ${voidButtonHtml}
            </div>
            <p class="field-hint" style="margin-top:10px;">
              This system is in <strong>shadow mode</strong>. Clicking Send will run every real check (balance re-verification,
              stale-draft protection, audit logging) but will <strong>not actually email the tenant</strong>. You'll see exactly
              what shadow mode reports below.
            </p>
            ${!canReviewAndSend && canFallbackSend ? `<p class="field-hint">Voiding isn't available here for a fallback send — only the PM this draft is assigned to can void it.</p>` : ""}
          </div>
        `;

        const checkbox = document.getElementById("ledger-confirm");
        const sendBtn = document.getElementById("send-btn");
        const voidBtn = document.getElementById("void-btn");
        const resultBox = document.getElementById("send-result");

        checkbox.addEventListener("change", () => {
          sendBtn.disabled = !checkbox.checked;
        });

        sendBtn.addEventListener("click", async () => {
          sendBtn.disabled = true;
          sendBtn.textContent = "Sending…";
          resultBox.innerHTML = "";
          try {
            const endpoint = canReviewAndSend
              ? `/api/notices/${notice.id}/send`
              : `/api/notices/${notice.id}/send-as-fallback`;
            const result = await LimehouseAPI.post(endpoint, { ledgerVerified: true });

            if (result.voided) {
              resultBox.innerHTML = `<div class="alert alert-warn">Not sent — the tenant's balance had already dropped below the threshold, so this draft was voided automatically instead. No notice was needed.</div>`;
            } else if (result.sent === false) {
              resultBox.innerHTML = `<div class="alert alert-warn"><strong>Shadow mode:</strong> the system ran every check as if this were a real send, but no email was actually sent — this is expected while the system is in test mode. It's logged as what would have happened.</div>`;
            } else {
              resultBox.innerHTML = `<div class="alert alert-success">Sent.</div>`;
            }
            sendBtn.textContent = "Review & Send";
            setTimeout(() => window.location.reload(), 2500);
          } catch (err) {
            resultBox.innerHTML = `<div class="alert alert-error">${escapeHtml(friendlyError(err))}</div>`;
            sendBtn.disabled = false;
            sendBtn.textContent = "Review & Send";
          }
        });

        if (voidBtn) {
          voidBtn.addEventListener("click", async () => {
            const reason = window.prompt("Why are you voiding this draft? (required, 5+ characters)");
            if (!reason || reason.trim().length < 5) {
              if (reason !== null) {
                resultBox.innerHTML = `<div class="alert alert-error">A reason of at least 5 characters is required to void a draft.</div>`;
              }
              return;
            }
            voidBtn.disabled = true;
            try {
              await LimehouseAPI.post(`/api/notices/${notice.id}/void`, { reason: reason.trim() });
              // The API returns 204 whether or not a row actually matched
              // (e.g. this draft isn't assigned to you) — re-fetch the
              // detail to find out what really happened instead of
              // assuming success.
              const { notice: refreshed } = await LimehouseAPI.get(`/api/notices/${notice.id}`);
              if (refreshed && refreshed.status === "voided") {
                resultBox.innerHTML = `<div class="alert alert-success">Draft voided.</div>`;
              } else {
                resultBox.innerHTML = `<div class="alert alert-warn">Nothing changed — this draft isn't assigned to your account, so it couldn't be voided from here.</div>`;
              }
              setTimeout(() => window.location.reload(), 1500);
            } catch (err) {
              resultBox.innerHTML = `<div class="alert alert-error">${escapeHtml(friendlyError(err))}</div>`;
              voidBtn.disabled = false;
            }
          });
        }
      }
    })();
