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
import { getJobPool, closePools } from "../db/pool.js";
import {
  INITIAL_TEMPLATE_KEY,
  INITIAL_TEMPLATE_VERSION,
  INITIAL_SUBJECT_LINE,
  INITIAL_BODY_MARKDOWN,
} from "../templates/initialLetterTemplate.js";

async function main(): Promise<void> {
  const pool = getJobPool();
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

  const result = await pool.query<{ id: number }>(
    `INSERT INTO letter_templates (template_key, version, subject_line, body_markdown, is_active, created_by_pm_id, change_summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      INITIAL_TEMPLATE_KEY,
      INITIAL_TEMPLATE_VERSION,
      INITIAL_SUBJECT_LINE,
      INITIAL_BODY_MARKDOWN,
      activate,
      systemPm.rows[0].id,
      "Initial version: corrected certification clause (emailed, not mailed) and corrected payment instructions (Buildium portal credit card or certified funds at office) per binding plan.",
    ]
  );

  console.log(`Inserted letter_templates id=${result.rows[0].id}, is_active=${activate}.`);
  if (!activate) {
    console.log("NOT activated. Mason must review this exact text before re-running with --activate, or activate manually after sign-off.");
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
