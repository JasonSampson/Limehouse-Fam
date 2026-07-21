import { defineConfig } from "vitest/config";

// Pure unit tests only — no DB, no network, no .env required. DB/live-API
// integration tests are TARS's job once a real Supabase project and
// Buildium sandbox access exist for Map (see final report to Jason).
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
  },
});
