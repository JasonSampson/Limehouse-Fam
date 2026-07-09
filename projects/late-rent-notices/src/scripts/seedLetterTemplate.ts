#!/usr/bin/env node
// One-time setup script: inserts version 1 of the 14-day pay-or-quit
// letter template. Deliberately a script, not a migration — migrations
// create schema/structure; legally-reviewable content (the letter text)
// should be inserted (and re-inserted as new versions) through this kind
// of explicit, re-runnable step so Mason's review and any future template
// edits don't require a schema migration each time.
//
// Run with: npx tsx src/scripts/seedLetterTemplate.ts
//
// IMPORTANT: inserts with is_active = false by default. A human (Jason or
// Mason) must explicitly flip it active after legal review — see the
// --activate flag below, used only once Mason has signed off.
//
// Uses getAppPool() (late_rent_app), not getJobPool() (late_rent_job) —
// late_rent_job only has SELECT on letter_templates (see migration 0018),
// while late_rent_app has SELECT/INSERT/UPDATE (migration 0017). This
// script inserts rows, so it needs the app pool.
import { getAppPool, closePools } from "../db/pool.js";
import {
  INITIAL_TEMPLATE_KEY,
  INITIAL_TEMPLATE_VERSION,
  INITIAL_SUBJECT_LINE,
  INITIAL_BODY_MARKDOWN,
} from "../templates/initialLetterTemplate.js";

async function main(): Promise<void> {
  const pool = getAppPool();
  const activate = process.argv.includes("--activate");

  const systemPm = await pool.query<{ id: number }>(
    "SELECT id FROM pm_users WHERE entra_object_id = 'seed-system-placeholder'"
  );
  if (systemPm.rows.length === 0) {
    throw new Error("Seed placeholder pm_users row not found — run migrations first (0007 creates it).");
  }

  const existing = await pool.query(
    "SELECT id FROM letter_templates WHERE template_key = $1 AND version = $2",
    [INITIAL_TEMPLATE_KEY, INITIAL_TEMPLATE_VERSION]
  );
  if (existing.rows.length > 0) {
    console.log(`Template ${INITIAL_TEMPLATE_KEY} v${INITIAL_TEMPLATE_VERSION} already exists (id=${existing.rows[0].id}). No action taken.`);
    return;
  }

  // Only one row per template_key may have is_active = true (enforced by
  // idx_letter_templates_one_active). Deactivate the current active version
  // first so the insert below doesn't violate that constraint.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (activate) {
      await client.query(
        "UPDATE letter_templates SET is_active = false WHERE template_key = $1 AND is_active = true",
        [INITIAL_TEMPLATE_KEY]
      );
    }
    const result = await client.query<{ id: number }>(
      `INSERT INTO letter_templates (template_key, version, subject_line, body_markdown, is_active, created_by_pm_id, change_summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        INITIAL_TEMPLATE_KEY,
        INITIAL_TEMPLATE_VERSION,
        INITIAL_SUBJECT_LINE,
        INITIAL_BODY_MARKDOWN,
        activate,
        systemPm.rows[0].id,
        "v4: restructured header to a faithful 3-row/2-column TO/FROM table matching the attorney's original document exactly, and removed the invented 'Property:'/'Date of Notice:' lines that never existed in that document. No substantive clause changed; Mason reviewed the header change only.",
      ]
    );
    await client.query("COMMIT");
    console.log(`Inserted letter_templates id=${result.rows[0].id}, is_active=${activate}.`);
    if (!activate) {
      console.log("NOT activated. Mason must review this exact text before re-running with --activate, or activate manually after sign-off.");
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closePools();
  });
