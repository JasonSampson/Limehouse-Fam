# Map — Coverage Area Map (Internal + Public)

Spec by Oracle, 2026-07-20. Research/planning only — nothing built yet.

---

## What This Does

Map gives Limehouse two things from one shared foundation:

1. **An internal, staff-only map** inside LimeHQ showing every property you
   currently manage — click a pin and see the address, a photo, the rent,
   bed/bath/size, lease dates, and who lives there. You can also flag a
   property or area as "we won't take new business here" (distance, HOA
   headaches, past problems — a business note, never a protected-class
   reason) so staff stop wasting time on leads in places you've already
   decided against.
2. **A public map** on limehousepm.com showing prospective owners and
   tenants, in broad strokes, everywhere Limehouse has ever managed —
   Virginia Beach, Norfolk, Chesapeake, Portsmouth, Suffolk. Just dots on a
   map. No addresses, no names, no photos — it exists purely to say "we
   have deep, real coverage here," not to identify any specific property or
   tenant.

Same map engine, same "ocean blue" branded look, two very different amounts
of information showing through depending on who's looking.

---

## How It Works

1. **Data lives in Limehouse's own database (Supabase), not fetched live
   from Buildium/RentEngine on every page view.** A background sync job
   pulls property, unit, lease, tenant, and photo data from Buildium, and
   vacant-unit asking rent from RentEngine, on a schedule — not every time
   someone opens the map.
2. **Internal map (inside LimeHQ):** staff are already logged into LimeHQ;
   Map reuses that login, no separate password. The map loads, centers on
   Hampton Roads, and shows a pin for every currently-active property.
   Staff can type an address in a search box, and the map re-centers there
   so they can see what's nearby.
3. **Click a pin (internal):** a popup opens with the address, a photo,
   current rent (or RentEngine's listed asking rent if vacant), bed/bath
   count and square footage, lease start/end dates, and the
   tenant's name and phone number.
4. **Flagging (internal only, admin-level access — see access restriction
   below):** Jason or an admin-level staff member can mark a property "do
   not pursue" from a short, fixed list of reasons (structure age/condition,
   never renovated, too far to service efficiently, past operational
   problems, or a documented staff-safety incident) — free-text reasons and
   neighborhood-name-only flags are intentionally not offered, per Mason's
   review. The rule is flagged BY CONDITION OR SPECIFIC INCIDENT, never by
   location alone: if every existing property on a given street happens to
   be old and never updated, they'll all end up flagged and the street will
   look greyed-out as a byproduct — but a torn-down-and-rebuilt property on
   that same street won't meet the criteria and won't be flagged. The
   staff-safety reason is the one exception requiring extra care: Mason
   flagged it as materially higher legal risk than the others (see
   `schema.md`'s decision record), and Jason made the informed call to
   include it anyway, scoped to one documented incident per property (never
   an area), reviewable on a set date. **Superseded 2026-07-20:** originally
   scoped as "Jason only" here — that's stale language from the initial
   Mason negotiation. Jason's later, broader access-restriction decision
   ("marking any property or area... is restricted to Jason and admin-level
   staff only") applies to every reason code, this one included, and is
   what actually got built: `map.exclusions.manage` (Owner + Admin), no
   narrower permission key exists for this reason code specifically.
   Flagged properties show differently on the internal map only — this
   never appears on the public site and never factors into any tenant/
   applicant decision. Each flag logs who flagged it, when, and which
   reason — light audit trail, cheap to build in now.
5. **Named-neighborhood exclusion tool (added after separate review — see
   decision record below):** staff can type a neighborhood/area name and
   exclude every property in it in one action, independent of the
   per-property flags in item 4.

---

## Decision Record: Named-Neighborhood Exclusion Tool

This feature went through the most extensive review of anything in Map.
Summary for the record:

- Mason (AI legal review) twice assessed a manual "type a neighborhood
  name, exclude the whole area" mechanism and both times advised against
  building it without attorney review, on Fair Housing disparate-impact
  grounds (citing *Texas Dept. of Housing v. Inclusive Communities*, and
  by analogy, insurance/lending redlining case law) — flagging this as a
  GOVERNANCE.md Rule 6 "Critical" change (decision criteria/guardrails).
- Jason disputed Mason's read at every stage, on the position that this is
  a B2B decision about which properties to solicit as new management
  business, unrelated to tenant rights, since no tenant/lease exists on a
  property Limehouse doesn't yet manage.
- Mason ultimately proposed a narrower, criteria-computed alternative
  (automatic exclusion based on year built/rent band/property type, with
  area/zip-code views used only to browse already-matched results, never
  as the exclusion trigger itself) as a version Mason would support without
  further review.
- **Jason confirmed his attorney reviewed and approved the original
  manual named-neighborhood mechanism, not the computed-criteria
  alternative.** Attorney: Michael Pallai, Dickerson & Smith Law.
  Confirmed to Jarvis 2026-07-20.
- Per GOVERNANCE.md Rule 6 ("Critical: owner approval + attorney review for
  compliance changes + 7 days shadow mode"), this satisfies owner approval
  and attorney review. Asimov (independent governance review, see
  `governance-review.md`) additionally required a **written** attorney
  artifact, not just a relayed verbal claim — **satisfied**: Jason
  confirmed 2026-07-20 that Michael Pallai's approval exists in writing
  (a text-message exchange, Jason's concerns sent as an image, Pallai's
  approval sent back in writing) — Jason is retaining that thread as the
  compliance record.
- **7 days of shadow mode, confirmed as final** (Jason declined Asimov's
  suggestion to extend it, noting the build will likely need tweaking
  regardless) — the tool logs what it would exclude without taking real
  effect for that window, Mason cross-checks the logged results against
  known historic redlining boundaries before anything switches on, then
  Jason reviews and decides whether to activate.
- **Area matching mechanism (added 2026-07-20):** the named-area tool
  matches properties by an admin-drawn boundary on the map (a polygon,
  stored as coordinates), checked against each property's own geocoded
  location — not by zip code. Jason: "Inside any one zip code could be
  100 neighborhoods so I don't want to exclude anything solely by zip
  code." A zip-code version was drafted and rejected for this reason.
- **Shadow-to-active permission (added 2026-07-20):** Owner + Admin, not
  Owner-only. Jason: "the only admin is my wife and I trust her judgement
  100%." Matches the general `map.exclusions.manage` policy rather than a
  narrower Owner-only carve-out.
- **Access restriction (added 2026-07-20):** marking any property or area
  as do-not-pursue — every reason code, including the four originally
  cleared ones, not just the two disputed ones — is restricted to Jason
  and admin-level staff only, never general staff. Since Map v1 has no
  individual staff logins yet (temporary shared password gate, pending
  LimeHQ), this requires a second, separate admin-only password
  specifically gating the flagging/exclusion features, distinct from the
  general staff viewing password. Revisit once LimeHQ's real roles ship.
5. **Public map (limehousepm.com):** no login. Shows an anonymous dot for
   every property Limehouse has ever managed, active or not, restricted to
   the 5 cities. No popups with identifying info — at most a dot and maybe
   a neighborhood label. A visitor can pan/zoom; there's no address search
   needed here since there's nothing private to protect by requiring one.

---

## What You'll See

**Internal (LimeHQ):** Open the "Map" tile from your LimeHQ home screen.
A full-bleed, deep-blue-themed map fills the screen, styled to match
Limehouse's branding, with a pin at every property you manage today. Type
"1420 Colonial Ave" in the search bar at top and the map flies to that
spot, showing your nearest managed units clustered around it. Click any
pin: a card slides up with the property's photo, the address, what the
tenant pays (or the asking rent if it's vacant), size, lease dates, and
who to call. A toggle lets you switch on "flagged areas" shading so you can
see at a glance where the team has already said no — click a flagged pin
and see who flagged it and why.

**Public (limehousepm.com):** A visitor lands on a page with the same
ocean-blue styled map, zoomed out over Hampton Roads, dotted generously
across all 5 cities. No pin gives away a specific address or tenant — it
just visually backs up "we manage a lot of real properties across this
whole region," which is the entire point.

---

## What Could Go Wrong

1. **Buildium doesn't have a photo for every property.** Not every unit has
   a current listing photo on file. *Handling:* show a plain placeholder
   ("photo not available") rather than a broken image or blank space.
2. **A sync runs stale or fails silently**, so the map shows a property as
   still active after it was sold, or shows last month's rent. *Handling:*
   this project should plug into the same "silent job failures become real
   alerts" pattern already built for Late Rent Notices (commit `bfc5a73`),
   so a broken nightly sync surfaces to you instead of quietly going stale.
3. **The public map accidentally leaks something identifying** — e.g. a
   developer reuses the internal pin/popup component for the public map and
   forgets to strip the tenant info out. *Handling:* the public map should
   be built as a genuinely separate, deliberately dumb view (fewer fields
   available to it at the data layer, not just hidden in the display) so
   there's no code path where private data can leak through — Sentinel
   should confirm this specifically before the public version goes live.
4. **Correction (2026-07-20, superseding the note below and the original
   Open Question 1): LimeHQ's login and permissions system is not
   scaffolding — it's real, live, and already used by Dashboard, Late Rent
   Notices, and Limona.** Confirmed by direct read of the `Limehouse-Fam-
   limehq` repo: real `users`/`role_templates`/`permission_catalog`/
   `role_template_permissions`/`user_permission_overrides` tables, real
   session/login code (`src/auth/`), and a working `hasPermission()` check
   already gating those three modules' routes. **No temporary password gate
   is needed.** Map integrates the same way those three already do: it
   registers its own permission keys (e.g. `map.properties.view`,
   `map.exclusions.manage`) in that same shared `permission_catalog`,
   grants the exclusion-management ones to Owner + Admin roles only
   (mirroring exactly how Limona restricts `limona.documents.manage`),
   and its routes sit behind the same `requireSession`/`hasPermission`
   checks. Staff just see Map as another option once already logged into
   LimeHQ — matching the original "no separate login" ask, just for the
   real reason (it's one login system, not two), not because Map skips
   auth entirely.

---

## What Q Needs to Build This

- Buildium API credentials (Jason has these) — for property, unit, lease,
  tenant, and file/photo data.
- RentEngine API credentials (Jason has these) — for vacant-unit asking
  rent. Note: RentEngine's public site does not publish API docs; Jason
  will need to request API documentation/access directly from RentEngine
  (their FAQ says "reach out to us for more information") before Q can
  build that half of the sync.
- A Supabase database (per Jason's standing rule) to hold the synced,
  map-ready copy of this data — Neo designs the actual tables.
- A background job/scheduler on Jason's Hostinger server to run the sync.
- A Google Maps JS API account/key (see decision below).
- LimeHQ's login system, for the internal version's "inherit login"
  requirement — currently spec-only, not yet built (see Open Questions).
- Brand assets (logo, colors, Quicksand font) — Jason already has these
  ready to hand to Tron when it's time to style the map.

---

## 1. Buildium API Research

**Source:** Buildium's public developer portal (`developer.buildium.com`)
and Buildium's own help-center articles. I was not able to pull the full
interactive schema (the live docs are large/interactive and didn't fetch
cleanly for this research pass) — before Q starts building, Q/Neo should
pull the actual OpenAPI/swagger spec from the developer portal directly
(Buildium publishes a downloadable schema) to confirm exact field names.
Everything below is confirmed at the level Q needs to plan, not to code
against blind.

**Auth:** API key pair, sent as two request headers:
`x-buildium-client-id` and `x-buildium-client-secret`. Jason enables the
API and generates these in Buildium's account settings / Developer Tools.
No OAuth login flow — simple to store as server-side secrets.

**Rate limit:** 10 concurrent requests per second across the account. Going
over returns an HTTP 429 ("too many requests"); Buildium's own guidance is
to back off and retry after ~200ms. This is generous for a background sync
job (which should be pacing requests anyway) and only becomes a concern if
something calls Buildium live, on-demand, per page view — which is exactly
why this spec recommends a sync-to-Supabase approach instead (see Section
4).

**What's available, resource by resource:**
- **Rental properties** — list/get/create/update. Property-level fields
  cover the address and general property info. Buildium also exposes an
  inactivate/reactivate action on properties (this lines up with the
  `is_active` concept this codebase already built for Late Rent Notices in
  commit `b71080e` — worth confirming during build whether Buildium's own
  active/inactive flag is the same signal already driving that column, or
  a separate one that needs reconciling).
- **Rental units** — list/get/create/update, per property. This is very
  likely where bed/bath count and square footage actually live (unit-level,
  not property-level, since a single property can have multiple units with
  different layouts) — needs field-level confirmation against the live
  schema before Q builds the sync, since search-based research couldn't
  pin down the exact field names.
- **Leases** — list/get/create/update, including lease start/end dates and
  rent schedules. Lease status values include Active, Future, Past/Expired
  — useful for showing "current" vs "upcoming" tenants correctly.
- **Tenants** — list/get/create/update, including name, email, and phone
  number fields, tied to a lease.
- **Files/photos** — Buildium added file upload/download/metadata support
  across several resource types, explicitly including **Rentals** and
  **RentalUnits**, in their "Open API Resource Expansion." This is a
  **separate call from the property/unit record itself** — you fetch the
  property or unit, then make a second call to list/download its files,
  filtered by category (Buildium organizes files into categories, so "unit
  photos" would need to be identified by category rather than assumed to
  be the only file type present). This confirms photos are fetchable via
  the API, but as a distinct document-storage endpoint, not an inline field
  on the property record.

**Gaps / things to verify before Neo designs the schema:**
- Exact field names for bedrooms/bathrooms/square footage (property vs.
  unit level) — confirm against the live schema or a sandbox call.
- Whether every property actually has a usable "primary" photo tagged in a
  predictable file category, or whether photo quality/presence is
  inconsistent across the portfolio (likely, given 230 units built up over
  time) — this directly feeds Risk #1 above.
- Whether Buildium's own "inactive" property flag is the same source this
  repo's `properties.is_active` column already syncs from (per commit
  `b71080e`, that column already tracks Buildium's active list) — if so,
  Map's "currently active" filter can likely reuse that exact same signal
  rather than re-deriving it, which would be good, since it avoids a
  second definition of "active" existing in two places.
- Whether Buildium retains records for properties no longer under
  management (sold, contract ended) in a way still queryable via the API,
  or whether those records eventually become unreachable/archived. This
  matters directly for the public map's "every property ever managed, past
  and present" requirement — see Open Question 3 below.

---

## 2. RentEngine API Research

RentEngine's public marketing site confirms an "Open API" exists and
states they sync to a property management system and support texting/CRM
features, but **publishes no public developer documentation** — their own
FAQ says "Yes we do [have an API]. Please reach out to us for more
information," meaning access and docs are gated behind a direct request to
RentEngine, not self-serve.

**Update:** Jason already has (or can self-serve create) a RentEngine API
key for this project directly through his own account — no vendor request
needed. Neo/Q will ask Jason for the key and endpoint details when the
sync job is actually being built.

---

## 3. Map Technology — Decided: Google Maps JS API

Oracle's original research compared Leaflet+MapTiler, Mapbox GL JS, and
Google Maps, and recommended Leaflet+MapTiler on cost and styling
flexibility grounds. **Jason's decision overrides that recommendation:**
he does not want to buy or depend on additional third-party services
beyond one well-known vendor, and has chosen Google Maps JS API for both
the internal and public map.

**Cost tradeoff, noted once for the record:** Google gives 10,000 free map
loads/month, then paid tiers starting around $100/month for the next
bracket. The internal staff map (7 people) will never approach that limit.
The public website map's traffic is less predictable — worth a light
usage check-in a month or two after launch (same guidance as Open Question
5 below, just against Google's pricing instead of MapTiler's).

**Styling implication:** Google's custom styling is more limited than
Mapbox/MapTiler — full control over custom pin icons and popups, but the
base map "chrome" (roads, water, labels) uses Google's styling API rather
than a fully open style editor. Tron should confirm Google's styling API
can hit the "ocean blue" look before deep into UI work; if it can't get
close enough, that's a conversation to revisit with Jason, not a silent
downgrade.

**Geocoding:** use Google's Geocoding API (same vendor, one relationship,
one API key) rather than mixing in a separate geocoding provider.

---

## 4. Data Sync Approach (high level — Neo designs the real schema)

The map should never call Buildium or RentEngine live while someone is
looking at it. Instead:

- **A scheduled sync job** (running on Jason's Hostinger server, similar in
  shape to the existing Late Rent Notices Buildium sync) pulls property,
  unit, lease, tenant, and photo data from Buildium, and vacant-unit rent
  from RentEngine, into Supabase on a regular schedule — daily is almost
  certainly often enough for this use case (property/lease/tenant changes
  aren't minute-to-minute events), rather than hourly or real-time.
- **What triggers an extra refresh, beyond the daily schedule:** a staff
  member typing a brand-new address into the internal search bar doesn't
  need a Buildium refresh at all — that's just geocoding an arbitrary
  address the visitor typed, unrelated to synced property data.
- **What gets cached in Supabase (used by the map on every page load):**
  property address + coordinates, unit bed/bath/sqft, current lease dates,
  current tenant name/phone, current rent or vacant asking rent, a
  reference to (or cached copy of) the property's photo, and the
  active/inactive flag and any "won't take business here" flag.
- **What should stay a live call, not cached:** nothing, really, for this
  project — unlike Late Rent Notices (which needs up-to-the-minute
  ledger data for legal notices), a map showing "roughly current" property
  info that's at most a day old is entirely acceptable and is the whole
  reason to cache instead of hitting Buildium live per page view.
- **Photos specifically:** the sync job should download and store a copy
  of each property's chosen photo (e.g. in Supabase storage) rather than
  hot-linking to a Buildium-hosted URL on every popup open — this avoids
  the map's performance depending on Buildium's file-serving speed and
  avoids counting every popup-open as a live Buildium API call.

---

## 5. Open Questions and Risks Jason Should Know About Before Building Starts

1. **LimeHQ's login isn't built yet.** I checked the LimeHQ project
   (`Limehouse-Fam-limehq`) directly: its own spec
   (`projects/limehq/docs/auth-spec.md`, written 2026-07-16) is approved
   in design but its README states plainly: *"Status: scaffolding only —
   no login or permissions logic is built yet."* The plan in that spec is
   sound and Map fits it cleanly (Map would become one more "module" in
   LimeHQ's permission system, e.g. `map.properties.view`,
   `map.exclusions.edit`, receiving a short-lived signed handoff token from
   LimeHQ the same way Dashboard and Late Rent Notices are planned to).
   But practically: **Map's internal version can't "just inherit LimeHQ
   login" until LimeHQ's login is actually built.** This isn't a reason to
   not write this spec now, but it does mean the internal version of Map
   has a real dependency that should be sequenced — either LimeHQ auth
   ships first, or Map's internal version launches with a short-term
   simple password gate as a placeholder, to be swapped for the real
   handoff once LimeHQ's system exists. Jason's call which order makes
   sense.
2. **RentEngine API access:** Jason already has or can self-create a key
   directly through his own RentEngine account — no external vendor
   request needed. Neo/Q will ask him for it when building the sync job.
3. **"Every property Limehouse has ever managed, past and present" needs a
   verified data source.** This repo's own recent work
   (commit `b71080e`, "Add properties.is_active; exclude inactive
   properties from all live queries") shows the properties table already
   distinguishes active from inactive — and that same commit's data-fix
   script marked 126 stale properties inactive (sold/historical/duplicate
   records), with zero deleted. That's good news for the public map's
   "past and present" requirement in principle — inactive properties are
   flagged, not deleted, in Limehouse's own database. But it needs
   confirming on the Buildium side too: does Buildium's API still return a
   property once Buildium itself considers it inactive/off the account, or
   does it eventually stop being queryable? If Buildium stops returning
   very old inactive properties, the "ever managed" public map may need to
   rely on Limehouse's own already-synced historical records (which
   persist, per the commit above) rather than re-querying Buildium for
   history every sync — meaning the sync logic should be additive/
   preserving (never delete a previously-synced property from Supabase just
   because a later Buildium sync doesn't return it), mirroring exactly the
   "deactivate, never delete" approach already proven out in `b71080e`.
4. **Photo coverage will likely be inconsistent across 230 units** built up
   over time — some properties may have no usable photo in Buildium at
   all. Plan for a placeholder image state (Risk #1 above) rather than
   assuming full coverage.
5. **Geocoding/map-load cost is genuinely open-ended on a public page** —
   an internal staff tool has bounded, predictable usage (7 people,
   occasional address lookups), but a public marketing-site map's traffic
   is not fully knowable in advance. Google Maps' free tier (10,000 loads/
   month) likely covers Limehouse's actual traffic for a while, but unlike
   MapTiler's cheaper overage, Google's next tier jumps to ~$100/month —
   worth a light usage check-in a month or two after the public map goes
   live rather than assuming it's a "set and forget" cost.
6. **The exclusion/"won't take business here" flag must stay strictly
   internal and must never influence anything shown to or decided about an
   actual applicant or tenant** — it's a lead-routing convenience for
   staff, not a screening tool. Worth a quick sanity check with Asimov once
   this is built, purely to confirm the internal flag has no path into any
   tenant-facing decision, even though this spec doesn't treat Map as a
   tenant communication or decisioning tool.

---

## Suggested Next Steps (pipeline)

1. Jason approves or redirects this spec.
2. Neo designs the Supabase schema for synced property/unit/lease/tenant/
   photo data, the exclusion-flag table, and confirms with the live
   Buildium schema on the field-name gaps noted in Section 1.
3. Q builds the sync job first (no map UI yet), so Neo/Jason can verify the
   data looks right before any map rendering work starts.
4. Tron builds the map UI (internal, then public), using Google Maps JS
   API (per Jason's decision above) and Jason's brand assets.
5. Sentinel reviews the public/internal data-separation boundary
   specifically (Risk #3).
6. TARS tests both versions with real data before anything ships.
