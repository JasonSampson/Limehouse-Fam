// Public coverage-area map (limehousepm.com). Deliberately its own separate,
// minimal script — does NOT import or reuse anything from LimeHQ's internal
// map-internal.js. No login, no popups, no address search (spec.md: "no
// addresses, no names, no photos... nothing private to protect by
// requiring one"). The only data this page can ever receive is whatever
// map_public.locations_public returns (city, latitude, longitude,
// neighborhood_label) — there is no code path here that could show more,
// because this script never talks to anything but that one Supabase view.

(function () {
  const HAMPTON_ROADS_BOUNDS = { north: 37.05, south: 36.55, east: -75.95, west: -76.75 };

  const OCEAN_BLUE_STYLE = [
    { elementType: "geometry", stylers: [{ color: "#eef3f7" }] },
    { elementType: "labels.text.fill", stylers: [{ color: "#4a5a68" }] },
    { elementType: "labels.text.stroke", stylers: [{ color: "#ffffff" }] },
    { featureType: "water", elementType: "geometry", stylers: [{ color: "#8fc1e3" }] },
    { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#2c6f9b" }] },
    { featureType: "landscape", elementType: "geometry", stylers: [{ color: "#eef3f7" }] },
    { featureType: "poi", elementType: "geometry", stylers: [{ color: "#dde8ea" }] },
    { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#d5e8d4" }] },
    { featureType: "road", elementType: "geometry", stylers: [{ color: "#ffffff" }] },
    { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#cfe0ea" }] },
    { featureType: "administrative", elementType: "geometry.stroke", stylers: [{ color: "#a9c6d6" }] },
    { featureType: "transit", stylers: [{ visibility: "off" }] },
    { featureType: "poi.business", stylers: [{ visibility: "off" }] },
  ];

  async function fetchPublicDots() {
    const cfg = window.MAP_PUBLIC_CONFIG;
    const url = `${cfg.SUPABASE_URL}/rest/v1/locations_public?select=city,latitude,longitude,neighborhood_label`;
    const res = await fetch(url, {
      headers: {
        apikey: cfg.SUPABASE_ANON_KEY,
        authorization: `Bearer ${cfg.SUPABASE_ANON_KEY}`,
        // locations_public lives in the map_public schema, not PostgREST's
        // default `public` schema — Accept-Profile picks which exposed
        // schema this request targets. Supabase's Data API must have
        // map_public listed under "Exposed schemas" or this 404s.
        "Accept-Profile": "map_public",
      },
    });
    if (!res.ok) {
      throw new Error(`Could not load coverage data (HTTP ${res.status}).`);
    }
    return res.json();
  }

  window.publicMapInit = async function () {
    const canvas = document.getElementById("public-map");
    const map = new google.maps.Map(canvas, {
      center: { lat: 36.82, lng: -76.35 },
      zoom: 10,
      minZoom: 9,
      styles: OCEAN_BLUE_STYLE,
      streetViewControl: false,
      mapTypeControl: false,
      fullscreenControl: false,
      restriction: {
        latLngBounds: HAMPTON_ROADS_BOUNDS,
        strictBounds: false,
      },
    });

    const legend = document.createElement("div");
    legend.className = "legend";
    legend.innerHTML = '<span class="legend-dot"></span> A Limehouse-managed property (past or present)';
    document.getElementById("map-wrap").appendChild(legend);

    const stateMsg = document.createElement("div");
    stateMsg.className = "state-msg";
    stateMsg.textContent = "Loading coverage map…";
    document.getElementById("map-wrap").appendChild(stateMsg);

    try {
      const dots = await fetchPublicDots();
      stateMsg.remove();
      dots.forEach((d) => {
        // Deliberately a plain, non-interactive circle — no click handler,
        // no InfoWindow, no tooltip carrying anything beyond what's already
        // on screen. There is nothing more to show even if we wanted to:
        // this response only ever contains city/lat/lng/neighborhood_label.
        new google.maps.Marker({
          position: { lat: Number(d.latitude), lng: Number(d.longitude) },
          map,
          clickable: false,
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 5,
            fillColor: "#74b62e",
            fillOpacity: 0.85,
            strokeColor: "#ffffff",
            strokeWeight: 1,
          },
        });
      });
    } catch (err) {
      stateMsg.textContent = "Coverage map is temporarily unavailable.";
      // Fails safe and quiet — a visitor sees an empty-but-working map
      // rather than an error dump; this is a marketing page, not a tool a
      // staff member depends on, so there's no alerting hookup here.
      console.warn("Public map:", err);
    }
  };
})();
