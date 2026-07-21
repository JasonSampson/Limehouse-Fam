import { loadEnv } from "../config/env.js";

export interface GeocodeResult {
  latitude: number;
  longitude: number;
}

// Google Geocoding API — Jason's decided vendor (spec Section 3: "use
// Google's Geocoding API... rather than mixing in a separate geocoding
// provider"). One address in, one lat/lng out, or null if Google couldn't
// resolve it (a bad/incomplete address on file, not necessarily a bug).
export async function geocodeAddress(address: string): Promise<GeocodeResult | null> {
  const env = loadEnv();
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("key", env.GOOGLE_MAPS_API_KEY);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Google Geocoding API returned HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    status: string;
    results: Array<{ geometry: { location: { lat: number; lng: number } } }>;
  };

  if (json.status === "ZERO_RESULTS") return null;
  if (json.status !== "OK") {
    throw new Error(`Google Geocoding API returned status ${json.status}`);
  }
  const first = json.results[0];
  if (!first) return null;
  return { latitude: first.geometry.location.lat, longitude: first.geometry.location.lng };
}
