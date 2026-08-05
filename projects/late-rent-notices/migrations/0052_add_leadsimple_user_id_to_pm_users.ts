import type { MigrationBuilder } from "node-pg-migrate";

// Jason's correction, 2026-08-05: notices sent by Dana were mirrored to
// LeadSimple as notes always attributed to Jason (the LeadSimple API
// key's own owner), regardless of who actually sent the notice. LeadSimple
// documents a `user_id` formData field on POST /notes ("User to assign
// the note activity to" — confirmed against the live swagger spec at
// https://api.leadsimple.com/rest/swagger_doc.json), so this is fixable
// per-note rather than being a fixed limitation of the single API key.
// Nullable: not every pm_users row will have a matching LeadSimple
// account (e.g. the TARS QA test account) — mirrorNoticeToLeadSimple
// falls back to leaving user_id unset (LeadSimple's own default
// attribution) when null, exactly like today's behavior, rather than
// failing the mirror.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("pm_users", {
    leadsimple_user_id: { type: "text" },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn("pm_users", "leadsimple_user_id");
}
