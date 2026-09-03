// Internal coverage-area map (LimeHQ "Map" module). Vanilla JS, no bundler —
// loaded as a plain <script src> after the config div is server-rendered
// (see src/map/mapRoutes.ts). Google Maps JS itself calls window.
// mapInternalInit once its script tag finishes loading (callback=
// mapInternalInit in the script URL).

(function () {
  const HAMPTON_ROADS_CENTER = { lat: 36.8945, lng: -76.3452 };

  // "Ocean blue" custom styling per spec.md ("same ocean-blue styled map"),
  // distinct from the lime/dark-green brand palette used for LimeHQ's own
  // nav/buttons — this only affects the map's own water/land/road chrome.
  const OCEAN_BLUE_STYLE = [
    { elementType: "geometry", stylers: [{ color: "#eef3f7" }] },
    { elementType: "labels.text.fill", stylers: [{ color: "#4a5a68" }] },
    { elementType: "labels.text.stroke", stylers: [{ color: "#ffffff" }] },
    { featureType: "water", elementType: "geometry", stylers: [{ color: "#8fc1e3" }] },
    { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#2c6f9b" }] },
    { featureType: "landscape", elementType: "geometry", stylers: [{ color: "#eef3f7" }] },
    { featureType: "poi", elementType: "geometry", stylers: [{ color: "#dde8ea" }] },
    // FIXED [today], per Jason directly: the styling above only ever
    // recolored POI geometry — it never touched the icon/label layer, so
    // every restaurant/business marker Google shows by default was still
    // rendering on top, cluttering the map. This turns those off while
    // leaving park shading (poi.park below) alone.
    { featureType: "poi", elementType: "labels.icon", stylers: [{ visibility: "off" }] },
    { featureType: "poi", elementType: "labels.text", stylers: [{ visibility: "off" }] },
    { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#d5e8d4" }] },
    { featureType: "road", elementType: "geometry", stylers: [{ color: "#ffffff" }] },
    { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#fafcfd" }] },
    { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#cfe0ea" }] },
    { featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#a9c6d6" }] },
    { featureType: "administrative", elementType: "geometry.stroke", stylers: [{ color: "#a9c6d6" }] },
    { featureType: "transit", stylers: [{ visibility: "off" }] },
  ];

  function getConfig() {
    const el = document.getElementById("map-app");
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

  function fmtMoney(v) {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    if (Number.isNaN(n)) return null;
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }

  function fmtDate(v) {
    if (!v) return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  }

  // ------------------------------------------------------------------ //
  // Popup content (rendered into a Google InfoWindow)                   //
  // ------------------------------------------------------------------ //

  function unitSummary(u) {
    const parts = [];
    if (u.bedrooms !== null) parts.push(u.bedrooms + " bd");
    if (u.bathrooms !== null) parts.push(u.bathrooms + " ba");
    if (u.squareFeet !== null) parts.push(u.squareFeet.toLocaleString() + " sqft");
    return parts.join(" · ") || "Size not on file";
  }

  // Extra recurring charges beyond base rent (utilities, etc.) — shown as
  // their own line right after the rent line, e.g. "+ $75/mo Utility Rent -
  // water/sewer/trash", never folded silently into the rent figure (Jason's
  // explicit ask). The API already excludes charges like "Resident Benefits
  // Package" (see mapQueries.ts) — this just renders whatever comes back.
  function recurringChargesHtml(u) {
    if (!u.recurringCharges || !u.recurringCharges.length) return "";
    return u.recurringCharges
      .map(
        (c) =>
          `<div class="unit-detail-row unit-extra-charge">+ ${esc(fmtMoney(c.amount))}/mo ${esc(c.label)}</div>`,
      )
      .join("");
  }

  function unitDetailHtml(u) {
    const rentLine = u.isVacant
      ? u.askingRent
        ? `<div class="unit-detail-row"><b>${esc(fmtMoney(u.askingRent))}</b> asking rent <span class="vacant-badge">VACANT</span></div>`
        : `<div class="unit-detail-row">No asking rent on file <span class="vacant-badge">VACANT</span></div>`
      : u.currentRent
        ? `<div class="unit-detail-row"><b>${esc(fmtMoney(u.currentRent))}</b> current rent</div>`
        : `<div class="unit-detail-row">Rent not on file</div>`;

    const leaseLine =
      u.leaseFrom || u.leaseTo
        ? `<div class="unit-detail-row">Lease: ${esc(fmtDate(u.leaseFrom) || "?")} – ${esc(fmtDate(u.leaseTo) || "open-ended")}</div>`
        : "";

    // FIXED [today], per Jason directly: t.phone comes straight from
    // Buildium already formatted with its own parentheses (e.g.
    // "(757) 555-0100" — see src/map/mapQueries.ts, no formatting applied
    // here or anywhere upstream), so wrapping it in a second pair produced
    // "Name ((757) 555-0100)". It's shown as-is now, just space-separated.
    const tenantsLine = u.tenants && u.tenants.length
      ? `<div class="unit-detail-row">${u.tenants
          .map((t) => esc(t.fullName) + (t.phone ? " " + esc(t.phone) : ""))
          .join(", ")}</div>`
      : !u.isVacant
        ? `<div class="unit-detail-row" style="color:#999">No tenant on file</div>`
        : "";

    return `
      <div class="unit-detail-row">${esc(unitSummary(u))}</div>
      ${rentLine}
      ${recurringChargesHtml(u)}
      ${leaseLine}
      ${tenantsLine}
    `;
  }

  function popupHtml(property, config) {
    const photo = property.photoUrl
      ? `<img class="popup-photo" src="${esc(property.photoUrl)}" alt="Property photo"/>`
      : `<div class="popup-photo-placeholder">Photo not available</div>`;

    const addr2 = property.addressLine2 ? ", " + esc(property.addressLine2) : "";
    const units = property.units && property.units.length ? property.units : [];

    let unitsHtml;
    if (units.length <= 1) {
      unitsHtml = units.length === 1 ? unitDetailHtml(units[0]) : `<div class="unit-detail-row" style="color:#999">No unit data on file</div>`;
    } else {
      // Multi-unit property (e.g. a duplex) — tab strip so it's obvious
      // there's more than one unit rather than silently showing only the
      // first, per Tron's UI-decision call (schema.md flagged this as open).
      const tabs = units
        .map((u, i) => `<button type="button" class="unit-tab${i === 0 ? " active" : ""}" data-unit-index="${i}">${esc(u.unitLabel)}</button>`)
        .join("");
      unitsHtml = `
        <div class="unit-tabs">${tabs}</div>
        <div class="unit-detail-panels">
          ${units.map((u, i) => `<div class="unit-detail-panel" data-unit-index="${i}" style="${i === 0 ? "" : "display:none"}">${unitDetailHtml(u)}</div>`).join("")}
        </div>`;
    }

    const exclusion = property.exclusion;
    const flagBadge = exclusion
      ? `<div class="flag-badge"><b>Flagged do-not-pursue</b> — ${esc(config.reasonLabels?.[exclusion.reasonCode] || exclusion.reasonCode)}<br/>
          by ${esc(exclusion.flaggedByName)} on ${esc(fmtDate(exclusion.flaggedAt))}
          ${exclusion.reviewBy ? `<br/>Review by: ${esc(fmtDate(exclusion.reviewBy))}` : ""}
        </div>`
      : "";

    let actionsHtml = "";
    if (config.permissions && config.permissions.canManageExclusions) {
      if (exclusion) {
        actionsHtml = `<div class="popup-actions"><button type="button" class="popup-btn danger" data-action="unflag" data-exclusion-id="${exclusion.id}">Unflag property</button></div>`;
      } else {
        const reasonOptions = (config.reasonCodes || [])
          .map(
            (rc) => `
            <label>
              <input type="radio" name="reason_code" value="${esc(rc.code)}" data-needs-evidence="${rc.needsEvidence ? "1" : "0"}"/>
              ${esc(rc.label)}
            </label>`,
          )
          .join("");
        actionsHtml = `
          <div class="popup-actions">
            <button type="button" class="popup-btn secondary" data-action="show-flag-form">Flag do-not-pursue</button>
            <form class="flag-form" data-property-id="${property.id}" style="display:none">
              ${reasonOptions}
              <div class="safety-fields">
                <label style="display:block">Documented incident
                  <textarea name="incident_report" rows="3" placeholder="e.g. Property Meld ticket #1234, 2026-06-01"></textarea>
                </label>
                <p class="helper-text">Must reference a dated, existing record — a Property Meld ticket number or an email — not a description written fresh right now. At least 20 characters.</p>
                <label style="display:block">Review by
                  <input type="date" name="review_by"/>
                </label>
              </div>
              <div class="form-error" style="display:none"></div>
              <button type="submit" class="popup-btn">Submit flag</button>
              <button type="button" class="popup-btn secondary" data-action="cancel-flag-form">Cancel</button>
            </form>
          </div>`;
      }
    }

    return `
      <div class="popup" data-property-id="${property.id}">
        ${photo}
        <div class="popup-address">${esc(property.addressLine1)}${addr2}</div>
        <div class="popup-city">${esc(property.city)}, ${esc(property.state)} ${esc(property.postalCode)}</div>
        ${flagBadge}
        ${unitsHtml}
        ${actionsHtml}
      </div>`;
  }

  function wirePopupEvents(container, property, config, map, marker, refreshAll) {
    container.querySelectorAll(".unit-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        const idx = tab.dataset.unitIndex;
        container.querySelectorAll(".unit-tab").forEach((t) => t.classList.toggle("active", t === tab));
        container.querySelectorAll(".unit-detail-panel").forEach((p) => {
          p.style.display = p.dataset.unitIndex === idx ? "" : "none";
        });
      });
    });

    const showBtn = container.querySelector('[data-action="show-flag-form"]');
    const form = container.querySelector(".flag-form");
    if (showBtn && form) {
      showBtn.addEventListener("click", () => {
        showBtn.style.display = "none";
        form.style.display = "block";
      });
    }
    const cancelBtn = container.querySelector('[data-action="cancel-flag-form"]');
    if (cancelBtn && form && showBtn) {
      cancelBtn.addEventListener("click", () => {
        form.style.display = "none";
        showBtn.style.display = "";
      });
    }
    if (form) {
      form.querySelectorAll('input[name="reason_code"]').forEach((radio) => {
        radio.addEventListener("change", () => {
          const needsEvidence = radio.dataset.needsEvidence === "1" && radio.checked;
          const fields = form.querySelector(".safety-fields");
          fields.classList.toggle("shown", needsEvidence);
        });
      });
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const errorEl = form.querySelector(".form-error");
        errorEl.style.display = "none";
        const reasonCode = form.querySelector('input[name="reason_code"]:checked');
        if (!reasonCode) {
          errorEl.textContent = "Choose a reason.";
          errorEl.style.display = "block";
          return;
        }
        const body = { reason_code: reasonCode.value };
        if (reasonCode.dataset.needsEvidence === "1") {
          body.incident_report = form.querySelector('[name="incident_report"]').value.trim();
          body.review_by = form.querySelector('[name="review_by"]').value;
        }
        try {
          const res = await fetch(`${config.apiBase}/properties/${property.id}/exclusions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify(body),
          });
          const json = await res.json();
          if (!res.ok || !json.ok) throw new Error(json.error || "Could not save the flag.");
          await refreshAll();
        } catch (err) {
          errorEl.textContent = err.message;
          errorEl.style.display = "block";
        }
      });
    }

    const unflagBtn = container.querySelector('[data-action="unflag"]');
    if (unflagBtn) {
      unflagBtn.addEventListener("click", async () => {
        unflagBtn.disabled = true;
        unflagBtn.textContent = "Removing…";
        try {
          const res = await fetch(`${config.apiBase}/exclusions/${unflagBtn.dataset.exclusionId}/remove`, {
            method: "POST",
            credentials: "same-origin",
          });
          const json = await res.json();
          if (!res.ok || !json.ok) throw new Error(json.error || "Could not unflag this property.");
          await refreshAll();
        } catch (err) {
          unflagBtn.disabled = false;
          unflagBtn.textContent = "Unflag property";
          alert(err.message);
        }
      });
    }
  }

  // ------------------------------------------------------------------ //
  // Map bootstrap                                                       //
  // ------------------------------------------------------------------ //

  window.mapInternalInit = function () {
    const config = getConfig();
    const canvas = document.getElementById("map-canvas");
    const map = new google.maps.Map(canvas, {
      center: HAMPTON_ROADS_CENTER,
      zoom: 10,
      styles: OCEAN_BLUE_STYLE,
      streetViewControl: false,
      mapTypeControl: false,
      fullscreenControl: false,
    });

    // Address search box (Places Autocomplete) — re-centers the map only;
    // never triggers a Buildium refresh (spec.md: "just geocoding an
    // arbitrary address the visitor typed, unrelated to synced property
    // data").
    const searchWrap = document.createElement("div");
    searchWrap.className = "map-search-box";
    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = "Search an address…";
    searchWrap.appendChild(searchInput);
    map.controls[google.maps.ControlPosition.TOP_LEFT].push(searchWrap);
    const autocomplete = new google.maps.places.Autocomplete(searchInput, {
      componentRestrictions: { country: "us" },
      fields: ["geometry"],
    });
    // FIXED [today], per Jason directly: this used to only pan/zoom the map,
    // landing on the general area with nothing marking the actual searched
    // point. Google's default red pin (deliberately NOT the house icon
    // property markers use below, so a search result is never mistaken for
    // a tracked property) now drops right on it, and a tighter zoom (17,
    // building-level) pinpoints it rather than just the neighborhood.
    let searchMarker = null;
    autocomplete.addListener("place_changed", () => {
      const place = autocomplete.getPlace();
      if (place.geometry && place.geometry.location) {
        map.setCenter(place.geometry.location);
        map.setZoom(17);
        if (searchMarker) searchMarker.setMap(null);
        searchMarker = new google.maps.Marker({
          position: place.geometry.location,
          map,
          animation: google.maps.Animation.DROP,
        });
      }
    });

    const loadingEl = document.createElement("div");
    loadingEl.className = "map-loading";
    loadingEl.innerHTML = '<span class="spinner"></span> Loading properties…';
    canvas.parentElement.appendChild(loadingEl);

    const reasonLabels = {};
    (config.reasonCodes || []).forEach((rc) => (reasonLabels[rc.code] = rc.label));
    config.reasonLabels = reasonLabels;

    let markers = [];
    let infoWindow = new google.maps.InfoWindow();

    function clearMarkers() {
      markers.forEach((m) => m.setMap(null));
      markers = [];
    }

    function openPopupFor(property, marker) {
      const html = popupHtml(property, config);
      infoWindow.setContent(html);
      infoWindow.open({ map, anchor: marker });
      google.maps.event.addListenerOnce(infoWindow, "domready", () => {
        const container = document.querySelector(`.popup[data-property-id="${property.id}"]`);
        if (container) wirePopupEvents(container, property, config, map, marker, loadProperties);
      });
    }

    async function loadProperties() {
      loadingEl.style.display = "flex";
      try {
        const res = await fetch(`${config.apiBase}/properties`, { credentials: "same-origin" });
        const json = await res.json();
        if (!res.ok || !json.ok) throw new Error(json.error || "Could not load properties.");
        clearMarkers();
        json.properties.forEach((property) => {
          const flagged = Boolean(property.exclusion);
          // CHANGED [today], per Jason directly: the plain green/gray circle
          // is now the real LimeHousePM icon (public/images/map-pin-icon.png),
          // same ~20px footprint the circle used (scale 8 + a 2px stroke).
          // A flat icon image can't swap fill color the way the vector CIRCLE
          // symbol did, so the flagged/excluded distinction is now carried by
          // Marker's own `opacity` instead — full color for a tracked
          // property, faded for one excluded from tracking.
          const marker = new google.maps.Marker({
            position: { lat: property.latitude, lng: property.longitude },
            map,
            title: property.addressLine1,
            opacity: flagged ? 0.45 : 1,
            icon: {
              url: "/images/map-pin-icon.png",
              scaledSize: new google.maps.Size(22, 21),
              anchor: new google.maps.Point(11, 10.5),
            },
          });
          marker.addListener("click", () => openPopupFor(property, marker));
          markers.push(marker);
        });
      } catch (err) {
        loadingEl.innerHTML = `<span style="color:#dc2626">${esc(err.message)}</span>`;
        return;
      }
      loadingEl.style.display = "none";
    }

    loadProperties();
  };
})();
