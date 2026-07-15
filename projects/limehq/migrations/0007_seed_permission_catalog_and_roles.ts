import type { MigrationBuilder } from "node-pg-migrate";

// Seeds the fixed structural data the application needs to function:
// every permission key and the five starting role templates with their
// default permission grants. No user accounts are seeded here — Jason
// creates those out-of-band after the schema is live.
//
// down() deletes the seeded roles first (which cascades to
// role_template_permissions), then deletes the permission rows.
// If any user account is assigned to a seeded role at rollback time,
// the DELETE on role_templates will fail with a FK violation (RESTRICT),
// which is the correct behaviour — reassign or remove users first.

export async function up(pgm: MigrationBuilder): Promise<void> {
  // ------------------------------------------------------------------ //
  // 1. Permission catalog                                                //
  // ------------------------------------------------------------------ //
  // sort_order groups by module: dashboard = 10–80, late_rent_notices =
  // 100–200, limehq = 300–340. Gaps are intentional — room to insert new
  // permissions without renumbering the whole list.

  pgm.sql(`
    INSERT INTO permission_catalog (module, feature, action, permission_key, label, sort_order) VALUES
      -- dashboard
      ('dashboard', 'financials',         'view', 'dashboard.financials.view',         'View Financials',              10),
      ('dashboard', 'occupancy',          'view', 'dashboard.occupancy.view',           'View Occupancy',               20),
      ('dashboard', 'marketing_showings', 'view', 'dashboard.marketing_showings.view',  'View Marketing & Showings',    30),
      ('dashboard', 'drilldowns',         'view', 'dashboard.drilldowns.view',          'View Drilldowns',              40),
      ('dashboard', 'ceo_view',           'view', 'dashboard.ceo_view.view',            'View CEO View',                50),
      ('dashboard', 'team_performance',   'view', 'dashboard.team_performance.view',    'View Team Performance',        60),
      ('dashboard', 'staff_management',   'view', 'dashboard.staff_management.view',    'View Staff Management',        70),
      ('dashboard', 'staff_management',   'edit', 'dashboard.staff_management.edit',    'Edit Staff',                   80),
      -- late_rent_notices
      ('late_rent_notices', 'notices',             'view', 'late_rent_notices.notices.view',             'View Notices',                          100),
      ('late_rent_notices', 'notices',             'edit', 'late_rent_notices.notices.edit',             'Edit Notices',                          110),
      ('late_rent_notices', 'notices',             'send', 'late_rent_notices.notices.send',             'Send Notices',                          120),
      ('late_rent_notices', 'delinquency_config',  'view', 'late_rent_notices.delinquency_config.view',  'View Delinquency Config',               130),
      ('late_rent_notices', 'delinquency_config',  'edit', 'late_rent_notices.delinquency_config.edit',  'Edit Delinquency Config',               140),
      ('late_rent_notices', 'ledgers',             'view', 'late_rent_notices.ledgers.view',             'View Ledgers',                          150),
      ('late_rent_notices', 'ledgers',             'edit', 'late_rent_notices.ledgers.edit',             'Edit Ledgers (Admin/Bookkeeper Only)',   160),
      ('late_rent_notices', 'pm_assignments',      'view', 'late_rent_notices.pm_assignments.view',      'View PM Assignments',                   170),
      ('late_rent_notices', 'pm_assignments',      'edit', 'late_rent_notices.pm_assignments.edit',      'Edit PM Assignments',                   180),
      ('late_rent_notices', 'staff_management',    'view', 'late_rent_notices.staff_management.view',    'View Staff (Late Rent Notices)',         190),
      ('late_rent_notices', 'staff_management',    'edit', 'late_rent_notices.staff_management.edit',    'Edit Staff (Late Rent Notices)',         200),
      -- limehq
      ('limehq', 'staff_management', 'view',   'limehq.staff_management.view',   'View Staff',   300),
      ('limehq', 'staff_management', 'edit',   'limehq.staff_management.edit',   'Edit Staff',   310),
      ('limehq', 'staff_management', 'delete', 'limehq.staff_management.delete', 'Delete Staff', 320),
      ('limehq', 'role_management',  'view',   'limehq.role_management.view',    'View Roles',   330),
      ('limehq', 'role_management',  'edit',   'limehq.role_management.edit',    'Edit Roles',   340);
  `);

  // ------------------------------------------------------------------ //
  // 2. Role templates                                                    //
  // ------------------------------------------------------------------ //

  pgm.sql(`
    INSERT INTO role_templates (name, description, is_system_default, system_role_key) VALUES
      (
        'Owner',
        'Full access to every feature. This role cannot be edited or deleted.',
        true,
        'owner'
      ),
      (
        'Admin',
        'Full access to every feature including managing roles and permissions for all other staff. Cannot edit or delete the Owner role.',
        false,
        NULL
      ),
      (
        'Bookkeeper',
        'Full dashboard access plus ledger read/edit and basic notice access.',
        false,
        NULL
      ),
      (
        'Property Manager',
        'Manages day-to-day notices and leases. Can send notices and edit PM assignments. No ledger write access.',
        false,
        NULL
      ),
      (
        'Assistant Property Manager',
        'Same as Property Manager but cannot send notices and has no access to delinquency config.',
        false,
        NULL
      ),
      (
        'Marketing Coordinator',
        'Read-only access to occupancy and marketing/showings data.',
        false,
        NULL
      ),
      (
        'Admin Assistant',
        'Same as Assistant Property Manager: core dashboard views, can view and edit notices, view ledgers and PM assignments. Cannot send notices.',
        false,
        NULL
      );
  `);

  // ------------------------------------------------------------------ //
  // 3. Role permission grants                                            //
  // ------------------------------------------------------------------ //
  // Each block uses a cross join between the role and a VALUES list of
  // permission keys so IDs never need to be hardcoded.

  // Owner — all permissions.
  pgm.sql(`
    INSERT INTO role_template_permissions (role_template_id, permission_key, granted)
    SELECT r.id, pc.permission_key, true
    FROM role_templates r
    CROSS JOIN permission_catalog pc
    WHERE r.name = 'Owner';
  `);

  // Admin — all permissions. Cannot edit/delete the Owner role or account,
  // but that restriction is enforced in code, not by withheld permissions.
  pgm.sql(`
    INSERT INTO role_template_permissions (role_template_id, permission_key, granted)
    SELECT r.id, pc.permission_key, true
    FROM role_templates r
    CROSS JOIN permission_catalog pc
    WHERE r.name = 'Admin';
  `);

  // Bookkeeper — all dashboard permissions, all ledger permissions,
  // notices view + send, and limehq staff view.
  pgm.sql(`
    INSERT INTO role_template_permissions (role_template_id, permission_key, granted)
    SELECT r.id, k.pkey, true
    FROM role_templates r
    CROSS JOIN (VALUES
      ('dashboard.financials.view'),
      ('dashboard.occupancy.view'),
      ('dashboard.marketing_showings.view'),
      ('dashboard.drilldowns.view'),
      ('dashboard.ceo_view.view'),
      ('dashboard.team_performance.view'),
      ('dashboard.staff_management.view'),
      ('dashboard.staff_management.edit'),
      ('late_rent_notices.ledgers.view'),
      ('late_rent_notices.ledgers.edit'),
      ('late_rent_notices.notices.view'),
      ('late_rent_notices.notices.send'),
      ('limehq.staff_management.view')
    ) AS k(pkey)
    WHERE r.name = 'Bookkeeper';
  `);

  // Property Manager — core dashboard views (no CEO view, no staff mgmt),
  // full notice lifecycle, ledger view, PM assignment read/write, staff view.
  pgm.sql(`
    INSERT INTO role_template_permissions (role_template_id, permission_key, granted)
    SELECT r.id, k.pkey, true
    FROM role_templates r
    CROSS JOIN (VALUES
      ('dashboard.financials.view'),
      ('dashboard.occupancy.view'),
      ('dashboard.marketing_showings.view'),
      ('dashboard.drilldowns.view'),
      ('dashboard.team_performance.view'),
      ('late_rent_notices.notices.view'),
      ('late_rent_notices.notices.edit'),
      ('late_rent_notices.notices.send'),
      ('late_rent_notices.ledgers.view'),
      ('late_rent_notices.pm_assignments.view'),
      ('late_rent_notices.pm_assignments.edit'),
      ('limehq.staff_management.view')
    ) AS k(pkey)
    WHERE r.name = 'Property Manager';
  `);

  // Assistant Property Manager — like PM but no notice send and no
  // delinquency config, and no PM assignment write.
  pgm.sql(`
    INSERT INTO role_template_permissions (role_template_id, permission_key, granted)
    SELECT r.id, k.pkey, true
    FROM role_templates r
    CROSS JOIN (VALUES
      ('dashboard.financials.view'),
      ('dashboard.occupancy.view'),
      ('dashboard.marketing_showings.view'),
      ('dashboard.drilldowns.view'),
      ('late_rent_notices.notices.view'),
      ('late_rent_notices.notices.edit'),
      ('late_rent_notices.ledgers.view'),
      ('late_rent_notices.pm_assignments.view'),
      ('limehq.staff_management.view')
    ) AS k(pkey)
    WHERE r.name = 'Assistant Property Manager';
  `);

  // Marketing Coordinator — read-only, marketing and occupancy only.
  pgm.sql(`
    INSERT INTO role_template_permissions (role_template_id, permission_key, granted)
    SELECT r.id, k.pkey, true
    FROM role_templates r
    CROSS JOIN (VALUES
      ('dashboard.occupancy.view'),
      ('dashboard.marketing_showings.view')
    ) AS k(pkey)
    WHERE r.name = 'Marketing Coordinator';
  `);

  // Admin Assistant — same permissions as Assistant Property Manager.
  pgm.sql(`
    INSERT INTO role_template_permissions (role_template_id, permission_key, granted)
    SELECT r.id, k.pkey, true
    FROM role_templates r
    CROSS JOIN (VALUES
      ('dashboard.financials.view'),
      ('dashboard.occupancy.view'),
      ('dashboard.marketing_showings.view'),
      ('dashboard.drilldowns.view'),
      ('late_rent_notices.notices.view'),
      ('late_rent_notices.notices.edit'),
      ('late_rent_notices.ledgers.view'),
      ('late_rent_notices.pm_assignments.view'),
      ('limehq.staff_management.view')
    ) AS k(pkey)
    WHERE r.name = 'Admin Assistant';
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Delete roles first — cascades to role_template_permissions via the
  // role_template_id FK. If any user is still assigned to a seeded role,
  // the users.role_template_id RESTRICT FK will surface a hard error here,
  // which is intentional: reassign or remove those users before rolling back.
  pgm.sql(`
    DELETE FROM role_templates
    WHERE name IN (
      'Owner',
      'Admin',
      'Bookkeeper',
      'Property Manager',
      'Assistant Property Manager',
      'Marketing Coordinator',
      'Admin Assistant'
    );
  `);

  // Delete the permission rows. Any orphaned role_template_permissions rows
  // (there should be none after the above) would also cascade out here.
  pgm.sql(`
    DELETE FROM permission_catalog
    WHERE module IN ('dashboard', 'late_rent_notices', 'limehq');
  `);
}
