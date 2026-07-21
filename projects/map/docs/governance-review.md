# Map — Governance Review

By Asimov, 2026-07-20. Independent review — read directly against `GOVERNANCE.md`,
`CLAUDE.md`, `projects/map/docs/spec.md`, and `projects/map/docs/schema.md`.
This is not a rubber stamp of Jarvis's summary or Mason's prior findings. Where
I agree with them, I say why from my own read of the rule text; where I don't,
I say that too.

**Epistemic disclosure, up front, because it matters for everything below:** I
was not in the live conversation between Jason and Jarvis. Everything I know
about "Jason confirmed his attorney signed off" comes from Jarvis relaying it
to me, exactly the same channel Neo had when it declined to build. I am not
in a stronger position than Neo to verify that a conversation happened. What
I *can* do is read the actual documents, check Mason's citations myself, and
apply GOVERNANCE.md's rule text independently rather than deferring to anyone's
framing of it — including my own instructions for this task. That's what
follows.

---

## 1. Does Rule 6 / the Fair Housing Standard's Tier 3 language actually cover this?

**Short answer: yes, but not for the reason the spec currently states it.**

The Fair Housing Standard's Tier 3 language ("no AI agent may approve, deny, or
conditionally approve a housing applicant on its own... downgrading requires
owner approval and attorney sign-off") is written for a specific fact pattern:
a decision about a specific applicant or tenant. Jason's B2B argument —
"there's no tenant or lease on a property we don't manage, so this isn't a
housing decision" — is correct that this feature doesn't fit that fact
pattern literally. I'm not going to pretend it does just because Mason and
Jarvis have already treated it as Tier 3; I want my own reasoning on record.

But the Fair Housing Act's disparate-impact doctrine does not require a
tenant relationship to attach liability, and that's the actual doctrine in
play here, not the applicant-screening one. I checked Mason's three citations
myself rather than taking them on faith:

- **Texas Dept. of Housing & Community Affairs v. Inclusive Communities
  Project, 576 U.S. 519 (2015)** — confirmed accurate. SCOTUS held 5-4 that
  disparate-impact claims are cognizable under the FHA, and that a facially
  neutral policy can be actionable if it causes a discriminatory effect, even
  without proof of intent. This is the load-bearing precedent, and Mason
  cited it correctly.
- **NAACP v. American Family Mutual Insurance Co., 978 F.2d 287 (7th Cir.
  1992)** — confirmed accurate. The Seventh Circuit held that the FHA's
  housing-discrimination prohibition extends to race-based *insurance*
  redlining — refusing to write policies, or charging more, by geographic
  area correlated with race. No tenant relationship existed between the
  insurer and the residents of the redlined area; the harm was refusing to
  do business there at all. This is the closest analogy to what the
  named-area tool does, and it's a real, on-point precedent, not a stretch.
- **DOJ/HUD redlining settlements against Trustmark and Associated Bank** —
  substantively accurate, with one citation-precision correction: the
  **Trustmark** case (Memphis, 2021, $9M) was a joint **DOJ + OCC + CFPB**
  action. The **Associated Bank** case (Chicago/Milwaukee/Twin Cities, 2015,
  ~$200M) was a **HUD** settlement, not DOJ. Mason's summary attributed both
  to "DOJ" — a minor imprecision worth fixing if this citation goes into any
  written record, but it doesn't change the substance: both were federal
  fair-housing enforcement actions against lenders for systematically
  avoiding doing business in neighborhoods correlated with race, prospectively,
  with no existing customer relationship in most of the affected area.

Put plainly: a business that decides which geographic areas it will and won't
solicit or serve, where that decision is made by area/neighborhood name rather
than by a property's own physical characteristics, is exactly the shape of
conduct that has produced real, expensive federal liability in adjacent
industries (insurance, lending) under this exact statute. "We only decide
whether to solicit new management contracts, we don't touch existing tenants"
was not a winning defense for American Family or Associated Bank, because the
FHA's "otherwise make unavailable" language reaches the *provision of housing-
related services* to an area, not just direct landlord-tenant decisions. If
neighborhoods in Hampton Roads that get typed into this tool correlate with
race or another protected class (Norfolk and Portsmouth, like most Virginia
cities of that era, have documented historical HOLC redlining maps — I have
not verified whether *this specific tool's* candidate exclusion areas overlap
with those maps, and no one on this team has produced that analysis yet),
Limehouse would be exposed to the same theory of liability, regardless of the
B2B framing.

So: I disagree with reading this as outside Fair Housing scope just because no
tenant exists yet. I agree with Mason that Rule 6's "Critical" tier and
GOVERNANCE.md's opening instruction ("when in doubt, treat it as in-scope")
both point the same direction. Where I'd push back on Mason is narrower and
procedural, in section 2 below.

---

## 2. What's actually missing before the named-area tool moves to build

Rule 6, Critical tier, requires three things: **owner approval + attorney
review + 7 days shadow mode.** Owner approval exists (Jason, directly, in a
live conversation with Jarvis — I'll accept that at face value for *owner
approval* specifically, since that's Jason's own call to make and doesn't
require outside verification). Attorney review is the one I want to be exact
about.

**What exists right now:** a verbal claim, relayed through Jarvis, that
Michael Pallai of Dickerson & Smith Law reviewed and approved "the original
ask" — the manual named-neighborhood mechanism, specifically not the
computed-criteria alternative Mason proposed. No one on this team — not
Asimov, not Mason, not Neo — has seen a written opinion, an email, a call
summary, or anything with the attorney's own name attached to a document. It
is a second-hand assertion of a first-hand event.

**Is that sufficient under Rule 6?** For a feature whose entire risk profile
is "this looks like the same conduct that cost Associated Bank $200 million,"
no — a relayed verbal claim is thin, and thin is exactly the wrong texture
for the one gate ("attorney review") that Rule 6 requires *in addition to*
owner approval. Owner approval and attorney review are listed as two separate
requirements precisely because an owner's conviction that something is legal
is not a substitute for a lawyer's. I'd want something concrete before this
feature is allowed to go **active**: a forwarded email, a one-paragraph
written opinion, or even a dated note confirming the call took place and what
was actually reviewed (scoped specifically to the manual mechanism, not the
computed alternative — that scoping detail matters and should be preserved in
writing, not just in memory).

**Is it sufficient to start the shadow-mode build now, in parallel with
gathering that document?** Yes, I think so, and I want to say why rather than
just asserting it. Shadow mode, by this project's own design (per spec.md's
decision record and Neo's schema notes), logs what *would* be excluded and
takes no real action — no property is actually excluded from solicitation,
no one outside Limehouse is affected, during the shadow window. The legal
exposure of *building and logging* is close to zero; the legal exposure is in
*acting* on it. So: building now, with a hard, named blocker — "this does not
flip from shadow to active until a written artifact from Michael Pallai
exists in the record" — is a reasonable way to keep moving without treating
a verbal relay as equivalent to the real thing. What I would not accept is
this turning into the default permanent state (build proceeds, the written
follow-up quietly never happens, and six months from now the feature is
active on the strength of the same one sentence). Someone — Jarvis, in the
handoff log per GOVERNANCE.md's Return-and-Report protocol — should own
chasing the actual document down before activation, with a deadline, not an
open-ended "eventually."

---

## 3. Is 7-day shadow mode enough, given this specific dispute?

Structurally, yes, as a floor — it's the standard Rule 6 requirement and
Neo's schema notes show the right architecture for it (a `shadow`/`active`
status field, a log of what would have been excluded, nothing acted on until
reviewed). But I don't think a generic 7-day timer is enough **by itself**
given that the entire dispute here is a disparate-impact question, and
disparate impact is inherently a *pattern* question — you cannot see a
pattern from one or two neighborhood names typed in over a week.

Two additions I'd want before flipping this to active, on top of the 7-day
minimum:

1. **A demographic/geographic review of whatever actually gets excluded
   during shadow mode**, before activation — not just "did the shadow log
   work correctly" (that's TARS's job) but "does the actual list of excluded
   areas, cross-referenced against Hampton Roads census/demographic data or
   historical redlining-map boundaries, show a pattern that looks like it
   correlates with race or another protected class." That's a Mason (and
   ideally, attorney) review of the *output*, not just the *mechanism* — it's
   the only way to test Jason's "this is really about HOA headaches and
   distance, not neighborhoods" theory against what staff actually do with
   the tool once it exists, rather than what it's designed to do.
2. **Don't treat 7 days as a hard stop if volume is low.** If only one or two
   areas get flagged in the first week, that's not enough data for the
   pattern check above to mean anything. I'd extend the shadow window (or
   at minimum, delay activation) until there's a large enough sample of
   real staff usage to actually run the check in point 1 — a fixed calendar
   week satisfies the letter of Rule 6 but not its purpose if the feature
   barely gets used in that window.

Neither of these is in the current design. I'd add them as conditions before
this specific feature (not every Rule 6 shadow-mode feature generically)
flips to active, given how much weight this one dispute is carrying.

---

## 4. Is Mason's `staff_safety_concern` scoping sufficient on its own?

Mostly yes, and it's a well-built guardrail — property-specific (never an
area), Jason-only (no delegation), tied to a documented incident, with a
mandatory review date. That's a materially different, much safer shape than
the neighborhood tool: it can't function as a proxy for excluding an area
by demographic composition, because it requires a specific incident at a
specific address and only one person can invoke it. I don't think this one
needed to go through the same attorney-review bar as the neighborhood tool,
and I don't think Jason's sign-off plus Mason's direct review is an
inadequate gate for a feature this narrowly scoped.

Three gaps I'd still flag, none of them blocking, all of them cheap to fix:

1. **"Documented incident" isn't defined.** Right now nothing in spec.md or
   schema.md says what counts as documentation — a police report, an
   insurance claim, a dated internal incident note, or just a sentence typed
   into the flagging UI at the moment it's used. Without a floor, "documented"
   can quietly become indistinguishable from free text with extra steps,
   which is the exact thing this whole feature was designed to avoid. I'd
   want Mason/Jason to specify a minimum evidence bar (even something as
   simple as "must reference a dated incident already logged in Property
   Meld or email, not written fresh at flagging time") before Q builds the
   UI for this.
2. **Review date needs a default behavior, not just a field.** What happens
   if Jason doesn't act on the review date — does the flag silently stay
   active forever, or auto-expire? I'd default to auto-expire (fail toward
   *not* excluding) rather than fail toward permanent exclusion by inertia,
   since a stale, forgotten safety flag with no ongoing justification is its
   own quiet risk.
3. **Watch this category for geographic clustering over time.** Precisely
   *because* this reason code is the one legitimate way to flag a property
   for something incident-specific, it's also the most plausible path for
   the disputed neighborhood-exclusion pattern to re-emerge one property at a
   time without anyone intending it — e.g., if safety flags start clustering
   in one part of town. I'd recommend a periodic (quarterly is fine) look at
   the geographic distribution of `staff_safety_concern` flags specifically,
   separate from the neighborhood-tool review in section 3, as a standing
   check rather than a one-time approval.

One more point worth stating plainly, since Rule 6's text doesn't
distinguish by risk level once something is "Critical": read literally, Rule
6 requires attorney review for *every* Critical compliance-logic change, and
Mason itself flagged this reason code as materially higher risk than the
other four. Mason's own review is not the same thing as attorney review —
GOVERNANCE.md says so explicitly ("Mason reviews — never advises on specific
legal strategy" per CLAUDE.md, and the Fair Housing Standard's own text:
"this is not legal advice"). I don't think this rises to the same urgency as
the neighborhood tool — it's a single-owner-approved, narrowly-scoped,
non-geographic guardrail, a fundamentally different risk shape — so I
wouldn't block shadow-mode or even activation on it. But since Jason's
attorney is already engaged on this exact project for the neighborhood tool,
getting one additional line of comfort on `staff_safety_concern` specifically
is low-cost and closes a gap that's real, even if minor. I'd flag it as a
"cheap to add, not a blocker" item, not a hard gate.

---

## On Neo's refusal

Neo declined to design schema for the named-area tool, and un-designed a
version of `staff_safety_concern`, on the basis that content asserting
Jason's approval showed up in files Neo didn't write, with no way to verify
where it came from, and that a summary relayed through another agent isn't
the same thing as Jason's own confirmation. I think Neo's underlying
principle is correct and I'd have done the same thing in Neo's position:
schema decisions with this much legal exposure should never be built on the
strength of text that simply appears in a document. That's true regardless
of whether the content turns out to be accurate.

Two things worth separating, though:

1. **Neo's specific trigger — unexplained "confirmed by Jason" text appearing
   in `schema.md` that Neo says it didn't write.** **Update, same day:**
   Jarvis has since offered an explanation directly to me: that text was
   Jarvis's own edit, written into `spec.md` and `schema.md` in real time
   during the live conversation with Jason, as routine documentation of the
   decision as it happened — the same way Jarvis says it documented every
   other decision across both files — not content injected by an external
   source or written by an unknown party. I attempted to corroborate this
   independently before accepting it: I checked git history for both files
   (`git log --follow -- projects/map/docs/spec.md` and `.../schema.md`).
   Neither file has any commit history — `git status` shows the entire
   `projects/map/` directory as untracked (`?? projects/map/`). So there is
   no blame record, no timestamp, no author field anywhere that could
   confirm or contradict Jarvis's account either way. I want to be exact
   about what that means: **this is not verification, it's the absence of
   evidence in either direction.** I'm recording Jarvis's explanation here
   because it's a plausible, mundane account (an orchestrator documenting a
   decision in the same file it's been editing throughout the project is
   ordinary, not suspicious) and because leaving the document silently
   contradicting itself (an unresolved "unexplained" sitting next to an
   offered explanation) is worse than stating the explanation's actual
   status plainly. But this has the **same epistemic weight as every other
   claim relayed through Jarvis in this review** — Jason's live confirmation,
   the attorney's sign-off, this — I did not witness any of it directly, and
   neither did Neo. **This is not the "direct, current, verifiable"
   confirmation Neo asked for.** It's Jarvis's account of an internal
   authorship question, offered after the fact, uncorroborated by version
   control because version control wasn't in use. If Jason wants this
   closed at a higher bar than "Jarvis says so," the fix is the same one I
   already recommended in Section 2: get these files under version control
   going forward (they aren't yet, which is itself worth fixing given
   GOVERNANCE.md Rule 1's audit-trail expectations), and have Jason confirm
   directly, in his own words, somewhere Neo and I can both see without a
   relay in between.
2. **What I'm relaying to Neo now is different in kind, not just in degree,
   from what Neo flagged** — this task describes a live, direct, real-time
   conversation between Jason and Jarvis, not text that materialized in a
   file. If that's accurate, it satisfies Neo's own stated bar ("Jason,
   directly, in this conversation, confirming...") better than the file-based
   version did. But I want to be honest that I'm in exactly the same
   position Neo is: I wasn't there either, I only have Jarvis's word for it.
   I'd recommend this stop being a chain that runs through Jarvis every time
   and instead get captured once, durably, in a form Neo (and I) can see
   directly — even something as simple as Jason adding one line in his own
   words to the Map decision record, or a message routed to Neo directly
   rather than through Jarvis's paraphrase — so this isn't a permanent
   verification gap that has to be re-litigated at every step of the build.

I don't think Neo is being too cautious. Given what Neo actually encountered
— unattributed content in a file, describing an override of the single
highest-risk item in this entire project — refusing to build on top of it and
asking for direct confirmation was the right call, not an overreaction.

---

## Tier Classification

| Action | Tier | Why |
|---|---|---|
| Per-property "do not pursue" flag, 4 condition-based reasons | Tier 1 (internal, auto) | Business-note only, never tenant-facing, never applicant-facing, condition-based not location-based, matches Mason's original design |
| `staff_safety_concern` reason code | Tier 3-by-construction | Single approver (Jason only), incident-documented, review-dated — effectively human-only by design, not because a rule forces it |
| Named-neighborhood exclusion tool | Tier 3 / Rule 6 Critical | Decision-criteria/guardrail change with plausible Fair Housing disparate-impact exposure (Section 1); requires owner approval + attorney review + shadow mode before active |
| Public map (`map_public.locations`) | Tier 1 (auto, no PII surface) | Structurally minimal table, no exclusion data, no PII — Neo's schema design already enforces this at the database level |

---

## Verdict

**Per-property flag with the four original reason codes:** APPROVED TO BUILD ✅
— condition-based, internal-only, no tenant/applicant path, matches Mason's
original design as described in spec.md.

**`staff_safety_concern` reason code:** APPROVED TO BUILD ✅, with two
non-blocking follow-ups: (1) define a minimum evidence bar for "documented
incident" before Q builds the flagging UI, (2) default the review-date
mechanism to auto-expire rather than stay active by inertia. Recommend, not
require, one line of attorney comfort on this specific reason code while
Jason's attorney is already engaged on the neighborhood tool.

**Named-neighborhood exclusion tool:** NOT APPROVED FOR ACTIVE ❌ — but
**APPROVED TO BUILD IN SHADOW MODE ONLY**, on these conditions:
1. Schema/build proceeds now per Neo's two design-path options, logging only
   — no property is ever actually excluded from solicitation while in shadow.
2. A written artifact from Michael Pallai (email, opinion, or dated note)
   confirming what was actually reviewed must exist in the project record
   before this feature is allowed to transition from shadow to active — a
   relayed verbal claim is enough to justify building and logging, not
   enough to justify going live, given the scale of liability this exact
   fact pattern has produced elsewhere (up to $200M).
3. Before activation, Mason (and ideally the attorney) reviews the actual
   shadow-mode exclusion log against Hampton Roads demographic/historical
   redlining data for a disparate-impact pattern — not just confirming the
   log works, confirming what it shows.
4. The 7-day minimum extends if real usage volume during that window is too
   low to support the pattern check in point 3.
5. **Update, same day — partially addressed, not closed.** Jarvis has
   offered an explanation for the "confirmed by Jason" text Neo found in
   `schema.md`: that it was Jarvis's own real-time documentation edit during
   the live conversation, not external or unknown-author content (see "On
   Neo's refusal," point 1, above). I checked git history for both files and
   found neither is under version control (`projects/map/` is entirely
   untracked), so there's no independent way to confirm or refute this — the
   explanation stands on Jarvis's word alone, same epistemic status as
   everything else relayed in this review. That's enough to remove "we don't
   know how this text got here, full stop" as an open mystery, but it is
   **not** the direct, Neo-verifiable confirmation Neo actually asked for.
   Before treating this project's documents as a reliable record going
   forward: (a) bring `projects/map/docs/*.md` under version control so
   future edits carry a real author/timestamp instead of relying on anyone's
   memory of who wrote what, and (b) have Jason state the substantive
   approvals (attorney sign-off, the safety-concern code) directly, in a form
   Neo and Asimov can see without Jarvis as the sole relay — per the
   recommendation already in Section 2 and "On Neo's refusal."

Once all five are satisfied, this comes back to Asimov for the actual
activation gate per GOVERNANCE.md's Rule 7/Rule 6 pipeline (step 17,
"ASIMOV ACTIVATE" — hard gate before status → active) — this document is not
that gate, it's the pre-build check.
