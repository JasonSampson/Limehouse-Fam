import type { MigrationBuilder } from "node-pg-migrate";

// Adds Limona (internal AI chatbot) to the permission catalog.
// All roles get chat access. Only owner and Admin can manage documents
// or contribute answers to questions Limona couldn't answer.
// Existing users are seeded into user_permission_overrides based on their
// current role. New users start with no Limona permissions until granted.
export async function up(pgm: MigrationBuilder): Promise<void> {
  // 1. Add to permission catalog
  pgm.sql(`
    INSERT INTO permission_catalog (module, feature, action, permission_key, label, sort_order) VALUES
      ('limona', 'chat',      'access',    'limona.chat.access',          'Use Limona',                   400),
      ('limona', 'documents', 'manage',    'limona.documents.manage',     'Manage Limona Documents',      410),
      ('limona', 'answers',   'contribute','limona.answers.contribute',   'Add Answers to Limona',        420);
  `);

  // 2. Update role templates: everyone gets chat, only owner+admin get the rest
  pgm.sql(`
    INSERT INTO role_template_permissions (role_template_id, permission_key, granted)
    SELECT id, 'limona.chat.access', true FROM role_templates;

    INSERT INTO role_template_permissions (role_template_id, permission_key, granted)
    SELECT id, 'limona.documents.manage', true FROM role_templates
    WHERE system_role_key = 'owner' OR name = 'Admin';

    INSERT INTO role_template_permissions (role_template_id, permission_key, granted)
    SELECT id, 'limona.answers.contribute', true FROM role_templates
    WHERE system_role_key = 'owner' OR name = 'Admin';
  `);

  // 3. Seed existing users in user_permission_overrides
  pgm.sql(`
    -- Everyone gets chat access (can be toggled off per person on their permissions page)
    INSERT INTO user_permission_overrides (user_id, permission_key, granted)
    SELECT id, 'limona.chat.access', true FROM users
    ON CONFLICT (user_id, permission_key) DO UPDATE SET granted = true;

    -- Only owner + admin get document management
    INSERT INTO user_permission_overrides (user_id, permission_key, granted)
    SELECT u.id, 'limona.documents.manage',
           CASE WHEN rt.system_role_key = 'owner' OR rt.name = 'Admin' THEN true ELSE false END
    FROM   users u JOIN role_templates rt ON rt.id = u.role_template_id
    ON CONFLICT (user_id, permission_key) DO UPDATE SET granted = EXCLUDED.granted;

    -- Only owner + admin can contribute answers
    INSERT INTO user_permission_overrides (user_id, permission_key, granted)
    SELECT u.id, 'limona.answers.contribute',
           CASE WHEN rt.system_role_key = 'owner' OR rt.name = 'Admin' THEN true ELSE false END
    FROM   users u JOIN role_templates rt ON rt.id = u.role_template_id
    ON CONFLICT (user_id, permission_key) DO UPDATE SET granted = EXCLUDED.granted;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Deleting from permission_catalog cascades to role_template_permissions
  // and user_permission_overrides via FK constraints.
  pgm.sql(`
    DELETE FROM permission_catalog WHERE module = 'limona';
  `);
}
