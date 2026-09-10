# Repository review — 10 September 2026

## Assessment

Keep the buildless site, plain JavaScript and Supabase architecture. They fit an office
leaderboard well. The recent overhaul established useful boundaries: pure ranking and
history helpers, one data-access layer, database-enforced authorization, isolated fixtures,
and a deployment gate that runs Postgres/RLS tests. A framework or new backend would add
maintenance without addressing the defects found here.

The highest-value work is reliable display behavior, consistent data rules and preserving
history. This review implements the local display and controller fixes below. Database
follow-ups are recommendations; no production data, migrations or deployments were changed.

## Implemented

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

## Recommended follow-ups, in order

### 1. Match database validation to exercise units

`js/lifts.js` requires whole repetitions and seconds. In
`supabase/migrations/0005_governance_hardening.sql`, `propose()` accepts one decimal for
all exercises; `validate_athlete_values()` accepts arbitrary extra-lift decimal precision
within the numeric range. A direct request can store 12.5 pull-ups, which the UI displays
rounded while ranking by the underlying value.

Add a data-preserving migration with unit validation shared by both write paths. Define
how SQL exercise metadata stays aligned with the JavaScript registry. Audit existing
fractional values before tightening constraints; do not silently round historical records.
Test RPC and direct admin writes for time, reps and kilograms.

### 2. Preserve history during roster maintenance

`supabase/schema.sql` cascades proposal deletion from both athletes and proposer profiles.
Deleting an athlete removes their approved PR history; deleting a proposer profile also
removes their proposals. Direct admin record edits are not logged as progression.

Decide the retention policy before changing the schema. An archived athlete flag would
preserve records while removing the person from current boards. A durable change log could
distinguish verified PRs from admin corrections. Account erasure needs deliberate handling.
Exercise a restore in an isolated database: the daily backup contains public tables,
not the full Auth system.

### 3. Protect the last working administrator

`renderUsers()` permits removing one's own admin flag or blocking one's own account.
The profile-update policy checks current admin authority but does not ensure another
unblocked administrator remains. An accidental edit can leave the UI without an admin
and require database intervention.

Enforce any last-admin invariant in a serialized database operation, with UI feedback.
A browser-only check would miss concurrent changes or direct requests. Test self-demotion,
blocking and simultaneous role changes.

### 4. Add browser geometry checks to CI

Node and LinkeDOM tests cannot detect CSS overflow. Add a small development-only browser
suite against the existing fixtures: assert rank and score containment, row reachability
across TV pages, and no horizontal overflow at the dimensions below. Keep screenshots as
diagnostics rather than pixel-perfect comparisons of marker fonts and SVG filters.

### 5. Refactor and scale when the feature set needs it

`js/app.js` still owns forms, rendering, refresh coordination and TV paging. A future
display feature is a sensible time to extract a display controller with a small lifecycle
API. Preserve the `Lifts`, `HistoryView` and `Store` boundaries. Consolidate layered CSS
overrides as components are touched rather than restyling the whole application.

Store collection reads use one response per query without pagination. Before history or
membership approaches the configured API response limit, add explicit paging with stable
ordering. If more achievements or cardio exercises create multiple vertical rows of cards,
add card pagination: current TV paging handles athlete rows within each card, not an
unbounded number of cards.

## Verification and limits

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
