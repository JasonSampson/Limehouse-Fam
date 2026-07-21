// Standard ray-casting point-in-polygon test. No PostGIS dependency —
// per Jason's correction (zip code is "too broad," an admin-drawn boundary
// on the map is the actual mechanism), this runs in plain application code
// against a property's own geocoded lat/lng, not in SQL.

export interface LatLng {
  lat: number;
  lng: number;
}

// Treats lng as x and lat as y — fine at the scale of a single Hampton
// Roads neighborhood; this is not meant to handle polygons that cross the
// antimeridian or span a large fraction of the globe.
export function isPointInPolygon(point: LatLng, polygon: LatLng[]): boolean {
  if (polygon.length < 3) {
    throw new Error(`A polygon needs at least 3 points to enclose any area; got ${polygon.length}.`);
  }

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const vertexI = polygon[i]!;
    const vertexJ = polygon[j]!;

    const intersects =
      vertexI.lat > point.lat !== vertexJ.lat > point.lat &&
      point.lng <
        ((vertexJ.lng - vertexI.lng) * (point.lat - vertexI.lat)) / (vertexJ.lat - vertexI.lat) +
          vertexI.lng;

    if (intersects) inside = !inside;
  }
  return inside;
}

// Validates a boundary as stored in map.named_area_exclusions.boundary
// (JSONB) — the migration can only check "is this valid JSON," not "is
// this a sane polygon," so that check lives here, called wherever a
// boundary is accepted from a staff member (Tron's future UI) or read
// back out for matching.
export function validateBoundary(value: unknown): LatLng[] {
  if (!Array.isArray(value)) {
    throw new Error("A boundary must be an array of {lat, lng} points.");
  }
  if (value.length < 3) {
    throw new Error(`A boundary needs at least 3 points to enclose any area; got ${value.length}.`);
  }

  return value.map((point, index) => {
    if (
      typeof point !== "object" ||
      point === null ||
      typeof (point as Record<string, unknown>).lat !== "number" ||
      typeof (point as Record<string, unknown>).lng !== "number"
    ) {
      throw new Error(`Boundary point at index ${index} is not a valid {lat, lng} pair.`);
    }
    const lat = (point as { lat: number }).lat;
    const lng = (point as { lng: number }).lng;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new Error(`Boundary point at index ${index} has an out-of-range coordinate: (${lat}, ${lng}).`);
    }
    return { lat, lng };
  });
}
