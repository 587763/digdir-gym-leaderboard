# Repository reviews — September 2026

## 30 September 2026: quality pass

A whole-codebase pass on maintainability, bugs, UI polish and reliability, keeping the
buildless whiteboard spirit. Migration 0006 was applied to production through the SQL Editor
on 30 September (pre- and post-checks: row counts unchanged, every object present, the API
exposes `withdraw`); no rows were rewritten.

### Structure
- `js/app.js` (1,056 lines, every concern) was split: `ui.js` (safe templates, dialogs,
  toasts), `board.js` (pure board rendering), `tv.js` (display controller), `app.js`
  (state, refresh, actions, forms). A single `data-action` dispatcher replaced the mix of
  `onclick` assignments, listeners and per-method error handling.
- `UI.html` escapes every interpolation by default, so markup is safe unless code opts out
  with `UI.raw()`. Every board view has an XSS regression test.
- One exercise registry (`EXERCISES`) now includes the main lifts, so boards and form fields
  are generated instead of being hard-coded in three places.
- Native `<dialog>` replaced hand-rolled modal plumbing (focus trap, inert page, Escape).
- `styles.css` merged a base layer and a later override layer (15 components defined twice)
  into one rule set per component.
- Refactor safety net: computed styles and geometry of every element across 44 states
  (desktop, tablet, phone, four TV sizes, all fixtures, tabs and dialogs) were identical
  before and after the CSS consolidation, and all board states were identical after the JS
  restructure.

### Bugs fixed
| Defect | Fix |
| --- | --- |
| A screen cycling between pages faster than the dwell never left the first tab: showing the page restarted the full dwell. | Hiding pauses and showing resumes the remaining dwell, including the countdown bar. |
| One hung request froze all later refreshes while the status still said "Live". | Reads time out after 20 s, show the error and Retry, and later refreshes start fresh. |
| iPhone number pads have no colon, but time fields asked for `m:ss`; `130` silently meant 2:10. | Decimal keypad, `m.ss`/`m,ss` accepted, and a live "= 2:10" preview under the field. |
| Drag-selecting text and releasing over the backdrop closed a dialog and lost edits. | Backdrop clicks close only when the press also started on the backdrop. |
| Realtime re-renders dropped keyboard focus to `<body>`. | Focus moves to the re-rendered control on the same board, or its dialog when it disappears. |
| A cleared entry (a verified 0) was plotted as a result; faster runs plotted downward. | Clears are noted, not plotted; better results always plot higher. |
| Failed member edits left checkboxes and selects showing unsaved values. | The list re-renders from saved data after a failure. |
| Admins could demote or block themselves; nothing kept a working admin. | UI disables self-demotion; a serialized database trigger keeps one working admin. |
| Table empty states were right-aligned; long names wrapped centered with orphaned badges. | Both align like the rest of the table. |
| ⏳ pending markers never showed for podium athletes. | Podium names show pending and fresh markers. |
| Per-row buttons were indistinguishable to screen readers; success toasts were likely silent. | Contextual labels ("Approve Bench Press PR for Ada"); a persistent live region. |
| Extra-exercise precision was unchecked in SQL (12.5 push-ups via a direct request). | 0006 validates by unit on both write paths; a test keeps SQL aligned with the registry. |
| (Found in review of this pass) Relative times ("just now", 🔥) never aged without a data change; `?tabs=` began on an excluded tab; the Latest feed hid load errors. | Refreshes compare against what is on screen, including time labels; the TV starts on a chosen tab; Latest reports failures like other boards. |

### Features and polish
- **Latest** tab: newest verified PRs with their improvement; 🔥 on boards for PRs verified in
  the last week; a celebration banner (big on the TV) for PRs verified while watching.
- **Withdraw** your own pending request (0006 `withdraw()`); proposers see what is pending.
- Review queue shows previous → new values with the change, who and when, and marks
  outdated requests (the record changed after submission) so only Reject is offered.
- Members list: pending first, "you" chip, pending claims shown next to the member.
- Athletes list: search, and only the records an athlete actually has.
- Shareable tab links (`#cardio`), `?tabs=` for the TV rotation, a highlighter on your
  own rows, clickable Hall of Fame names, badge cards on the TV Hall of Fame.
- Compact phone header (the first board starts ~110px higher), no tab scrollbar, and
  grouped form sections instead of a "peer verify" tag on every field.
- Defense in depth: a Content-Security-Policy, explicit column selects (production carries
  an unused legacy `updated_by` column), `decided_by` set null when a reviewer is deleted.

### Verification
- 74 Node tests (was 42): 52 frontend/UI and 22 Postgres/RLS, including every fix above.
- `npm run test:browser`: 100 checks in real Chrome across 6 screen sizes, all tabs, fixtures
  and dialogs, plus focus across a re-render. Mutation-tested: oversized scores, a too-wide
  board, broken TV row hiding and unscoped focus restoration each fail it; taller TV rows pass
  because paging adapts, as it should.
- An independent review replayed the production schema history (the original 2025 schema,
  0001–0005, then 0006 twice) in PGlite: 0006 applies cleanly and keeps the legacy column.
- Against the live backend at `localhost:3000` (anonymous reads + realtime), the CSP produces
  no console errors in normal, TV and deep-link modes.
- Keyboard: Enter opens a progression, Tab stays inside the dialog, Escape closes it and
  focus returns to the name.

Not exercised: production sign-in and writes, applying 0006 to the live database, the
physical office TV, and Safari/Firefox (checks ran in Chromium).

### Remaining follow-ups
0. **Backups stopped on 30 August**: GitHub disabled the scheduled backup workflow after 60
   days without commits, and it stays disabled until someone enables it again (Actions tab).
   Consider a keepalive so a quiet repository can't silently stop the backups again.
1. **History retention** (unchanged from below): deleting an athlete still deletes their
   verified history. Decide the retention policy, then consider archiving athletes.
2. **Make the browser job required** once it has proven stable in CI.
3. **Agent permissions**: `.claude/settings.json` still allows `mcp__Claude_Preview__*` tools,
   which were renamed (`mcp__Claude_Browser__*`). Update if you want those pre-approved.
4. **Database cleanup** after confirming nothing external uses them: the unused legacy
   `athletes.updated_by` column and the unused `is_active_linked()` function.

---

## 10 September 2026: display and reliability review


### Assessment

Keep the buildless site, plain JavaScript and Supabase architecture. They fit an office
leaderboard well. The recent overhaul established useful boundaries: pure ranking and
history helpers, one data-access layer, database-enforced authorization, isolated fixtures,
and a deployment gate that runs Postgres/RLS tests. A framework or new backend would add
maintenance without addressing the defects found here.

The highest-value work is reliable display behavior, consistent data rules and preserving
history. This review implements the local display and controller fixes below. Database
follow-ups are recommendations; no production data, migrations or deployments were changed.

### Implemented

| Finding | Change |
| --- | --- |
| At a 2400×1350 CSS viewport (1080p at 80% browser zoom), the old bronze step was 42px tall but its rank line box was about 75px. | Steps and text share rem sizing, explicit line-height, padding and a minimum height. Text is not clipped to conceal overflow. |
| Fixed table columns do not grow with TV typography; headings collide and large totals overflow. | Columns scale with text; combined totals have additional room. |
| The 760px podium cutoff ignores long medalist names and actual available height. | TV fitting measures space and uses a complete ranked table when podiums prevent up to two remaining rows from fitting. Podiums return when space allows. |
| Large rosters divide 15 seconds into unreadable page flashes. | Five-second minimum for later pages; double dwell on page one. Large rosters extend the requested tab duration. Opening a dialog stops the timer; closing it starts a fresh dwell. |
| Unattended displays depend on realtime reconnection or focus to recover, while TV hides the connection notice. | Visible pages reconcile every minute and refresh on the browser's online event. TV exposes connection trouble and Retry. Unchanged responses preserve controls and open history. |
| Decimal addition can assign different ranks to equal combined totals. | Weights sum in integer tenths before conversion back to kilograms. |
| Linking a blocked member silently resets their status. | Link edits preserve blocked status; Unblock remains explicit. |
| An unbroken athlete name can widen Hall of Fame cards past a phone viewport. | Cards respect their container width and wrap names. |

The new `layout` fixture exercises long podium names and maximum scores. TV fixture labels
occupy the footer so the diagnostic banner no longer distorts available board height.

### Recommended follow-ups, in order

Status on 30 September: 1, 3, 4 and 5 are done (see above); 2 remains.

#### 1. Match database validation to exercise units

`js/lifts.js` requires whole repetitions and seconds. In
`supabase/migrations/0005_governance_hardening.sql`, `propose()` accepts one decimal for
all exercises; `validate_athlete_values()` accepts arbitrary extra-lift decimal precision
within the numeric range. A direct request can store 12.5 pull-ups, which the UI displays
rounded while ranking by the underlying value.

Add a data-preserving migration with unit validation shared by both write paths. Define
how SQL exercise metadata stays aligned with the JavaScript registry. Audit existing
fractional values before tightening constraints; do not silently round historical records.
Test RPC and direct admin writes for time, reps and kilograms.

#### 2. Preserve history during roster maintenance

`supabase/schema.sql` cascades proposal deletion from both athletes and proposer profiles.
Deleting an athlete removes their approved PR history; deleting a proposer profile also
removes their proposals. Direct admin record edits are not logged as progression.

Decide the retention policy before changing the schema. An archived athlete flag would
preserve records while removing the person from current boards. A durable change log could
distinguish verified PRs from admin corrections. Account erasure needs deliberate handling.
Exercise a restore in an isolated database: the daily backup contains public tables,
not the full Auth system.

#### 3. Protect the last working administrator

`renderUsers()` permits removing one's own admin flag or blocking one's own account.
The profile-update policy checks current admin authority but does not ensure another
unblocked administrator remains. An accidental edit can leave the UI without an admin
and require database intervention.

Enforce any last-admin invariant in a serialized database operation, with UI feedback.
A browser-only check would miss concurrent changes or direct requests. Test self-demotion,
blocking and simultaneous role changes.

#### 4. Add browser geometry checks to CI

Node and LinkeDOM tests cannot detect CSS overflow. Add a small development-only browser
suite against the existing fixtures: assert rank and score containment, row reachability
across TV pages, and no horizontal overflow at the dimensions below. Keep screenshots as
diagnostics rather than pixel-perfect comparisons of marker fonts and SVG filters.

#### 5. Refactor and scale when the feature set needs it

`js/app.js` still owns forms, rendering, refresh coordination and TV paging. A future
display feature is a sensible time to extract a display controller with a small lifecycle
API. Preserve the `Lifts`, `HistoryView` and `Store` boundaries. Consolidate layered CSS
overrides as components are touched rather than restyling the whole application.

Store collection reads use one response per query without pagination. Before history or
membership approaches the configured API response limit, add explicit paging with stable
ordering. If more achievements or cardio exercises create multiple vertical rows of cards,
add card pagination: current TV paging handles athlete rows within each card, not an
unbounded number of cards.

### Verification and limits

Reviewed UI/controller code, CSS, ranking, avatars, achievements, history, Store/auth/realtime,
current schema and governance upgrade, earlier migration structure, fixtures/tests,
local server, deployment/backup workflows and documentation.

All 42 regression tests pass, and browser console checks reported no warnings or errors.
Added regression coverage for decimal ties, measured TV fallback/restoration, readable
dwell, periodic refresh, unchanged DOM preservation and blocked link edits. The existing
suite also covers RLS, stale PR decisions, auth races and migration compatibility.

Browser verification uses in-memory fixtures in the Chromium-based in-app browser:

| Case | Checked |
| --- | --- |
| 1920×1080 TV | Podium containment, score columns and paging |
| 2400×1350 effective viewport | Geometry corresponding to 1080p at 80% zoom |
| 1280×720 TV | Complete ranked tables and visible rows within the frame |
| 3840×2160 TV | Large text, podium containment and paging |
| 1440×1000 desktop | Member submission, management dialog and keyboard focus return |
| 390×844 phone | Long names and horizontal containment |
| All five tabs with long names and maximum scores | Measured fallback and score containment |
| Progression dialog in TV mode | History points, stopped countdown and restart after Escape |
| Empty and error fixtures | Empty states, visible TV error and Retry |

This checks effective layout dimensions, not the physical office television or Chrome's
zoom control on that machine. Production sign-in, a real network outage/reconnection and
backup restoration were not exercised against the live service. Geometry checks and
screenshots here are manual browser verification, not yet a browser CI gate.
