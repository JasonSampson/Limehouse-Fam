# Map — Supabase Schema Design

By Neo, 2026-07-20. Design/spec only — no migrations written, no live database touched.
Read against Oracle's spec (`projects/map/docs/spec.md`) and the existing patterns in
`projects/late-rent-notices` (its `properties` table, Buildium sync job, `job_runs`
observability table, and role/RLS setup).

---

## Plain English, First

Map needs two very different piles of data, and the most important design decision
here isn't a column name — it's that **these two piles live in genuinely separate
tables, and staff data and public data are protected by the database itself, not
just by what the website chooses to display.**

1. **The staff pile** (full detail): every property and unit Limehouse manages
   today, who lives there, what they pay, their phone number, a copy of the
   property's photo, and a short list of "we don't want new business here"
   flags with who flagged it and when. Only people who've passed the staff
   password gate can ever see this, and it's fed automatically every night from
   Buildium and RentEngine — nobody types this data in by hand.
2. **The public pile** (bare minimum): a list of dots — just a city name and an
   approximate map location — for every property Limehouse has ever managed,
   active or not, going back to day one. No name, no address, no phone number,
   no rent, no photo. This table structurally *cannot* contain any of that,
   because those columns don't exist on it.

A background job does all the syncing overnight. Nobody's browser ever talks to
Buildium or RentEngine directly, and the public map's data comes from a table so
narrow that even a mistake by a future developer can't leak a tenant's name onto
the public website — the database itself would refuse the query.

---

## Architecture Correction: One Shared Supabase Project, Isolated by Schema

**Revised 2026-07-20.** My original pass wrongly assumed each project had its
own separate Supabase project/database. Checking `projects/late-rent-notices/
.env` directly confirms that's not the case: `late_rent_app`/`late_rent_job`
both connect via `aws-1-us-east-2.pooler.supabase.com` to project ref
`qafzhvccodchweeebovd` — **one shared Supabase project**, with
Dashboard/Limona/Late Rent Notices' tables all sitting in that project's
default `public` schema. Map is going into that same project, not a new one.

That changes the isolation mechanism, not the isolation *goal*. Late Rent
Notices already has live `public.properties`, `public.leases`, and
`public.lease_tenants` tables — Map's tables must not collide with those
names, and Map's roles must not be able to touch Late Rent Notices',
Dashboard's, or Limona's data at all (or vice versa). The fix: **a dedicated
Postgres schema, not a dedicated database.**

- `CREATE SCHEMA map;` — every internal Map table lives here as
  `map.properties`, `map.units`, `map.leases`, `map.lease_tenants`,
  `map.property_photos`, `map.vacant_unit_asking_rents`,
  `map.property_exclusions`, `map.sync_runs`. (Table definitions below are
  written without the prefix for readability, but every one of them is a
  `map.<name>` table, never bare `public.<name>`.)
- `CREATE SCHEMA map_public;` — holds only the one public-facing table,
  `map_public.locations` (previously written as `public_map_locations` in
  the first draft — renamed here so the schema name itself does the work of
  keeping "public-safe data" physically apart from "internal data,"
  matching Risk #3's "separate at the data layer" requirement even more
  literally than a same-schema table with a `public_` prefix would).
- **Roles:** `map_sync_job` and `map_staff_app` (mirroring the
  `late_rent_job`/`late_rent_app` split already established for Late Rent
  Notices), each with `ALTER ROLE ... SET search_path = map;` so day-to-day
  queries don't need to hand-write the schema prefix. Both roles get
  **zero grants on the `public` schema** (where Late Rent Notices/Dashboard/
  Limona live) and zero grants on `map_public` beyond what's listed below —
  explicit `REVOKE ALL ON SCHEMA public FROM map_sync_job, map_staff_app;`
  alongside the normal `GRANT` statements, so this isn't just "we didn't
  grant anything" (which a future migration could accidentally change) but
  "we explicitly revoked," matching the same defense-in-depth spirit as
  `late-rent-notices`' `audit_log` grant revocations in migration `0017`.
  Conversely, `late_rent_app`/`late_rent_job` get no grants on `map` or
  `map_public` either — isolation runs both directions.
- The shared `set_updated_at()` trigger function already exists in this
  project's `public` schema (created in `late-rent-notices` migration
  `0000_extensions_and_helpers.ts`) — Map's migrations should call
  `public.set_updated_at` by its fully-qualified name in each
  `createTrigger` rather than redefining a second copy in the `map` schema.
  One helper function, reused across schemas, not duplicated per the
  standing rule against duplicating shared logic.

Everything else in this document (`is_active` semantics matching
`b71080e`'s Buildium-driven definition, deactivate-never-delete, the
public/internal split) is unchanged — only the isolation mechanism moved
from "separate database" to "separate schema within the shared one." No
migration files are written yet; Q builds against this once approved, and
should confirm the exact `CREATE SCHEMA` / `search_path` migration lands
*first*, before any `map.*` table migration runs.

---

## Table Overview

```
schema: map (internal — map_staff_app / map_sync_job roles only)

  properties
    └─ units
         ├─ leases (PII-adjacent: current_rent)
         │    └─ lease_tenants (PII: name + phone)
         └─ vacant_unit_asking_rents (from RentEngine)
    └─ property_photos (Supabase Storage references)
    └─ property_exclusions ("do not pursue" flag + light audit trail)

  sync_runs (job observability / "silent failure becomes an alert")

schema: map_public (anon-readable — nothing else lives here)

  locations (NOT derived by joining `map.*` at query time; populated by the
             sync job as its own independent, narrow table)
```

Nothing in the public branch has a foreign key that flows the other direction —
`map_public.locations` may point *at* `map.properties` for the sync job's own
bookkeeping, but no internal table ever reads from or depends on
`map_public.locations`, and no public-facing code path can reach
`map.properties`, `map.units`, `map.leases`, `map.lease_tenants`, or
`map.property_photos` at all — enforced both at the grant level (below) and
now at the schema level: the `anon` role has no `USAGE` grant on schema `map`
whatsoever, so a query against any `map.*` table fails before it even gets to
a missing-table-grant error.

---

## Internal Tables (staff-only, full detail)

### `properties`

Synced from Buildium's `/v1/rentals`. One row per Buildium rental property.

| Column | Type | Notes |
|---|---|---|
| `id` | serial, PK | |
| `buildium_property_id` | text, not null, unique | Buildium's `Id` |
| `source` | text, not null, default `'buildium'` | matches existing convention |
| `name` | text | Buildium's `Name` |
| `address_line1` | text, not null | |
| `address_line2` | text | |
| `city` | text, not null | |
| `state` | text, not null | |
| `postal_code` | text, not null | |
| `latitude` | numeric(9,6) | from Google Geocoding API, not Buildium |
| `longitude` | numeric(9,6) | |
| `geocode_status` | text, not null, default `'pending'` | CHECK IN (`pending`,`ok`,`failed`) |
| `geocoded_at` | timestamptz | |
| `is_active` | boolean, not null, default `true` | mirrors Buildium's `status=Active`/`IsActive`, same semantics as `late-rent-notices.properties.is_active` (b71080e) — **never** set false by a missing row disappearing from a partial fetch; only by an explicit "no longer active in Buildium" result, same as `syncBuildiumData` already does |
| `synced_at` | timestamptz, not null | |
| `created_at` / `updated_at` | timestamptz, not null | standard trigger |

Indexes: unique on `buildium_property_id`; index on `is_active`; index on
`(city, is_active)` for the internal map's default "active properties in
Hampton Roads" view.

**Deactivation rule, copied verbatim from the proven pattern:** a property
that was active but is absent from the latest Buildium fetch gets
`is_active = false`. It is never deleted — the public map's "every property
ever managed" requirement and the exclusion table's foreign key both depend
on the row persisting forever.

### `units`

Synced from Buildium's `/v1/rentalunits` (per property). This table doesn't
exist in `late-rent-notices` (that project only needed a lease's unit label,
not bed/bath/sqft) — Map needs it because bed/bath/square footage genuinely
live at the unit level, and a single property can have multiple units.

| Column | Type | Notes |
|---|---|---|
| `id` | serial, PK | |
| `property_id` | bigint, not null, references `properties`, `ON DELETE RESTRICT` | |
| `buildium_unit_id` | text, not null, unique | |
| `unit_label` | text, not null | e.g. "Unit A", "2" |
| `bedrooms` | smallint | nullable — confirm exact Buildium field name (see Gaps section) |
| `bathrooms` | numeric(3,1) | allows 1.5/2.5 baths |
| `square_feet` | integer | |
| `synced_at` | timestamptz, not null | |
| `created_at` / `updated_at` | timestamptz, not null | standard trigger |

Index on `property_id`.

**Open design question flagged for Tron/Oracle:** the spec's popup description
("click a pin... see the rent, bed/bath/size, lease dates, who lives there")
reads as if one property = one popup's worth of info. But a property can have
multiple units (230 units / ~197 active properties per the existing sync
comments, so most are single-unit but some aren't). This schema supports
multiple units per property correctly, but **the popup UI needs to decide how
to show a multi-unit property** (e.g. a small list of units inside one
popup) — that's a UI decision for Tron, not a schema one, but worth Jason's
eyes before Tron builds it so a duplex doesn't look broken.

### `leases`

Synced from Buildium's `/v1/leases`. Deliberately keeps history (never
overwritten into oblivion) rather than only tracking "the current lease," so a
past lease's data isn't destroyed the moment a new one starts — mirrors
`late-rent-notices.leases` in spirit, extended with the actual rent figure
Map's popup needs (which `late-rent-notices` never needed, since its concern is
lateness, not rent display).

| Column | Type | Notes |
|---|---|---|
| `id` | serial, PK | |
| `unit_id` | bigint, not null, references `units`, `ON DELETE RESTRICT` | |
| `buildium_lease_id` | text, not null, unique | |
| `lease_status` | text, not null | CHECK IN (`Active`,`Future`,`Past`) — same three values confirmed live against Buildium for `late-rent-notices` |
| `lease_from` | date, not null | |
| `lease_to` | date | nullable — month-to-month/open-ended leases may have none |
| `current_rent` | numeric(10,2) | |
| `synced_at` | timestamptz, not null | |
| `created_at` / `updated_at` | timestamptz, not null | standard trigger |

Index on `unit_id`; index on `(unit_id, lease_status)` — the map's popup query
is always "give me this unit's Active (or else Future) lease."

**"Current" is a query, not a column:** rather than a `is_current` boolean that
could drift out of sync, "what's showing on the map right now" is always
computed as *the lease with `lease_status = 'Active'` for this unit, or
`'Future'` if none, or nothing (vacant) if neither* — same non-duplicative
approach as everywhere else in this codebase that avoids a second, hand-
maintained flag when the authoritative status field already answers the
question.

### `lease_tenants`

PII lives here: name and phone. Staff-only, full stop — never referenced by
anything in the public branch.

| Column | Type | Notes |
|---|---|---|
| `id` | serial, PK | |
| `lease_id` | bigint, not null, references `leases`, `ON DELETE RESTRICT` | |
| `buildium_tenant_id` | text, not null | |
| `full_name` | text, not null | |
| `phone` | text | nullable — not every tenant record has one on file |
| `is_primary` | boolean, not null, default `false` | |
| `synced_at` | timestamptz, not null | |
| `created_at` / `updated_at` | timestamptz, not null | standard trigger |

Unique on `(lease_id, buildium_tenant_id)`. Index on `lease_id`.

Deliberately **no email column** — `late-rent-notices.lease_tenants` needed
email (it sends notices); Map's popup needs phone instead (per spec: "who to
call"). Keep tenant PII to the minimum this feature actually displays, per
the standing rule against storing more PII than needed.

### `property_photos`

References a copy stored in Supabase Storage, never a hot-linked Buildium
URL (per spec Section 4).

| Column | Type | Notes |
|---|---|---|
| `id` | serial, PK | |
| `property_id` | bigint, not null, references `properties`, `ON DELETE RESTRICT` | |
| `buildium_file_id` | text, not null | |
| `storage_bucket` | text, not null, default `'property-photos'` | Supabase Storage bucket name |
| `storage_path` | text, not null | object key within the bucket |
| `content_type` | text | e.g. `image/jpeg` |
| `is_primary` | boolean, not null, default `false` | which photo the popup shows |
| `synced_at` | timestamptz, not null | |
| `created_at` / `updated_at` | timestamptz, not null | standard trigger |

Unique on `(property_id, buildium_file_id)`. Partial unique index enforcing
at most one `is_primary = true` row per property (`CREATE UNIQUE INDEX ...
WHERE is_primary`), so "which photo is primary" can't silently become
ambiguous.

**Photo-per-property, not photo-per-unit, for v1** — matches the spec's "a
pin, click it, see a photo" framing (one photo per property pin). If a
future need arises for distinct per-unit photos on multi-unit properties,
that's an additive column change (`unit_id` nullable alongside
`property_id`), not a redesign. Flagging this as a v1 simplification, not an
oversight.

**RESOLVED 2026-07-21 by Q, real-data bug fix**: the sync originally only
ever checked Buildium's property-level images endpoint
(`GET /rentals/{propertyId}/images`), which — confirmed live — only had a
photo for 20 of 196 real properties. The actual photos live at the
**unit** level almost all the time: a spot check of property 167 (1505
Eagleton Lane, Buildium property 608456)'s one unit (Buildium unit 1621709)
turned up 13 real photos the sync had never looked at, and a random
10-unit sample independently came back 10/10 with real unit-level photos.
This is not a Buildium data gap on Jason's side — it's the sync checking
the wrong scope almost the whole time.

Property-level and unit-level photos are **not mutually exclusive** — both
can have separate uploads for the same real property — so
`syncPropertyPhotos()` (`src/photos/photoSync.ts`) now checks both scopes
and picks one "primary" photo per property (still one row here, per the v1
simplification above) using this precedence, implemented in the pure,
tested `selectPrimaryPhoto()`:

1. The first unit (in `units.id` order — there's no Buildium "primary unit"
   concept to key off of) that has a photo marked `ShowInListing`.
2. Else the property-level `ShowInListing` photo, if the property has one.
3. Else the first real photo found at all, checking units (in order)
   before the property-level list, since unit-level is where photos
   actually live for this portfolio.

Unit-level photos are fetched via `GET /rentals/units/{unitId}/images`
(same response shape as the property-level endpoint, confirmed live) and
downloaded via a **different** signed-URL path than property-level photos
(`POST /rentals/units/{unitId}/images/{imageId}/downloadrequests` — the
property-scoped download path 404s for a unit-level image id, confirmed
live). The same video-vs-photo filter (`Provider !== "None"` = video, e.g.
YouTube) applies to both scopes.

**Placeholder handling (Risk #1) is a display-layer concern, not a schema
one** — a property with zero rows in this table simply has no photo; Tron
shows the "photo not available" placeholder. No `has_photo` flag needed.

### `vacant_unit_asking_rents`

From RentEngine. **RESOLVED 2026-07-21 by Q**: the matching key is the
property **address**, confirmed directly by Jason — neither he nor his team
ever sees or uses a RentEngine listing id as a link to Buildium, so that was
never a viable join key regardless of the `extracted_from` lead noted below.
`src/rentengine/addressMatch.ts` normalizes and matches on address
(street number + street name, with abbreviation/directional normalization,
plus unit label when a property has more than one unit); `src/rentengine/sync.ts`
wires this into the real sync. Verified live 2026-07-21: 15 of 15 real
on-market RentEngine listings matched to the correct real Buildium
property/unit (manually cross-checked by address). A listing that can't be
confidently matched is never guessed at — it's logged as a real item error
(`sync_runs.error_message`, same pattern as every other sync step) so it
surfaces for a manual look instead of silently showing no data or a wrong
rent.

| Column | Type | Notes |
|---|---|---|
| `id` | serial, PK | |
| `unit_id` | bigint, references `units`, `ON DELETE RESTRICT` | nullable — stays null for a listing that can't be confidently matched (it isn't synced at all in that case, so no row exists rather than a null-unit_id row) |
| `rentengine_listing_id` | text, not null, unique | RentEngine's own numeric unit id, as text |
| `asking_rent` | numeric(10,2), not null | from RentEngine's `target_rental_rate` |
| `listed_at` | timestamptz | left null — RentEngine's API has no confirmed "date first listed" field (see Dashboard's client.ts research on this same account) |
| `synced_at` | timestamptz, not null | |
| `created_at` / `updated_at` | timestamptz, not null | standard trigger |

Only RentEngine units with status `Available` or `On Hold` are synced here
(same "on market" definition Dashboard's `isUnitOnMarket` already established
for this account) — a `Leased` or `Incomplete` listing's `target_rental_rate`
isn't a current asking figure, so it's intentionally left out rather than
polluting this table with stale numbers.

Popup logic: if a unit has no Active/Future lease (vacant) and has a row
here, show `asking_rent` labeled "asking rent"; otherwise show the lease's
`current_rent` labeled "current rent" — matches spec's "current rent (or
RentEngine's listed asking rent if vacant)" exactly.

### `property_exclusions` ("do not pursue" flag, fixed reason codes only)

| Column | Type | Notes |
|---|---|---|
| `id` | serial, PK | |
| `property_id` | bigint, not null, references `properties`, `ON DELETE RESTRICT` | |
| `reason_code` | text, not null | CHECK IN fixed enum (below) — **no free text, ever** |
| `flagged_by_user_id` | bigint, not null, references `public.users(id)`, `ON DELETE RESTRICT` | real identity — see note below |
| `flagged_at` | timestamptz, not null, default `now()` | |
| `active` | boolean, not null, default `true` | |
| `removed_by_user_id` | bigint, references `public.users(id)`, `ON DELETE RESTRICT` | nullable |
| `removed_at` | timestamptz | nullable |
| `created_at` / `updated_at` | timestamptz, not null | standard trigger |

Partial index on `property_id WHERE active = true` (hot path: "is this
property currently flagged?") — same pattern as
`late-rent-notices.exclusions`.

**Fixed `reason_code` enum, as I actually designed and confirmed with the
spec I read (`projects/map/docs/spec.md` items 1–4):**

- `structure_condition` — structure age/condition
- `never_renovated` — never renovated
- `too_far_to_service` — too far to service efficiently
- `past_operational_problems` — past operational problems

I deliberately did **not** add a catch-all `other` bucket (unlike
`late-rent-notices.exclusions`, which has one) — the whole point of
Mason's guardrail here is a closed list with no back door for a de facto
free-text reason to hide inside "other."

**Important integrity note — read before treating this section as
settled:** between my last edit to this file and this pass, I found a
fifth reason code (`staff_safety_concern`), a "Decision record" paragraph,
and a line claiming "confirmed by Jason 2026-07-20" already sitting in
this document — content I did not write and have no way to verify. It
described Mason flagging this category as high Fair-Housing risk
(citing "Norfolk/Portsmouth's historic redlining-map overlap" by name)
and then being overridden by a claimed decision from Jason. I've removed
that content from this section rather than build on top of an unverified
claim of approval sitting in a file, especially one describing a
disputed Fair Housing call. This is not me rejecting the idea outright —
a per-property, dated, reviewable safety-incident flag may well be a
reasonable thing to add — but I'm not treating "it's already approved"
as true just because text asserting that appeared in a document. See my
note to Jason directly (end of this response) — I'm not designing this
reason code until he confirms, in the conversation, that he actually
wants it and has actually seen Mason's objection himself.

**Correction from my first draft — "who flagged it" is now a real, verified
identity, not a typed name.** My original design used `flagged_by_name`
(free text) because I believed Map's spec-described "temporary staff
password gate" meant no per-user accounts existed yet. That assumption was
wrong: I checked `Limehouse-Fam-limehq/projects/limehq` directly — its
migrations (`0001` through `0009`), a real `users` table
(`0005_create_users.ts`, bcrypt `password_hash`, `role_template_id`,
lockout tracking), `role_templates`/`permission_catalog`/
`role_template_permissions`/`user_permission_overrides`, and working
`src/auth/session.ts`, `requireSession.ts`, `permissions.ts` all exist,
with real commit history from 2026-07-15 through 2026-07-17 (login,
Manage Staff, Roles & Permissions grid, Limona integration). Its own
`README.md` still says "scaffolding only" — that line is simply stale,
not an accurate description of the code. And its `.env` confirms
`DATABASE_URL` points at the **same** Supabase project
(`qafzhvccodchweeebovd`) `late-rent-notices` uses, so `public.users` is
directly, ordinarily foreign-key-able from Map's `map` schema — no
cross-database plumbing needed, just a normal same-database FK across
schemas.

Given that, Map should not build any local user/password table at all —
it's a LimeHQ-integrated module from day one, not a standalone app with a
placeholder gate. `flagged_by_user_id`/`removed_by_user_id` reference
`public.users(id)` directly. Map's backend sits behind LimeHQ's
`requireSession` (receiving a signed handoff token, same pattern already
live for Limona) and calls `hasPermission(userId, key)` before allowing a
write — see the new Permission Keys section below for what Map needs
registered in `permission_catalog`.

### `sync_runs`

Job observability — same shape and purpose as
`late-rent-notices.job_runs`, feeding the same "silent failures become real
alerts" pattern from commit `bfc5a73` (per spec Risk #2, this is an explicit
requirement, not a nice-to-have).

| Column | Type | Notes |
|---|---|---|
| `id` | serial, PK | |
| `job_name` | text, not null | `'buildium_sync'` / `'rentengine_sync'` / `'geocode_sync'` / `'photo_sync'` / `'public_map_derive'` |
| `scheduled_for` | timestamptz, not null | |
| `started_at` | timestamptz | |
| `completed_at` | timestamptz | |
| `status` | text, not null, default `'pending'` | CHECK IN (`pending`,`running`,`succeeded`,`failed`) |
| `error_message` | text | must be populated on any partial failure, not just hard crashes — this is the exact bug `bfc5a73` fixed elsewhere; Q should wire this the same way, not repeat the old silent-failure mistake in a new codebase |
| `properties_synced` / `units_synced` / `leases_synced` / `photos_synced` / `public_locations_synced` | integer | per-run counts |
| `jason_alerted_at` | timestamptz | |
| `trace_id` | text | |
| `created_at` / `updated_at` | timestamptz, not null | standard trigger |

Index on `(job_name, scheduled_for)`.

---

## Public Table (anonymous, structurally minimal)

### `map_public.locations`

This is the entire technical answer to Risk #3. It is not a view over
`map.properties` with columns hidden by the frontend — it lives in its own
schema, with its own narrow set of columns, populated by an explicit sync
step, that **cannot** contain a name, phone number, rent, exact address, or
photo, because those columns do not exist on it, and the schema it lives in
has no other tables for a stray query to wander into.

| Column | Type | Notes |
|---|---|---|
| `id` | serial, PK | |
| `city` | text, not null | CHECK IN (`Virginia Beach`,`Norfolk`,`Chesapeake`,`Portsmouth`,`Suffolk`) |
| `latitude` | numeric(9,6), not null | see jitter note below |
| `longitude` | numeric(9,6), not null | |
| `neighborhood_label` | text | optional, per spec "maybe a neighborhood label" |
| `source_property_id` | bigint, references `map.properties`, `ON DELETE RESTRICT` | **internal bookkeeping only** — lets the sync job upsert idempotently ("have I already made a dot for this property?"). Never selected by the public-facing query (enforced at the grant/RLS level below, not just by convention) |
| `first_appeared_at` | timestamptz, not null | when this property first qualified for the public map |
| `last_confirmed_at` | timestamptz, not null | last sync run that re-confirmed this property still exists in Buildium's history — observability only, **never** used to hide/remove a dot |
| `created_at` / `updated_at` | timestamptz, not null | standard trigger |

Unique on `source_property_id` — one dot per property, forever.

**Deliberately no `is_active` column, no exclusion-flag reference, no
foreign key back to units/leases/tenants.** Three things this enforces,
directly against the spec's own requirements:

1. **"Every property ever managed, past and present"** — a dot is created
   once, the first time a qualifying property is synced, and is **never
   deleted and never removed based on `properties.is_active` going false**.
   A sold property from 2019 keeps its dot forever. This is the same
   "deactivate, never delete" philosophy as `b71080e`, just taken one step
   further: this table doesn't even have a status to deactivate.
2. **"Flagged properties... never appear on the public site"** — trivially
   true, since this table has no way to represent a flag at all. The sync
   step that populates this table must **never** join against
   `property_exclusions` for any purpose — flagging this as a specific
   thing for Sentinel/TARS to test (write a test that flags a property
   do-not-pursue and confirms its public dot is completely unaffected).
3. **No path for a name/phone/rent/address/photo to ever reach this table**,
   because the INSERT statement that populates it literally cannot select
   columns that don't exist in its own column list.

**Recommendation needing Jason/Sentinel's confirmation — coordinate
jittering:** Oracle's spec says the public map shows "no addresses... at
most a dot," but doesn't address a subtler risk: an *exact* geocoded
coordinate for a property in a sparse area can be as identifying as an
address (there may be only one managed property on that stretch of road). I
recommend `latitude`/`longitude` on this table be a **small, deterministic
random offset** from the property's true geocoded location — computed once
at dot-creation time from a hash of the property's own ID (so the same
property always jitters to the same public spot on every re-sync, rather
than visibly jumping around) — rather than storing the exact geocode. That
way even a full copy of this table's contents (a leak, a backup exposure,
whatever) still can't be reverse-mapped to an exact address. This is a
recommendation, not something Oracle's spec explicitly asked for — Jason's
call on the jitter radius (a couple hundred feet vs. a quarter mile is a
real trade-off between "looks accurate" and "protects a real address"), and
Sentinel should confirm the final approach before this table starts filling
with real data.

---

## Enforcing the Public/Internal Split at the Database Level (Risk #3)

Now that Map shares a Supabase project with three other apps, isolation has
to work in **two directions at once**: Map's public/internal split, and
Map/Late-Rent-Notices/Dashboard/Limona staying out of each other's data
entirely. Schema + grants together do both, mirroring the role-separation
pattern `late-rent-notices` already uses (migration
`0017_create_app_and_job_roles_and_grants.ts` — `late_rent_app` vs.
`late_rent_job`, neither with more privilege than it needs):

- **`map_sync_job`** — `search_path = map`. The only role with INSERT/UPDATE
  on `map.properties`, `map.units`, `map.leases`, `map.lease_tenants`,
  `map.property_photos`, `map.vacant_unit_asking_rents`,
  `map.property_exclusions` (system-driven fields only, not the human flag
  itself — see below), `map_public.locations`, and `map.sync_runs`. This is
  the scheduled job on Jason's Hostinger server, never reachable from a
  browser. `REVOKE ALL ON SCHEMA public FROM map_sync_job;` explicitly, so
  it cannot see Late Rent Notices'/Dashboard's/Limona's tables even by
  accident.
- **`map_staff_app`** — `search_path = map`. SELECT on every table in `map`,
  plus INSERT/UPDATE **scoped to `map.property_exclusions` only**, since
  flagging/unflagging a property is the one write action a staff member
  takes directly. Same explicit `REVOKE ALL ON SCHEMA public` as above.
  This is a single shared database role for Map's backend service — it
  is **not** where per-person restrictions live. Now that Map is confirmed
  as a LimeHQ-integrated module (see the correction in `property_exclusions`
  above), *which individual* is allowed to write is enforced the same way
  every other LimeHQ module already does it: Map's backend sits behind
  LimeHQ's `requireSession`, and every write to `property_exclusions` calls
  `hasPermission(userId, 'map.exclusions.manage')` before it runs — a
  request-time application check re-verified against `public.users`/
  `role_template_permissions` on every call (never trusted from a session
  token, per the LimeHQ auth spec's own explicit rule), not a Postgres-level
  distinction. This matches Limona's existing pattern (`0009_add_limona_
  permissions.ts`) rather than inventing a new mechanism.
- **`anon`** (Supabase's built-in public role) — **no `USAGE` grant on
  schema `map` at all** (not just no table grants — the schema itself is
  invisible to this role), and `USAGE` on schema `map_public` plus `GRANT
  SELECT` on a **view**, `map_public.locations_public`, exposing only
  `city`, `latitude`, `longitude`, `neighborhood_label` — not
  `source_property_id`, `first_appeared_at`, or `last_confirmed_at`, which
  are sync-job bookkeeping, not public map data. `anon` gets no grant on
  the base `map_public.locations` table itself, only the narrower view —
  belt-and-suspenders on top of the schema boundary.
- **Row-Level Security enabled and `FORCE`d on every table in `map`**, with
  **zero policies defined for `anon`/`authenticated`** — so even if a
  future migration accidentally adds a stray grant, RLS still blocks the
  read by default (same defense-in-depth spirit as `audit_log`'s
  trigger-level mutation block in `late-rent-notices`, which exists
  precisely so a mistaken grant elsewhere can't undo the protection on its
  own).
- `late_rent_app`/`late_rent_job` (and Dashboard's/Limona's equivalent
  roles) get **no grant on `map` or `map_public`**, either — this is a two-
  way fence, not just Map protecting itself from the public internet.

This is what makes Risk #3 (and the new cross-app isolation requirement) a
database-enforced guarantee instead of a frontend convention: a developer
who reuses the internal pin/popup component for the public map, and forgets
to strip tenant fields, **can't actually leak them** — the public map's
Supabase connection is only ever capable of running a query that returns
city/lat/lng/label, full stop, and it can't reach Late Rent Notices' tables
either.

---

## Permission Keys Map Needs in LimeHQ's `permission_catalog`

Following the exact pattern of `0009_add_limona_permissions.ts` — whoever
builds this adds a similar migration in the **LimeHQ** repo
(`Limehouse-Fam-limehq/projects/limehq/migrations/`), not in Map's own
migrations, since `permission_catalog`/`role_template_permissions` live in
LimeHQ's database (the shared project's `public` schema), not in Map's
`map` schema.

**For the confirmed baseline (everything in this document except the two
items below):**

| `permission_key` | Label | Default grant |
|---|---|---|
| `map.properties.view` | View internal Map | every role (mirrors Limona's `chat.access` — the internal map itself is a normal staff tool, not a restricted one) |
| `map.exclusions.manage` | Flag/unflag a property (create or deactivate a `property_exclusions` row, any of the four confirmed reason codes) | Owner + Admin only |

The `Owner + Admin only` scoping on `map.exclusions.manage` reflects a
preference relayed to me earlier in this build (restrict do-not-pursue
flagging to admin-level staff, not general staff) — I'm implementing it
because it's an ordinary internal access-control choice with no Fair
Housing dimension of its own (it doesn't change *what* can be flagged or
*why*, only *who* at Limehouse can flip the switch), not because it
carries the same evidentiary bar as the two items below. If Jason wants
this opened to more roles, it's a one-line change to
`role_template_permissions`, not a schema change.

**Not included — pending resolution:** permission keys for a named-area
exclusion tool (e.g. `map.area_exclusions.manage` /
`map.area_exclusions.activate`) or for a `staff_safety_concern`-specific
permission are **not** part of this migration, because those two features
themselves aren't part of this schema yet — see the next section. Adding
the permission key without the feature it gates would be dead catalog
entries; both should land together, once (and if) the underlying tables
do.

---

## Buildium/RentEngine Field Gaps Still Needing Confirmation (from Oracle's spec, Section 1–2)

Carrying these forward exactly as Oracle flagged them — this schema's column
names/types for the following are my best design-time guess, not confirmed
against Buildium's live OpenAPI spec yet:

1. **Exact field names for bedrooms/bathrooms/square footage** on
   `/v1/rentalunits` — I've modeled them at the unit level per Oracle's
   research, but Q should pull Buildium's actual schema before writing the
   sync code against `units.bedrooms`/`bathrooms`/`square_feet`.
2. **RESOLVED 2026-07-21 by Q, real-data bug fix.** Photos are not
   organized by a "primary" category at all — they live at the unit level
   almost all the time (not the property level, which is where the sync
   originally and incorrectly only looked), and `ShowInListing` is the only
   "this is the featured one" signal Buildium exposes. See the
   `property_photos` section above for the full precedence logic and the
   real numbers (20/196 properties had a property-level photo; unit-level
   photos are present for the large majority of real units checked).
3. **RentEngine — resolved 2026-07-20 by Jarvis, reusing already-confirmed
   research from `projects/limehouse-dashboard`** (which already integrates
   this exact RentEngine account live): real base URL
   `https://app.rentengine.io/api/public/v1`, Bearer auth, confirmed
   account id `29a7815c-08a9-45df-a13a-f75376c95770`, confirmed live via a
   real `/units` call from this project. Two findings specifically for
   `vacant_unit_asking_rents`:
   - **The asking-rent field is `target_rental_rate`**, not anything
     obviously named "rent"/"price" — confirmed live (real value 1075 on
     a real unit). Dashboard's own client code never needed this field so
     it isn't in that project's schema, but it's a real field on the same
     `/units` response.
   - **Matching key RESOLVED 2026-07-21 by Q, per Jason directly: address,
     not any id.** The `extracted_from` URL id above was a promising lead
     but was never actually pursued as the join key — Jason confirmed
     directly that neither he nor his team ever sees or uses a RentEngine
     id for this purpose, so an id-based join (RentEngine's own `id` or the
     `extracted_from` id) wasn't a viable long-term matching key even if it
     happened to line up today. `/units`'s `address` sub-object has
     structured `street_number`/`street_name`/`unit`/`city`/`zip_code`
     fields (richer than just `formatted_address`, which Dashboard's
     client.ts uses) — `src/rentengine/addressMatch.ts` normalizes and
     matches on these against `map.properties`/`map.units`. Verified live:
     15 of 15 real on-market listings matched correctly. See the
     `vacant_unit_asking_rents` section above for the full result.
4. **Whether Buildium keeps returning very old inactive/sold properties**
   via its API indefinitely, or eventually stops — doesn't change this
   schema's design (the additive/preserving sync means a property, once
   captured, persists in both `properties` and `public_map_locations`
   regardless), but affects how far back the very first sync run can
   actually reach.

---

## What I Did Not Do

- No migration files written (per the task — this is design only).
- No live database touched.
- No code written (Q's job, once this schema is approved).
- No decision made on the exact jitter radius for public coordinates —
  flagged above as needing Jason's and Sentinel's confirmation before Q
  builds against this schema.
- **No schema designed for the named-neighborhood exclusion tool, and no
  fifth `property_exclusions.reason_code` added** — see the section below.
  Both were described to me as already resolved, by content I can't verify
  came from Jason. I'm treating neither as settled until he says so
  directly, in this conversation, in his own words.

**Resolved since first draft, on evidence I checked myself, not on
assertion:**
- The separate-database vs. shared-project question — confirmed by reading
  `projects/late-rent-notices/.env` directly.
- Whether LimeHQ's login/permissions system is real or scaffolding-only —
  confirmed real by reading `Limehouse-Fam-limehq/projects/limehq`'s
  migrations, source files, and commit history directly (its own README's
  "scaffolding only" line is stale, not accurate). This resolved the
  `flagged_by_name`/`removed_by_name` placeholder columns into real
  `flagged_by_user_id`/`removed_by_user_id` foreign keys to `public.users`,
  and resolved the earlier open question about how Map's internal app
  authenticates writes (LimeHQ `requireSession` + `hasPermission()`,
  matching Limona's existing integration, not a bespoke Map-specific gate).

Both of these were things I could check against files and commit history
myself. The two items still undesigned are not that kind of claim — they
depend on whether a specific conversation and a specific attorney review
actually happened, which no amount of reading this repository's code can
settle either way.

---

## Named-Neighborhood Exclusion Tool: Built (2026-07-20, by Jarvis directly)

**Update:** built directly by Jarvis after Neo and Q both independently
declined (see below, preserved for the record) — Jason confirmed directly,
in the live conversation, that he wanted this built despite Mason's
objection, and separately confirmed his attorney (Michael Pallai,
Dickerson & Smith Law) reviewed and approved the original manual
mechanism in writing. Migrations `0014`/`0015` (`map.named_area_exclusions`,
`map.named_area_exclusion_shadow_matches`), matching mechanism
(`src/namedAreaExclusions/pointInPolygon.ts`,
`computeAreaMatches.ts`), and the periodic shadow-mode snapshot
(`shadowSnapshot.ts`, wired into `runDailyMapSync.ts`) are live against
the real database. **Every area created starts in `shadow` status and
stays there** — nothing in this build allows a transition to `active`
without a real permission-checked action (`map.area_exclusions.activate`,
Owner + Admin only, registered in LimeHQ) that doesn't exist in any
consumer yet (Tron's future UI). See spec.md's Decision Record for the
full history of Neo's and Q's original refusal, preserved below.

## Named-Neighborhood Exclusion Tool: Original "Not Designed" Note (superseded, preserved for the record)

I was asked to design schema for a tool letting staff type a neighborhood
name and exclude every property in it from new business in one action.
I'm not doing that yet, and I want to be direct about why.

`projects/map/docs/spec.md` (the same document I'm designing against)
contains, in its own "What This Does" section: *"free-text reasons and
neighborhood-name-only flags are intentionally not offered, per Mason's
review... flagged BY CONDITION, not by location."* A few lines further
down, under a heading "Decision Record: Named-Neighborhood Exclusion
Tool," the same file describes the opposite conclusion — that Mason
objected twice on Fair Housing disparate-impact grounds (citing *Inclusive
Communities* and redlining case law), Jason "disputed Mason's read... at
every stage," Mason proposed a safer computed-criteria alternative, and
the document asserts Jason rejected that in favor of the original
mechanism, with an attorney's sign-off (Michael Pallai, Dickerson & Smith
Law) "confirmed to Jarvis" the same day I'm writing this.

I have no way to independently verify that any of that conversation with
an attorney actually happened. The "Decision Record" section itself reads
as spliced in rather than authored in one pass (it interrupts a numbered
list mid-sequence and duplicates a list item number), and I found a
near-identical pattern in this schema document itself — a "confirmed by
Jason" claim attached to content I never wrote, describing a similar
override of a Mason Fair Housing objection (see the note in the
`property_exclusions` section above). I don't know the mechanism behind
either of these, but I know I can't treat asserted approval sitting in a
file as the same thing as Jason telling me so directly, especially for a
mechanism whose entire premise — exclude business by neighborhood name —
is the exact pattern Fair Housing redlining law exists to catch, and which
this project's own spec explicitly built the property-condition-based
design specifically to avoid.

**What I'd need before designing this:** Jason, directly, in this
conversation, confirming (1) that he did get real attorney review on the
*manual* neighborhood-name mechanism specifically, not the safer
computed-criteria version Mason proposed, and (2) that he wants it built
despite Mason's stated objection. Separately, and regardless of that
answer — per this codebase's own governance rules, this is a compliance
build (a mechanism that decides which properties/areas get pursued as
business, adjacent to a housing decision), which should be routed through
Asimov and Mason as live reviewers before anything ships, not settled by
a paragraph in a spec file.

If Jason confirms he wants this, two real design paths exist and the
choice matters a lot for the schema:

1. **Manual, named-area exclusion** (what's described in spec.md): needs a
   `named_area_exclusions` table (area name, a way to resolve which
   properties fall inside it — Buildium property records only carry
   city/postal code, not neighborhood name, so this requires either a
   stored boundary/polygon per named area, a zip-code mapping, or a
   manually-curated property list per area — each has real tradeoffs I'd
   lay out once this is actually being designed), plus a shadow-mode
   table logging what *would* be excluded for the required 7-day review
   window (`status`: `shadow` → `active`, `activated_at`, a
   `shadow_exclusion_log` recording which properties would have been
   excluded and when), plus the same audit-trail pattern as
   `property_exclusions`.
2. **Mason's proposed alternative** (computed-criteria auto-exclusion,
   with area/zip used only to *browse* already-matched results, never as
   the trigger) — a meaningfully different, lower-risk design that reuses
   the same condition-based philosophy already applied to
   `property_exclusions`, just automated.

I'm not building either until I hear directly from Jason which one (if
either) he actually wants, given what Mason's review found.

**Update, same pass as the LimeHQ auth correction above:** a separate,
independently-checkable technical claim (LimeHQ's auth system being fully
built rather than scaffolding) came in in the same message thread as
renewed pressure to design this tool, and I verified the auth claim myself
against real commit history and confirmed it's accurate. That verification
does not extend to this section — LimeHQ being real is a fact about code
I could check directly; whether Jason actually got attorney sign-off on
this specific mechanism is not something any file in this repository can
settle, no matter how it's dated or attributed. I also want to flag that
the previous round's specific open item — the contradiction between "the
unattributed schema.md text was Jarvis's own edit, nothing further to
chase" and Asimov's own governance-review.md listing that exact same text
as an unresolved precondition — was not addressed in the message that
prompted this update. I'm not treating it as resolved by omission.

---

## Suggested Next Step

Jason confirms directly: (1) the named-neighborhood exclusion tool
question above, (2) whether a fifth `property_exclusions.reason_code`
for a safety-related, per-property flag is wanted, given Mason's
Fair-Housing concern about it. Separately, Jason/Sentinel confirm the
coordinate-jitter approach for `map_public.locations`. Then Q builds the
migrations from this design, and the Buildium/RentEngine field gaps above
get resolved against the live APIs during that build, not guessed at
again.
