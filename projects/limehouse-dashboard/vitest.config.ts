import { defineConfig } from "vitest/config";

// Pure unit tests only — no DB, no network, no .env required. Matches
// late-rent-notices' vitest.config.ts convention: `npm test` should work
// with zero setup for anyone cloning this repo.
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
  },
});
