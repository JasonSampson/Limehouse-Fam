# Vendor Site Reference — Confirmed Data Sources

Working notes on how the vendor's dashboard (`limehouse.rtcsapps.com`) actually
computes each number, gathered from real screenshots Jason has shared and from
direct RentEngine API checks. Kept here so this doesn't get lost between
sessions or lost to context compaction — update as each tab gets its deep dive.

I don't have working browser access to the vendor's site (navigation is
sometimes allowed, but reading page content is always denied by the Chrome
extension) — everything below came from screenshots Jason pasted directly, or
from direct RentEngine API calls on our side.

## Key recurring pattern (check this first on every new tile)

The vendor's drill-downs for "activity count" tiles (Total Calls, Outbound
Texts, and what we first assumed for Showings Completed) are **per-unit
aggregate tables pulled from the same per-unit `/reporting/leasing-performance/
units/{id}` report the tile's own number already sums** — NOT row-level record
lists. We wrongly assumed row-level records multiple times this session before
catching it against real screenshots. When investigating a new "count" tile,
check the per-unit leasing-performance fields first before assuming a
dedicated row-level report is the source.

## Marketing & Showings tab — DONE, all confirmed/committed

| Tile | Real source | Notes |
|---|---|---|
| New Prospects | Raw count from `/prospects` (created_after/created_before) | NOT the summed `new_prospects` field from leasing-performance — that undercounts. Confirmed via two vendor screenshots (273=273=273, then 715=715=715 across tile/by-source/funnel). |
| Showings Completed | Count of `/reporting/showings` rows with `status` "Showing Complete" | Filtered by `created_at` (when logged) falling within the period, using **Eastern calendar day**, not raw UTC — a record logged late at night ET can be early morning UTC the next day and vice versa. RentEngine's own start/end query params filter by `planned_date_time` (scheduled time), not `created_at` — we filter again on our end by `created_at` to match what's displayed and what the vendor scopes to. |
| Showings Completed — Method | `showing_agent` field: null/blank = "Self Guided", any name present = "Accompanied" | NOT `prospect_type` — that field is always `"Self"` on every record regardless of actual method; not a real signal. |
| Showings Completed — drill-down | Grouped by property address, oldest→newest within each address group | Columns: Address / Status / Method / Date. Date = `created_at`, formatted mm/dd/yyyy + 12hr Eastern time (Jason's explicit preference, not the vendor's plain-date format). |
| Completion Rate | Showings scheduled/completed scoped to units whose `/units` status is NOT "Leased" | Established earlier in the broader session; confirmed against vendor's own drill-down. |
| Total Calls | Sum of `total_calls` field from per-unit leasing-performance report | NOT `/reporting/calls` (row-level report) — that's a different, unused data source for this tile. Drill-down: per-unit table (Address/Status/Calls), sorted by calls descending. Address used instead of the vendor's bare unit number, per Jason directly. |
| Outbound Texts | Sum of `outbound_texts` field from the same per-unit leasing-performance report | Same pattern as Total Calls. Drill-down: per-unit table (Address/Status/Texts), sorted descending. |
| New Prospects by Source | `/reporting/marketing-sources` report | Separate/unrelated data source from the raw New Prospects count above — don't conflate them. |
| Days on Market / Median DOM / Property Health | Per-unit leasing-performance fields `days_on_market` / `property_health` | |
| Units on Market | `/units` endpoint `status` field via `isUnitOnMarket` (Available or On Hold) | |

## RentEngine API quirks confirmed live this session

- `prospect_type` is always `"Self"` — not a usable field for anything.
- `/reporting/showings` and `/reporting/calls` start/end params filter by the
  report's own natural date field (showings: `planned_date_time`; calls:
  appears to already align with `created_at`, no mismatch found) — don't
  assume created_at filtering without checking.
- All calendar-day boundary logic must use `America/New_York`, not raw UTC —
  the whole business (and the vendor's own dashboard) operates in Eastern
  time.
- The vendor's own site is NOT instantly live — it has its own "Sync now"
  button and a "Synced [timestamp]" indicator, confirmed by Jason manually
  syncing and watching a number change. Don't assume a vendor screenshot is
  perfectly real-time; note the sync timestamp if visible.
- RentEngine's per-unit leasing-performance crawl (~61-70 units) occasionally
  skips a unit on transient fetch failures — small unit-count/number drift
  between two of our own back-to-back requests is expected, not a bug.

## Team Performance tab — foundational work already done (day 1+)

This section is NOT from today's screenshots — it's pulled directly from the
already-committed code (`src/api/teamPerformanceRoutes.ts`,
`public/js/team-performance.js`, `migrations/0009_seed_confirmed_kpi_definitions.ts`,
`migrations/0010_seed_leasing_specialist_kpis.ts`, `src/db/kpiRepository.ts`) so
the earlier confirmed work isn't lost before the fresh deep-dive starts. All of
this is real, live, already built and running — the deep dive is about
re-verifying it against fresh vendor screenshots and catching anything that's
drifted or was never fully confirmed.

### Roles (6 total)

`portfolio_manager`, `portfolio_assistant`, `bookkeeper`, `leasing_specialist`,
`marketing_specialist`, `administrative_assistant` — display names in
`src/db/kpiRepository.ts`'s `ROLE_DISPLAY_NAMES`.

CEO View only shows 3 of these, as role-category rollups, with different
display names there: Portfolio Manager (same name), Portfolio Assistant →
"Assistant Property Manager", Bookkeeper → "Bookkeeping Coordinator". Confirmed
live 2026-07-05 that Leasing Specialist/Marketing Specialist/Administrative
Assistant never appear on CEO View.

### Scoring bands (confirmed, used for every KPI)

| Band | Condition | Payout share |
|---|---|---|
| BEST | meets/exceeds target | 100% |
| BETTER | within 10% of target | 66.7% |
| GOOD | within 20% of target | 33.3% |
| RED | missed by more than 20% | $0 |
| NO DATA | no data yet | excluded from scoring entirely (doesn't count toward or against the total) |

### Per-role KPIs — confirmed targets/bonus structure

**Portfolio Manager** — 4 KPIs, $1000 max quarterly bonus, $250/KPI:
- Portfolio Occupancy Rate ≥95%
- Lease Renewal Rate ≥70%
- Days on Market ≤21 days
- Delinquency Rate ≤3%
- CEO View rollup shows only Occupancy + Delinquency (confirmed live 2026-07-05 — NOT Renewal Rate or Days on Market).

**Bookkeeper** — 4 KPIs, $500 max, $125/KPI (same 4 on CEO View, as "Bookkeeping Coordinator"):
- Reconciliation Accuracy ≥100%
- Rent Processing Accuracy ≥100%
- Vendor Compliance ≥100%
- 1099 Compliance ≥100% (known simplification — the vendor's real target is a *deadline* "100% by Jan", not a plain threshold; scoring engine only supports >=/<= today, flagged in `src/kpi/bookkeeperMetrics.ts`)

**Leasing Specialist** — 3 KPIs, $500 max, $166.67/KPI (confirmed against the vendor's own "3 KPIs × $167 max each" legend text, 2026-07-06). NOT shown on CEO View.
- Applicant Response Timeliness ≥95% — live
- Application Processing Time ≤48h — live
- Renewal Follow-Up Timeliness ≥95% — **definition seeded, snapshot NOT wired** (Jason's description "Completed tasks in Lease Renewal Process" doesn't specify the same mechanics confirmed for Applicant Response Timeliness — will show "No data" honestly rather than a guessed formula)

**Portfolio Assistant** — 3 KPIs, $750 max, $250/KPI (confirmed against a real vendor screenshot, 2026-07-20 — "3 accountability KPIs · $750 max quarterly bonus"). Appears on CEO View as "Assistant Property Manager." All 3 are now seeded and live (migrations 0011/0012):
- Showing Completion Rate ≥95% — live, RentEngine-sourced (same `summarizeShowingCompletionRate` already built for the Dashboard tile)
- Property Readiness ≥100% — live, LeadSimple-sourced (06 Move In Process tasks, on-time-by-due-date rate) — **known discrepancy vs. vendor's own number, see below**
- Resident Response Time ≤24h — live, LeadSimple-sourced (Addison's email/todo/meet tasks, real business-hours elapsed time — see `src/kpi/businessHours.ts`) — **known discrepancy vs. vendor's own number, see below**

**Marketing Specialist** — zero KPI rows configured, matching the vendor's own real unconfigured state as of the last check (migration 0002 comment). Worth re-confirming this is still true.

**Administrative Assistant** — mentioned in comments as having a "Leasing Response Time" KPI, not yet confirmed. Needs fresh investigation.

### Confirmed formulas (11 KPIs have live, vendor-verified formulas — full text in `KPI_EXPLAIN_FORMULAS` in `teamPerformanceRoutes.ts`)

| KPI | Formula (short) |
|---|---|
| Portfolio Occupancy Rate | Occupied ÷ total managed units (incl. 1 commercial), excluding terminated-but-not-yet-closed-out properties. Occupied = real Active lease with a current tenant. |
| Delinquency Rate | Sum of outstanding balance (leases with positive balance) ÷ sum of monthly rent across every active lease. |
| Reconciliation Accuracy | % of fully-completed months this period with a finished bank reconciliation. Partial current month never counts. $0-balance/no-recon accounts excluded. |
| Rent Processing Accuracy | 1 − (operational payment reversals ÷ total payments). NSF/bounced/chargeback excluded (tenant-caused, not processing error) but listed for reference. |
| Vendor Compliance | Of active maintenance/trade vendors (Contractors category), % with both tax ID on file AND current liability insurance. |
| 1099 Compliance | Of active vendors flagged for 1099 reporting, % with a tax ID on file. |
| Days on Market | Avg days on market, RentEngine units with property_health "Healthy" only (excludes At-risk/Waitlist/On Hold/Off-Market/Commercial). |
| Application Processing Time | Avg hours from application received to closed, across Applications Processes that closed this period. |
| Applicant Response Timeliness | Of applications in the trailing 90 days, % where the FIRST task completed within 24h. No completed task yet = counts against the rate. Deliberately 90-day fixed window, not tied to the period selector. |
| Showing Completion Rate | Showings completed ÷ scheduled, AVAILABLE listings only (RentEngine status ≠ "Leased"). RentEngine doesn't split accompanied vs self-guided so neither side can exclude self-showings. |
| Lease Renewal Rate | Renewed ÷ decided, across Lease Renewal Processes created in the trailing 12 months. "Decided" excludes still-in-progress (Upcoming, Send Lease). "Renewed" = completed Lease Renewed outcome. |
| Property Readiness | Of the tasks in LeadSimple's 06 Move In Process due this period, % completed by their due date. Not-yet-completed counts against the rate. |
| Resident Response Time | Avg real business hours (Mon-Fri 9am-5pm America/New_York, excl. US federal holidays) for Addison to complete her own email/todo/meet LeadSimple tasks, creation to completion. |

Each of these already has a working drill-down (`/api/team-performance/kpi-explain/:kpiName`) returning the real underlying records — column shapes are in `KPI_EXPLAIN_COLUMNS` in `team-performance.js`.

### Known, accepted discrepancies (real numbers, disclosed population mismatch — not bugs)

- **Property Readiness**: Jason's real vendor screenshot for (2026-07-01 – 2026-07-18) showed "76.1% on time (51/67)"; the equivalent live query here for (2026-07-01 – 2026-07-20, just 2 days wider) returns 232 tasks due in-window (9.9%). Restricting to only still-open move-in processes narrows it to 137 — still nowhere near 67. Investigated live 2026-07-20 (open/closed process, unique-process-count, narrower windows) — no rule found reproduces the vendor's population. Jason doesn't have visibility into the vendor's internal filter either. Kept live per Jason directly, 2026-07-20: "Keep them live, document the discrepancy."
- **Resident Response Time**: vendor screenshot for the same window showed exactly 8 tasks; the live query returns 102-104 of Addison's completed email/todo/meet tasks (63 Move In, 29 Marketing, 10 no-process, 2 Onboarding by process type — no subset isolates ~8). Same disposition: kept live, disclosed here and in code comments in `src/leadsimple/client.ts`.
- If a narrower rule is ever confirmed for either (e.g. a specific task-name pattern, a shorter trailing window, or vendor documentation becomes available), revisit both the fetch and summarize functions in `src/leadsimple/client.ts` together.

### Open items flagged in the code but not yet resolved

- Renewal Follow-Up Timeliness (Leasing Specialist) — formula not confirmed, shows "No data" honestly.
- Leasing Response Time (Administrative Assistant) — not yet confirmed.
- 1099 Compliance modeled as a plain ≥100% threshold as a known simplification of the vendor's real deadline-based target — flagged, not fixed.
- Marketing Specialist — zero KPIs configured; confirm this still matches the vendor's real state before assuming it's still accurate.

### Next step for the fresh deep-dive

Get screenshots of the vendor's Team Performance tab (all 6 role cards) plus
each KPI's drill-down, and check every item above against what's actually
there now — both the ones already confirmed (in case something drifted) and
the open items still needing a real formula.
