import type { MigrationBuilder } from "node-pg-migrate";

// Adds the two permission keys the named-neighborhood exclusion tool
// needs, following 0009/0010's pattern. Built by Jarvis directly, once
// Jason confirmed directly (in the live conversation) that he wants this
// feature built despite Mason's Fair Housing objection — see
// Limehouse-Fam/projects/map/docs/spec.md's "Decision Record" and
// governance-review.md for the full history. Both keys are Owner + Admin
// only, per Jason's own words: "I would like who can flip this to be
// Owner and Admin. Currently the only admin is my wife and I trust her
// judgement 100%."
//
// map.area_exclusions.manage — create a named area (draw its boundary),
// edit it while still in shadow mode. This is the everyday action.
//
// map.area_exclusions.activate — the one action that actually matters:
// flipping an area from shadow to active, the single most
// legally-scrutinized action in this entire project per Mason's and
// Asimov's reviews. Kept as its own separate permission key (not folded
// into .manage) specifically so it CAN be restricted further later
// without a schema change, even though today it's granted to the same
// two roles as .manage.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    INSERT INTO permission_catalog (module, feature, action, permission_key, label, sort_order) VALUES
      ('map', 'area_exclusions', 'manage',   'map.area_exclusions.manage',   'Create/edit a named-area exclusion (shadow mode)', 520),
      ('map', 'area_exclusions', 'activate', 'map.area_exclusions.activate', 'Activate a named-area exclusion (shadow -> active)', 530);
  `);

  pgm.sql(`
    INSERT INTO role_template_permissions (role_template_id, permission_key, granted)
    SELECT id, 'map.area_exclusions.manage', true FROM role_templates
    WHERE system_role_key = 'owner' OR name = 'Admin';

    INSERT INTO role_template_permissions (role_template_id, permission_key, granted)
    SELECT id, 'map.area_exclusions.activate', true FROM role_templates
    WHERE system_role_key = 'owner' OR name = 'Admin';
  `);

  pgm.sql(`
    INSERT INTO user_permission_overrides (user_id, permission_key, granted)
    SELECT u.id, 'map.area_exclusions.manage',
           CASE WHEN rt.system_role_key = 'owner' OR rt.name = 'Admin' THEN true ELSE false END
    FROM   users u JOIN role_templates rt ON rt.id = u.role_template_id
    ON CONFLICT (user_id, permission_key) DO UPDATE SET granted = EXCLUDED.granted;

    INSERT INTO user_permission_overrides (user_id, permission_key, granted)
    SELECT u.id, 'map.area_exclusions.activate',
           CASE WHEN rt.system_role_key = 'owner' OR rt.name = 'Admin' THEN true ELSE false END
    FROM   users u JOIN role_templates rt ON rt.id = u.role_template_id
    ON CONFLICT (user_id, permission_key) DO UPDATE SET granted = EXCLUDED.granted;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DELETE FROM permission_catalog WHERE permission_key IN ('map.area_exclusions.manage', 'map.area_exclusions.activate');
  `);
}
