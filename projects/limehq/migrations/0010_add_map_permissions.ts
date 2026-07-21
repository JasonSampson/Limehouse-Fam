import type { MigrationBuilder } from "node-pg-migrate";

// Adds Map (internal + public coverage-area map) to the permission catalog.
// Everyone gets to view the internal map — it's a normal staff tool, not a
// restricted one (mirrors Limona's limona.chat.access). Only Owner + Admin
// can flag/unflag a property as "do not pursue" (the four condition-based
// reason codes Asimov's governance-review.md approved to build).
//
// NOT included in this migration, on purpose: permission keys for the
// named-area exclusion tool (e.g. map.area_exclusions.manage/.activate) or
// for a staff_safety_concern-specific permission. Those two features
// aren't part of Map's schema yet — Neo declined to design their tables
// without Jason confirming directly, in his own words, that he wants them
// despite Mason's Fair Housing objection (schema.md), and Asimov's review
// independently asked for the same direct, non-relayed confirmation. Adding
// permission keys for features that don't exist yet would be dead catalog
// entries; both should land together, once (and if) the underlying tables
// do, per schema.md's own note.
export async function up(pgm: MigrationBuilder): Promise<void> {
  // 1. Add to permission catalog
  pgm.sql(`
    INSERT INTO permission_catalog (module, feature, action, permission_key, label, sort_order) VALUES
      ('map', 'properties', 'view',   'map.properties.view',   'View internal Map',                    500),
      ('map', 'exclusions', 'manage', 'map.exclusions.manage', 'Flag/unflag a property (do not pursue)', 510);
  `);

  // 2. Update role templates: everyone gets view access, only owner+admin
  //    get exclusion management.
  pgm.sql(`
    INSERT INTO role_template_permissions (role_template_id, permission_key, granted)
    SELECT id, 'map.properties.view', true FROM role_templates;

    INSERT INTO role_template_permissions (role_template_id, permission_key, granted)
    SELECT id, 'map.exclusions.manage', true FROM role_templates
    WHERE system_role_key = 'owner' OR name = 'Admin';
  `);

  // 3. Seed existing users in user_permission_overrides
  pgm.sql(`
    -- Everyone gets to view the internal map (can be toggled off per
    -- person on their permissions page).
    INSERT INTO user_permission_overrides (user_id, permission_key, granted)
    SELECT id, 'map.properties.view', true FROM users
    ON CONFLICT (user_id, permission_key) DO UPDATE SET granted = true;

    -- Only owner + admin can flag/unflag a property.
    INSERT INTO user_permission_overrides (user_id, permission_key, granted)
    SELECT u.id, 'map.exclusions.manage',
           CASE WHEN rt.system_role_key = 'owner' OR rt.name = 'Admin' THEN true ELSE false END
    FROM   users u JOIN role_templates rt ON rt.id = u.role_template_id
    ON CONFLICT (user_id, permission_key) DO UPDATE SET granted = EXCLUDED.granted;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Deleting from permission_catalog cascades to role_template_permissions
  // and user_permission_overrides via FK constraints.
  pgm.sql(`
    DELETE FROM permission_catalog WHERE module = 'map';
  `);
}
