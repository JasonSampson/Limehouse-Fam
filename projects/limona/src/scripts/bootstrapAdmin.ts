import bcrypt from "bcryptjs";
import { getPool, closePool } from "../db/pool.js";
import { loadEnv } from "../config/env.js";

// There is no signup flow (invite-only per the approved spec), so the very
// first admin account — Jason's — has to be created some other way. This
// script is that "other way": run once after migrations, before anyone logs
// in. Safe to re-run — it upserts by email rather than erroring on a
// duplicate, so re-running it (e.g. to reset a forgotten password) is fine.
//
// Usage: npm run bootstrap-admin -- --email you@company.com --name "Jason Sampson" --password "..."
async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const email = get("--email");
  const name = get("--name");
  const password = get("--password");

  if (!email || !name || !password) {
    console.error(
      'Usage: npm run bootstrap-admin -- --email you@company.com --name "Your Name" --password "yourpassword"'
    );
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const pool = getPool();

  const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);

  if (existing.rows.length > 0) {
    await pool.query(
      "UPDATE users SET password_hash = $1, name = $2, role = 'admin', status = 'active' WHERE email = $3",
      [passwordHash, name, email.toLowerCase()]
    );
    console.log(`Updated existing user "${email}" to an active admin.`);
  } else {
    await pool.query(
      "INSERT INTO users (email, name, role, password_hash, status) VALUES ($1, $2, 'admin', $3, 'active')",
      [email.toLowerCase(), name, passwordHash]
    );
    console.log(`Created admin account for "${email}".`);
  }

  await closePool();
}

main().catch((err) => {
  console.error("Bootstrap failed:", err);
  process.exit(1);
});
