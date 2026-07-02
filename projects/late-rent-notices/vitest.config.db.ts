import { defineConfig } from "vitest/config";

// DB integration tests — require the disposable test Postgres container
// (late_rent_notices_test_pg, port 55432) to be running and fully migrated.
// Run with: npm run test:db
// Check the container first with: docker ps --filter name=late_rent_notices_test_pg
// If it's gone, recreate it (see README "Test database" section) and run
// `npm run migrate:up` with .env.test loaded before running these tests.
//
// Run with fileParallelism disabled: every file in test/db/ shares the same
// Postgres database, and several files TRUNCATE all tables in beforeAll —
// running test files concurrently would let one file's truncate wipe out
// another file's fixtures mid-run.
export default defineConfig({
  test: {
    include: ["test/db/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
