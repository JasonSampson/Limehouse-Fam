import { loadEnv } from "../config/env.js";

// Google Places API (legacy "Place Details") — the simplest fit for what
// the Google Reviews tile needs (current star rating + total review count).
// Deliberately NOT the Google Business Profile API: that one is built for
// managing/replying to individual reviews and requires a separate Google
// approval application; Places API just needs an API key with Places
// enabled, which Jason already has for the Map project.
export interface GoogleReviewSummary {
  rating: number;
  reviewCount: number;
}

export async function fetchGoogleReviewSummary(): Promise<GoogleReviewSummary> {
  const env = loadEnv();
  if (!env.GOOGLE_PLACES_API_KEY || !env.GOOGLE_PLACE_ID) {
    throw new Error("GOOGLE_PLACES_API_KEY / GOOGLE_PLACE_ID not configured.");
  }

  const url = new URL("https://maps.googleapis.com/maps/api/place/details/json");
  url.searchParams.set("place_id", env.GOOGLE_PLACE_ID);
  url.searchParams.set("fields", "rating,user_ratings_total");
  url.searchParams.set("key", env.GOOGLE_PLACES_API_KEY);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Google Places API error ${res.status}`);
  }

  const body = (await res.json()) as {
    status: string;
    error_message?: string;
    result?: { rating?: number; user_ratings_total?: number };
  };

  if (body.status !== "OK") {
    throw new Error(`Google Places API status ${body.status}${body.error_message ? `: ${body.error_message}` : ""}`);
  }

  return {
    rating: body.result?.rating ?? 0,
    reviewCount: body.result?.user_ratings_total ?? 0,
  };
}
