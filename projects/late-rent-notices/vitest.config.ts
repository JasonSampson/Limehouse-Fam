import { defineConfig } from "vitest/config";

// Pure unit tests only — no DB, no network, no .env.test required. This is
// what `npm test` runs by default so anyone can run it with zero setup.
// DB integration tests live under test/db/ and run separately via
// `npm run test:db` (see vitest.config.db.ts) since they require the
// disposable Docker Postgres container to be up.
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
  },
});
