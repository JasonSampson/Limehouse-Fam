// Named-area exclusion tool (LimeHQ "Map" module → /map/areas). Shadow-mode
// only per governance-review.md's verdict — nothing in this file ever
// creates an area as `active`; "Activate" is its own separate, permission-
// gated action kept deliberately harder to reach than create/preview.

(function () {
  const HAMPTON_ROADS_CENTER = { lat: 36.8945, lng: -76.3452 };

  function getConfig() {
    const el = document.getElementById("areas-app");
    try {
      return JSON.parse(el.dataset.config || "{}");
    } catch {
      return {};
    }
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtDateTime(v) {
    if (!v) return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function daysSince(v) {
    if (!v) return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  }

  window.mapAreasInit = function () {
    const config = getConfig();
    const canvas = document.getElementById("map-canvas");
    const map = new google.maps.Map(canvas, {
      center: HAMPTON_ROADS_CENTER,
      zoom: 10,
      streetViewControl: false,
      mapTypeControl: false,
      fullscreenControl: false,
    });

    const sidebar = document.createElement("div");
    sidebar.className = "areas-sidebar";
    canvas.parentElement.appendChild(sidebar);

    let currentPolygon = null;
    let selectedAreaId = null;

    // ------------------------------------------------------------------ //
    // Manual boundary drawing.
    //
    // This used to be google.maps.drawing.DrawingManager. Google deprecated
    // the whole drawing library in August 2025 and removed it outright in
    // Maps JS API v3.65 (June 2026) — this page loads the unversioned
    // "current"/weekly release (see mapRoutes.ts's script tag), so
    // `google.maps.drawing` no longer exists here at all, and mapAreasInit
    // threw synchronously the moment it ran. There's no version to pin our
    // way out of this: the library is gone from every release going
    // forward, and pinning an old numbered release is exactly the kind of
    // silent-breakage risk that caused this bug in the first place (Google
    // only serves old pinned versions for a limited window). Google's own
    // docs now point people at either a third-party library (Terra Draw) or
    // a plain google.maps.Polygon driven by map click events — the second
    // one is simpler, has no new dependency, and cannot be deprecated out
    // from under us the same way (Polygon is core Maps JS, not an add-on
    // library). That's what this does: click to add a vertex, double-click
    // (or the "Finish" button, more reliable than relying on double-click
    // registering cleanly on every trackpad) to close the shape.
    let drawState = null; // { clickListener, dblClickListener } while actively drawing

    function stopDrawing() {
      if (!drawState) return;
      google.maps.event.removeListener(drawState.clickListener);
      google.maps.event.removeListener(drawState.dblClickListener);
      drawState = null;
    }

    function startDrawing() {
      stopDrawing();
      if (currentPolygon) { currentPolygon.setMap(null); currentPolygon = null; }

      // NOTE: construct with ONE throwaway point, then immediately clear it —
      // do not construct with an empty path directly. Confirmed directly in
      // the console: `new google.maps.Polygon({ paths: [] })` (and likewise
      // `paths: new google.maps.MVCArray()`) leaves getPath() returning
      // undefined in this API version, permanently, not just at construction
      // time. Starting non-empty and calling path.clear() right after keeps
      // the SAME live MVCArray reference (getPath() stays valid afterward —
      // also confirmed directly), which is what the click handler below
      // pushes vertices onto.
      const polygon = new google.maps.Polygon({
        paths: [HAMPTON_ROADS_CENTER],
        fillColor: "#74b62e",
        fillOpacity: 0.25,
        strokeColor: "#009344",
        strokeWeight: 2,
        map,
        editable: false,
        clickable: false, // let clicks on the growing shape still reach the map underneath
      });
      const path = polygon.getPath();
      path.clear();
      currentPolygon = polygon;

      const clickListener = map.addListener("click", (e) => {
        path.push(e.latLng);
        updateDrawingUi(polygon);
      });

      // A dblclick fires two ordinary "click" events first (at the same
      // spot) before the dblclick event itself — those two clicks already
      // pushed a duplicate point onto the path via the listener above, so
      // drop the extra one here rather than finish with a degenerate
      // repeated vertex at the closing point.
      const dblClickListener = map.addListener("dblclick", () => {
        if (path.getLength() > 1) path.pop();
        finishDrawing(polygon);
      });

      drawState = { clickListener, dblClickListener };
      renderDrawingUi(polygon);
    }

    function finishDrawing(polygon) {
      if (polygon.getPath().getLength() < 3) return; // needs at least 3 points to be a real polygon
      stopDrawing();
      polygon.setOptions({ editable: true, clickable: true });
      showDrawResult(polygon);
    }

    function renderDrawingUi(polygon) {
      sidebar.innerHTML = `
        <p style="font-size:.85rem;color:#444;margin-bottom:.5rem">
          Click points on the map to draw a boundary (at least 3), then double-click
          or press "Finish" below to close it.
        </p>
        <p id="draw-point-count" style="font-size:.78rem;color:#777;margin-bottom:.5rem">0 points</p>
        <button type="button" class="popup-btn" id="finish-draw-btn" disabled>Finish (need 3+ points)</button>
        <button type="button" class="popup-btn secondary" id="cancel-draw-btn">Cancel</button>
      `;
      document.getElementById("finish-draw-btn").addEventListener("click", () => finishDrawing(polygon));
      document.getElementById("cancel-draw-btn").addEventListener("click", () => {
        stopDrawing();
        if (currentPolygon) { currentPolygon.setMap(null); currentPolygon = null; }
        loadAreaList();
      });
      updateDrawingUi(polygon);
    }

    function updateDrawingUi(polygon) {
      const n = polygon.getPath().getLength();
      const countEl = document.getElementById("draw-point-count");
      const finishBtn = document.getElementById("finish-draw-btn");
      if (countEl) countEl.textContent = `${n} point${n === 1 ? "" : "s"}`;
      if (finishBtn) {
        finishBtn.disabled = n < 3;
        finishBtn.textContent = n < 3 ? "Finish (need 3+ points)" : "Finish";
      }
    }
    // ------------------------------------------------------------------ //

    function boundaryFromPolygon(polygon) {
      const path = polygon.getPath();
      const points = [];
      for (let i = 0; i < path.getLength(); i++) {
        const pt = path.getAt(i);
        points.push({ lat: pt.lat(), lng: pt.lng() });
      }
      return points;
    }

    function drawBoundaryReadOnly(boundary) {
      if (currentPolygon) currentPolygon.setMap(null);
      currentPolygon = new google.maps.Polygon({
        paths: boundary,
        fillColor: "#009344",
        fillOpacity: 0.2,
        strokeColor: "#009344",
        strokeWeight: 2,
        map,
        editable: false,
      });
      const bounds = new google.maps.LatLngBounds();
      boundary.forEach((p) => bounds.extend(p));
      map.fitBounds(bounds);
    }

    async function showDrawResult(polygon) {
      const boundary = boundaryFromPolygon(polygon);
      renderNewAreaPanel(boundary);
    }

    function renderNewAreaPanel(boundary) {
      selectedAreaId = null;
      sidebar.innerHTML = `
        <h2 style="font-size:1rem;margin-bottom:.75rem">New named area</h2>
        <div class="form-error" style="display:none;color:#dc2626;font-size:.8rem;margin-bottom:.5rem"></div>
        <label style="display:block;font-size:.8rem;font-weight:600;margin-bottom:.3rem">Area name
          <input type="text" id="new-area-name" style="width:100%;padding:.5rem .6rem;border:1.5px solid #ddd;border-radius:6px;margin-top:.25rem" placeholder="e.g. West Ghent"/>
        </label>
        <p id="preview-count" style="font-size:.8rem;color:#666;margin:.5rem 0">Checking what this boundary currently matches…</p>
        <div id="preview-list" style="font-size:.78rem;color:#444;max-height:160px;overflow-y:auto;margin-bottom:.75rem"></div>
        <button type="button" class="popup-btn" id="save-area-btn">Save (creates shadow-mode area)</button>
        <button type="button" class="popup-btn secondary" id="redraw-btn">Redraw</button>
        <p style="font-size:.72rem;color:#888;margin-top:.75rem">
          Saving creates the area in <b>shadow</b> status only — nothing is excluded from
          anything real yet. It just starts logging what it would match.
        </p>
        ${backToListLink()}
      `;
      wireBackToList();

      previewBoundary(boundary);

      document.getElementById("redraw-btn").addEventListener("click", () => {
        startDrawing();
      });

      document.getElementById("save-area-btn").addEventListener("click", async () => {
        const nameInput = document.getElementById("new-area-name");
        const errorEl = sidebar.querySelector(".form-error");
        errorEl.style.display = "none";
        const name = nameInput.value.trim();
        if (!name) {
          errorEl.textContent = "Name the area before saving.";
          errorEl.style.display = "block";
          return;
        }
        try {
          const res = await fetch(`${config.apiBase}/areas`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ area_name: name, boundary }),
          });
          const json = await res.json();
          if (!res.ok || !json.ok) throw new Error(json.error || "Could not save this area.");
          await loadAreaList();
          openAreaDetail(json.id);
        } catch (err) {
          errorEl.textContent = err.message;
          errorEl.style.display = "block";
        }
      });
    }

    async function previewBoundary(boundary) {
      const countEl = document.getElementById("preview-count");
      const listEl = document.getElementById("preview-list");
      try {
        const res = await fetch(`${config.apiBase}/areas/preview`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ boundary }),
        });
        const json = await res.json();
        if (!res.ok || !json.ok) throw new Error(json.error || "Could not preview this boundary.");
        countEl.textContent = `${json.matches.length} currently-managed propert${json.matches.length === 1 ? "y falls" : "ies fall"} inside this boundary right now:`;
        listEl.innerHTML = json.matches.map((m) => `<div>${esc(m.addressLine1)}, ${esc(m.city)}</div>`).join("") || '<div style="color:#999">No properties currently match.</div>';
      } catch (err) {
        countEl.textContent = err.message;
      }
    }

    function backToListLink() {
      return `<div style="margin-top:1rem"><a href="#" id="back-to-list" style="font-size:.8rem;color:#009344;font-weight:600">← All areas</a></div>`;
    }
    function wireBackToList() {
      const link = document.getElementById("back-to-list");
      if (link) link.addEventListener("click", (e) => { e.preventDefault(); loadAreaList(); });
    }

    function statusPillHtml(status) {
      return `<span class="status-pill status-${status}">${status}</span>`;
    }

    async function openAreaDetail(id) {
      selectedAreaId = id;
      sidebar.innerHTML = `<p style="font-size:.85rem;color:#666">Loading…</p>`;
      try {
        const res = await fetch(`${config.apiBase}/areas/${id}`, { credentials: "same-origin" });
        const json = await res.json();
        if (!res.ok || !json.ok) throw new Error(json.error || "Could not load this area.");
        renderAreaDetail(json.area, json.liveMatches, json.shadowLog);
      } catch (err) {
        sidebar.innerHTML = `<p style="color:#dc2626;font-size:.85rem">${esc(err.message)}</p>${backToListLink()}`;
        wireBackToList();
      }
    }

    function renderAreaDetail(area, liveMatches, shadowLog) {
      drawBoundaryReadOnly(area.boundary);

      const age = daysSince(area.createdAt);
      const shadowStats = `
        <div style="font-size:.8rem;color:#444;margin:.5rem 0">
          <div>Shadow mode since ${esc(fmtDateTime(area.createdAt))} (${age === null ? "?" : age} day${age === 1 ? "" : "s"} ago)</div>
          <div>${shadowLog.distinctPropertiesEverMatched} distinct propert${shadowLog.distinctPropertiesEverMatched === 1 ? "y" : "ies"} matched across ${shadowLog.distinctSnapshotDays} logged day${shadowLog.distinctSnapshotDays === 1 ? "" : "s"}</div>
        </div>`;

      const liveList = `
        <p style="font-size:.8rem;font-weight:600;margin-top:.6rem">Matches right now (${liveMatches.length}):</p>
        <div style="font-size:.78rem;color:#444;max-height:160px;overflow-y:auto;margin-bottom:.5rem">
          ${liveMatches.map((m) => `<div>${esc(m.addressLine1)}, ${esc(m.city)}</div>`).join("") || '<div style="color:#999">None.</div>'}
        </div>`;

      let actionsHtml = "";
      if (area.status === "shadow") {
        if (config.permissions.canActivate) {
          actionsHtml = `
            <div class="activate-warning">
              Activate only after Mason and Jason's attorney have reviewed the shadow-mode results.
            </div>
            <button type="button" class="popup-btn" id="activate-btn">Activate this area</button>`;
        } else {
          actionsHtml = `<p style="font-size:.78rem;color:#888;margin-top:.5rem">Only an Owner/Admin with activation permission can move this out of shadow mode.</p>`;
        }
      } else if (area.status === "active") {
        actionsHtml = `
          <p style="font-size:.8rem;color:#444;margin-top:.5rem">Activated by ${esc(area.activatedByName)} on ${esc(fmtDateTime(area.activatedAt))}</p>
          ${config.permissions.canActivate ? `<button type="button" class="popup-btn danger" id="retire-btn">Retire this area</button>` : ""}`;
      } else if (area.status === "retired") {
        actionsHtml = `<p style="font-size:.8rem;color:#888;margin-top:.5rem">Retired by ${esc(area.retiredByName)} on ${esc(fmtDateTime(area.retiredAt))}</p>`;
      }

      sidebar.innerHTML = `
        <h2 style="font-size:1rem;margin-bottom:.3rem">${esc(area.areaName)} ${statusPillHtml(area.status)}</h2>
        <p style="font-size:.78rem;color:#777">Created by ${esc(area.createdByName)}</p>
        ${shadowStats}
        ${liveList}
        ${actionsHtml}
        ${backToListLink()}
      `;
      wireBackToList();

      const activateBtn = document.getElementById("activate-btn");
      if (activateBtn) {
        activateBtn.addEventListener("click", async () => {
          if (!confirm(`Activate "${area.areaName}"? This is the one action that actually changes anything — make sure Mason and Jason's attorney have reviewed the shadow-mode results first.`)) return;
          activateBtn.disabled = true;
          try {
            const res = await fetch(`${config.apiBase}/areas/${area.id}/activate`, { method: "POST", credentials: "same-origin" });
            const json = await res.json();
            if (!res.ok || !json.ok) throw new Error(json.error || "Could not activate this area.");
            await loadAreaList();
            openAreaDetail(area.id);
          } catch (err) {
            activateBtn.disabled = false;
            alert(err.message);
          }
        });
      }
      const retireBtn = document.getElementById("retire-btn");
      if (retireBtn) {
        retireBtn.addEventListener("click", async () => {
          if (!confirm(`Retire "${area.areaName}"?`)) return;
          retireBtn.disabled = true;
          try {
            const res = await fetch(`${config.apiBase}/areas/${area.id}/retire`, { method: "POST", credentials: "same-origin" });
            const json = await res.json();
            if (!res.ok || !json.ok) throw new Error(json.error || "Could not retire this area.");
            await loadAreaList();
            openAreaDetail(area.id);
          } catch (err) {
            retireBtn.disabled = false;
            alert(err.message);
          }
        });
      }
    }

    async function loadAreaList() {
      if (currentPolygon) { currentPolygon.setMap(null); currentPolygon = null; }
      selectedAreaId = null;
      let areas = config.areas || [];
      try {
        const res = await fetch(`${config.apiBase}/areas`, { credentials: "same-origin" });
        const json = await res.json();
        if (res.ok && json.ok) areas = json.areas;
      } catch {
        // fall back to server-rendered initial list
      }

      const newBtn = config.permissions && config.permissions.canManage
        ? `<button type="button" class="popup-btn" id="new-area-btn" style="width:100%;margin-bottom:.75rem">+ Draw a new area</button>`
        : "";

      sidebar.innerHTML = `
        <a href="/map" class="nav-link" style="display:inline-block;margin-bottom:.6rem">← Back to Map</a>
        <h2 style="font-size:1rem;margin-bottom:.75rem">Named-Area Exclusion Tool</h2>
        ${newBtn}
        <div id="areas-list"></div>
      `;

      const listEl = document.getElementById("areas-list");
      if (!areas.length) {
        listEl.innerHTML = `<p style="font-size:.85rem;color:#999">No named areas yet.</p>`;
      } else {
        listEl.innerHTML = areas
          .map(
            (a) => `
          <div class="areas-list-item" data-area-id="${a.id}">
            <div style="font-weight:700;font-size:.9rem">${esc(a.areaName)} ${statusPillHtml(a.status)}</div>
            <div style="font-size:.75rem;color:#888">by ${esc(a.createdByName)}</div>
          </div>`,
          )
          .join("");
        listEl.querySelectorAll(".areas-list-item").forEach((el) => {
          el.addEventListener("click", () => openAreaDetail(Number(el.dataset.areaId)));
        });
      }

      const newAreaBtn = document.getElementById("new-area-btn");
      if (newAreaBtn) {
        // newAreaBtn only exists in the DOM at all when canManage is true
        // (see newBtn above), so no separate permission guard needed here.
        newAreaBtn.addEventListener("click", () => startDrawing());
      }
    }

    loadAreaList();
  };
})();
