# LimeHQ — Login & Permissions Spec (Oracle, 2026-07-16)

This is LimeHQ's founding spec: the shared username/password login and
Buildium-style role/permission system for the whole Limehouse hub. It was
originally written while this work was still living inside the
`limehouse-dashboard` project, before Jason decided LimeHQ should be its
own first-class project — the front door and launcher for every tool
(Dashboard, Late Rent Notices, and future modules like the Docusign,
Calendly, Jotform, and LeadSimple replacements).

Next step per the standard pipeline: Neo designs the concrete schema from
Section 4–5 below, then Q builds it, with Sentinel's review items from
Section 9 gated before go-live.

---

## Plain-English Summary

Right now, staff log into both the Dashboard and the Late Rent Notices tool
by clicking "Sign in with Microsoft." That's broken — the Late Rent Notices
tool was never fully connected to Microsoft's login system (the settings
file still has placeholder values that were never filled in), and more
broadly, setting up and maintaining "Sign in with Microsoft" for every new
tool is more hassle than it's worth for a 7-person team.

This spec replaces that with a login system Limehouse owns outright: each
staff member gets a username (their email) and a password, stored securely
on Limehouse's own server — no Microsoft account required. Alongside that,
it adds a real permissions system modeled on the one Jason already uses and
likes in Buildium: named roles (Administrator, Property Manager,
Bookkeeper, etc.), each with a checklist of what that role can View, Edit,
or Delete across every screen in every tool. Any one person's access can
also be hand-tuned beyond their role without changing the role itself —
same as Buildium's "(Edited)" role feature.

One rule is baked in and cannot be checked around: no matter what any role
or override says, only people in the Administrator or Bookkeeper role can
ever edit a tenant or owner ledger. Everyone else can look, but not touch.
This is enforced by the software itself, not just by what boxes happen to
be checked.

This does **not** touch how the Late Rent Notices tool sends the actual
legal notice emails to tenants — that uses a completely separate Microsoft
connection tied to the shared compliance mailbox, and it stays exactly
as-is.

LimeHQ itself is the actual product this becomes: one place staff log into
once, see everything they have access to, and launch into whichever
finished project they need. Each project then runs on its own from there —
LimeHQ hands off a session, it doesn't stay in the loop on every click.

**What could go wrong:** (1) Passwords, unlike Microsoft's login, need
Limehouse's own protection against people guessing them — this spec
includes a basic lockout after repeated wrong attempts. (2) Someone could,
in theory, mis-click a permissions checkbox and accidentally grant
ledger-editing to the wrong person — the hard-coded Ledger Edit Lock is
specifically there to prevent that mistake from ever taking effect,
regardless of what's checked. (3) Migrating two separate tools' logins
carries some coordination risk — the plan below is built so nothing goes
down while this is built and tested.

---

## 1. What Was Read First (for the original two-project version of this spec)

Both apps' current auth code:
- `late-rent-notices`: `src/auth/entra.ts`, `src/auth/session.ts`,
  `src/routes/authRoutes.ts`, `src/routes/requireSession.ts`,
  `src/auth/requireFreshReauth.ts`, `src/db/withPmScope.ts`,
  `src/config/env.ts`, `.env.example`, migrations `0001`, `0017`, `0026`,
  `0032`.
- `limehouse-dashboard`: `src/auth/entra.ts`, `src/auth/session.ts`,
  `src/api/authRoutes.ts`, `src/auth/loginResolver.ts`,
  `src/db/staffUsers.ts`, `src/config/env.ts`, `.env.example`, migrations
  `0006`, `0007`, and the route files (`dashboardRoutes.ts`,
  `ceoViewRoutes.ts`, `teamPerformanceRoutes.ts`, `staffUsersRoutes.ts`).

Confirmed the reported bug: `late-rent-notices/.env.example` shows
`ENTRA_TENANT_ID=CHANGE_ME` etc. — those were never replaced with a real
Azure app registration, so `entra.ts`'s JWKS/token-exchange calls fail
against Microsoft.

---

## 2. Architecture Decision

**Recommendation: no centralized auth network service. Each app keeps its
own local users/roles/permissions tables in its own existing Postgres
database. "One shared role system" is delivered through shared *code* and
a shared *management flow*, not a shared *runtime service*.**

Why, concretely, based on what's actually in this codebase:

- `late-rent-notices`'s entire security model is built on Postgres Row-
  Level Security keyed off a **local** `pm_users` table.
  `src/db/withPmScope.ts` sets `app.current_pm_id` and `app.pm_role` as
  Postgres session variables on every request, and RLS policies (migrations
  `0016`, `0019`, `0027`, `0033`, `0036`, `0037`...) read those variables
  directly. Postgres RLS policies can't reach across a physical database
  boundary without extra infrastructure (`postgres_fdw`) — so pointing this
  at a separate "auth database" would mean either bolting on that extra
  infra, or replicating user rows locally anyway. Either way, a network
  auth service buys nothing here; the RLS engine still needs a local row to
  check against.
- A real network auth service is a *third deployable* Scotty has to build,
  monitor, and keep up — for 7 users. And it introduces a new failure mode
  that doesn't exist today: if that service is down, **both** apps go
  down, even though today they're fully independent (each has
  crashed/deployed separately without affecting the other).
- The "one shared role system" goal is really about **not defining the
  same role twice by hand in two different admin screens that drift
  apart.** That's solved by: (a) one shared code module in the monorepo
  that defines the schema shape, the password/session/permission-check
  logic *once* (this also satisfies the standing rule against duplicating
  security logic), used by every app's migrations and code; and (b) one
  shared **management flow**: LimeHQ owns the actual login page and the
  "Manage Staff" screen. Creating or editing a staff member's account/role
  there pushes the same user + role + permission data to whichever
  app(s) that person needs, via narrow internal endpoints each app exposes
  to LimeHQ (`create-or-update-user`, `deactivate-user`). This is not a
  general auth service — it's only called on account changes (rare),
  never on login or permission checks (every request), so each app's
  day-to-day operation stays fully independent once a session is issued.

**LimeHQ's actual role, now that it's its own project:** LimeHQ is the
literal front door. Staff log in at LimeHQ once; LimeHQ shows them tiles
for every project they have access to; clicking a tile hands that
project a signed, short-lived token proving who the person is and what
role they hold, which the target project exchanges for its own local
session (mirroring how Entra SSO worked before — LimeHQ plays the role
Microsoft used to play, just self-hosted). After that handoff, the target
project runs fully independently on its own session until it expires,
exactly as described above — LimeHQ is not in the request path for every
subsequent click.

**Structural note for Scotty/Neo:** LimeHQ, `late-rent-notices`, and
`limehouse-dashboard` are three separate worktrees of the same monorepo,
each on its own branch (`feature/limehq`, `feature/late-rent-notices`,
`feature/limehouse-dashboard`). A shared code module needs to land
somewhere every branch can see it — either merged to `main` first, or
added to each branch in parallel. Confirm actual placement (e.g.
`packages/auth-core/` at the monorepo root) with Scotty before building.

---

## 3. Permission-Key Scheme

Format: **`module.feature.action`** — e.g. `dashboard.financials.view`,
`late_rent_notices.ledgers.edit`, `late_rent_notices.notices.send`.

- **module** — which project: `dashboard`, `late_rent_notices`, `limehq`
  itself (for its own Manage Staff screen), and future modules added
  later.
- **feature** — the area within it. Starting catalog, based on what's
  actually built today:
  - `dashboard`: `financials`, `occupancy`, `marketing_showings`,
    `drilldowns`, `ceo_view`, `team_performance`, `staff_management`
  - `late_rent_notices`: `notices`, `delinquency_config`, `ledgers`,
    `pm_assignments`, `staff_management`
  - `limehq`: `staff_management`, `role_management`
- **action** — not fixed to exactly View/Edit/Delete. Most features only
  need the actions that make sense for them (e.g. `dashboard.financials`
  may only ever need `.view` — nothing there is "edited").
  `late_rent_notices.notices` needs a `.send` action distinct from
  `.edit`, since drafting/editing a notice and actually sending it to a
  tenant are different levels of authority today.

This lives as **metadata rows** (module, feature, action, label, sort
order) — call it `permission_catalog` — not as columns or an enum. Adding
a new module or screen later is an `INSERT`, never an `ALTER TABLE`. This
directly satisfies the "no migration per new module" requirement.

The role-editing grid (the Buildium-style UI, which lives in LimeHQ) is
just this catalog rendered as rows, grouped by module → feature, with a
checkbox per action that exists for that feature.

---

## 4. Role Templates, Per-Person Overrides, and Resolution Order

Conceptual shape (Neo owns the literal DDL). Lives in LimeHQ's own
database, since LimeHQ is the system of record for identity/permissions;
each target project caches only what it needs from a session handoff.

- **`role_templates`** — id, name, description, `is_system_default`
  (protects seeded roles from deletion), `system_role_key` (nullable —
  see §5), timestamps.
- **`role_template_permissions`** — (role_template_id, permission_key,
  granted). Absence of a row = not granted (default-deny).
- **`users`** — id, email (unique, case-insensitive), password_hash,
  display_name, role_template_id (**not nullable** — every account has
  exactly one base role), active, last_login_at, timestamps.
- **`user_permission_overrides`** — (user_id, permission_key, granted).
  This is the Buildium "(Edited)" mechanism, but as a lightweight overlay
  table rather than literally cloning the whole role into a new row —
  far less duplicated state, and trivial to answer "why does this person
  have X" (just look at their few override rows) or revert someone to
  plain role defaults (delete their override rows).

**Resolution order for `hasPermission(user, key)`:**
1. If an override row exists for `(user.id, key)`, its value wins — full
   stop.
2. Otherwise, fall back to `role_template_permissions` for the user's
   assigned role. Present + granted = allowed; absent = denied.

This whole check is re-run from the database on **every request** to
whichever project is checking — nothing about role or permissions is
trusted from a session token (see §6).

---

## 5. The Ledger Edit Lock (non-negotiable invariant)

Rule: regardless of role customization or override, only Administrator or
Bookkeeper accounts may ever perform `late_rent_notices.ledgers.edit`.
Everyone else may `.view`.

This must **not** be an emergent property of default checkbox state —
it's enforced as a second, independent, hard-coded gate:

- `role_templates.system_role_key` is a nullable column, set to
  `'administrator'` or `'bookkeeper'` **only** on the two protected seed
  roles. Any custom or cloned role a future admin creates gets `NULL`
  here and can never acquire it through the UI.
- The authorization check for `late_rent_notices.ledgers.edit`
  specifically does this, in code, independent of the normal
  permission-catalog/override lookup:
  ```
  allowed = hasPermission(user, 'late_rent_notices.ledgers.edit')
            AND user.role_template.system_role_key IN ('administrator', 'bookkeeper')
  ```
  Both conditions must hold. If someone fat-fingers an override granting
  `ledgers.edit` to a Portfolio Manager, the second condition still blocks
  it — the checkbox doesn't matter.
- The role-editing UI should also grey out / disable that specific
  checkbox for any role/person that isn't Admin or Bookkeeper, as a
  courtesy (defense in depth) — but the server-side check above is the
  real backstop, and Sentinel should verify the server-side check
  independently of the UI (see §9).

---

## 6. Session / Handoff Design

LimeHQ issues its own session cookie on login (mirrors what both existing
apps already do: `jose`'s `SignJWT`/`jwtVerify`, `httpOnly`/`secure`/
`sameSite: strict`, 8-hour TTL).

**Do not carry role or permission data in any session payload.**
`late-rent-notices`' existing `withPmScope.ts` already does this
correctly — it re-queries `pm_users.role` from the database on every
request rather than trusting anything cached in the token, with the
comment "never taken from anything client-supplied." Every project
(LimeHQ and every target project it hands off to) should follow that same
already-Sentinel-approved pattern, so that if someone is demoted or
deactivated mid-session, it takes effect on their very next request
instead of waiting up to 8 hours for their cookie to expire.

LimeHQ session payload: `{ userId, email, authenticatedAt }`.
`authenticatedAt` is stamped fresh on every login/re-auth.

**Handoff to a target project** (e.g. clicking the Dashboard tile in
LimeHQ): LimeHQ issues a short-lived, single-use signed token
(`{ userId, email, iat, exp }`, TTL on the order of 30–60 seconds) as a
redirect query param to the target project's own callback route. The
target project verifies the signature (shared secret or public key,
Neo/Scotty to decide distribution), then issues its own local session
cookie exactly as it does today — same session shape late-rent-notices
and limehouse-dashboard already use, just populated from LimeHQ's token
instead of from Entra's ID token. This is deliberately the same shape
Entra already had (LimeHQ replaces Microsoft as the identity provider,
each app keeps its own local session afterward).

---

## 7. Password Hashing

**bcrypt**, via `bcryptjs`. Cost factor 12.

**2FA readiness:** nothing needs to be pre-built now. Adding a nullable
column (e.g. a future `totp_secret`) to a Postgres table later is a fast,
non-blocking operation. The one thing that does matter structurally: keep
the login route as two logical steps — (1) verify password, (2) issue
session — rather than one fused function, so a TOTP check can be slotted
between them later without a rewrite.

---

## 8. Fresh-Reauth Replacement

`late-rent-notices/src/auth/requireFreshReauth.ts`'s `isReauthFresh()`
only inspects `session.authenticatedAt` — it needs **no changes at all**.
What changes is how that timestamp gets refreshed: add a small "confirm
your password" step (e.g. a modal, or a dedicated `POST /auth/reauth`
route) that takes the *already-signed-in* user's password, verifies it
against `password_hash`, and on success re-issues the session cookie with
a fresh `authenticatedAt` — replacing today's "redirect through
Microsoft's login page" mechanism with an equivalent password re-entry.
Track this as its own explicit task for Q, not folded silently into
"build login" — it protects the single most consequential action in the
system (the fallback decision-maker send).

---

## 9. What Needs Sentinel's Review Before Neo/Q Proceed Further

1. **The Ledger Edit Lock (§5)** — specifically write an adversarial test:
   grant a non-Admin/Bookkeeper user an override for
   `late_rent_notices.ledgers.edit`, confirm the server still denies the
   edit. This is the highest-stakes single check in the system.
2. **Default-deny behavior** — confirm a permission key with no matching
   role/override row denies access, and that a user can't exist without a
   `role_template_id`.
3. **No role/permission data in any session or handoff token** — audit
   that every route re-checks permissions against the database per
   request rather than trusting a claim (§6).
4. **Password hashing** — cost factor, `password_hash` never returned in
   any API response, never logged.
5. **Brute-force protection on the login route** — Entra offloaded this
   to Microsoft; a self-hosted login needs its own basic lockout/delay
   after repeated failed attempts.
6. **The internal cross-app sync endpoints (§2) and the handoff token
   (§6)** — must be callable/verifiable only by the apps' own backend
   processes (shared secret or signature check), never trusted from a
   browser-supplied value alone, and must not become a side-door around
   normal login. The handoff token specifically must be single-use and
   short-lived.
7. **Fresh-reauth replacement (§8)** — confirm the fallback-send action
   can't be reached by directly calling its endpoint while skipping the
   password re-confirmation step.
8. **Wherever a password is set or reset** (initial account creation, a
   temporary password) — confirm it never travels in a URL query string
   and is never logged.

**Not applicable here:** Asimov and Mason gate *compliance builds* —
anything tenant-facing, anything that decides something about an
applicant/tenant, or anything storing tenant PII. Staff login and
internal permissions touch none of that, so per this project's own
governance criteria this build doesn't need to route through them.
Sentinel's review above is the required gate.

---

## 10. Migration Plan — no lengthy outage

1. Neo designs the concrete schema per §4–§5.
2. Q builds LimeHQ's login/permissions system, plus the handoff mechanism,
   without touching either existing app's current (already-broken) Entra
   routes yet.
3. Jason seeds real accounts for the ~7-person roster (Jason, Dana, Kevin,
   the APM once hired, the Bookkeeper, Belinda, Vien, the Marketing
   Coordinator once hired) with starting roles, and sets temporary
   passwords delivered out-of-band (not via an automated email — an
   automated password-reset-email flow is a separate decision to test/
   approve first).
4. TARS verifies password login, the full permission grid, the Ledger
   Edit Lock, and the fresh-reauth flow end-to-end with real accounts.
5. Q adds the handoff-receiving side to `late-rent-notices` and
   `limehouse-dashboard` (a new callback route that trusts a LimeHQ token
   instead of an Entra one), tested alongside their still-present Entra
   code.
6. Cut over: point each app's "Sign in" button/link at LimeHQ instead of
   its own local login page.
7. After a short soak period (Jason's call on length), Q removes
   `entra.ts`, `pkce.ts`, and the old `/auth/login`/`/auth/callback`
   routes from both apps.

Because the new path is built and proven *next to* the old one rather
than replacing it in place, there's no "down for migration" window.

---

## 11. Explicitly Out of Scope / Do Not Touch

- **`late-rent-notices/src/email/graphMailer.ts`** and its env vars
  (`GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`,
  `GRAPH_SENDER_MAILBOX`) — sends the actual 14-day notice emails to
  tenants via Microsoft Graph against the shared compliance mailbox.
  Different purpose, different app registration, unrelated to staff
  login. Not touched by this spec.
- **`portfolio_assignments`** (tracking which portfolio a property counts
  toward for a staff member's KPIs/pay) — must be modeled as a plain
  table with zero involvement in any permission check, per Jason directly:
  "assigned properties" is a KPI/pay-structure label, not a security
  boundary — he does not want visibility restricted by portfolio
  assignment at all. Out of scope for this spec; belongs to whichever
  module owns KPI/pay reporting (likely the dashboard).

---

## Files referenced from the original two-project investigation (all absolute paths)

- `C:\Users\Jason-Limehouse\Limehouse-Fam\projects\late-rent-notices\src\auth\entra.ts`
- `C:\Users\Jason-Limehouse\Limehouse-Fam\projects\late-rent-notices\src\auth\session.ts`
- `C:\Users\Jason-Limehouse\Limehouse-Fam\projects\late-rent-notices\src\auth\requireFreshReauth.ts`
- `C:\Users\Jason-Limehouse\Limehouse-Fam\projects\late-rent-notices\src\routes\authRoutes.ts`
- `C:\Users\Jason-Limehouse\Limehouse-Fam\projects\late-rent-notices\src\routes\requireSession.ts`
- `C:\Users\Jason-Limehouse\Limehouse-Fam\projects\late-rent-notices\src\db\withPmScope.ts`
- `C:\Users\Jason-Limehouse\Limehouse-Fam\projects\late-rent-notices\src\email\graphMailer.ts`
- `C:\Users\Jason-Limehouse\Limehouse-Fam\projects\late-rent-notices\.env.example`
- `C:\Users\Jason-Limehouse\Limehouse-Fam\projects\late-rent-notices\migrations\0001_create_pm_users.ts`, `0017_create_app_and_job_roles_and_grants.ts`, `0026_add_pm_users_role.ts`, `0032_add_bookkeeping_pm_users_role.ts`
- `C:\Users\Jason-Limehouse\Limehouse-Fam-dashboard\projects\limehouse-dashboard\src\auth\entra.ts`
- `C:\Users\Jason-Limehouse\Limehouse-Fam-dashboard\projects\limehouse-dashboard\src\auth\session.ts`
- `C:\Users\Jason-Limehouse\Limehouse-Fam-dashboard\projects\limehouse-dashboard\src\auth\loginResolver.ts`
- `C:\Users\Jason-Limehouse\Limehouse-Fam-dashboard\projects\limehouse-dashboard\src\api\authRoutes.ts`
- `C:\Users\Jason-Limehouse\Limehouse-Fam-dashboard\projects\limehouse-dashboard\src\api\staffUsersRoutes.ts`
- `C:\Users\Jason-Limehouse\Limehouse-Fam-dashboard\projects\limehouse-dashboard\src\db\staffUsers.ts`
- `C:\Users\Jason-Limehouse\Limehouse-Fam-dashboard\projects\limehouse-dashboard\migrations\0006_create_staff_users.ts`, `0007_drop_team_performance_password.ts`
- `C:\Users\Jason-Limehouse\Limehouse-Fam-dashboard\projects\limehouse-dashboard\.env.example`
