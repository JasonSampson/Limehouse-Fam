import { defineConfig } from "vitest/config";

// DB integration tests — require a real Postgres with the pgvector
// extension available, fully migrated (npm run migrate:up), and pointed at
// by DATABASE_URL (use a disposable test database, never production).
// Run with: npm run test:db
//
// fileParallelism is disabled: every file in test/db/ shares the same
// database and several files TRUNCATE tables in beforeEach/beforeAll —
// running files concurrently would let one file's truncate wipe out
// another file's fixtures mid-run.
export default defineConfig({
  test: {
    include: ["test/db/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
