# CLAUDE.md — agent guide: digdir-gym-leaderboard

Office gym leaderboard: public PRs, podiums, peer verification, achievements and progression.
Live: https://587763.github.io/digdir-gym-leaderboard/ · Origin: `587763/digdir-gym-leaderboard`.

## Non-negotiables
- Buildless static site; no backend, framework or npm runtime dependencies. Supabase is a
  pinned CDN script with SRI. Node and dev dependencies are only for local tooling/tests.
- Classic scripts, in order: config → ui → achievements → lifts → avatar → store → history →
  board → tv → app. Public globals: `LEADERBOARD_CONFIG`, `UI`, `ACHIEVEMENTS`/`getAchievement`,
  `EXERCISES`/`Lifts`, `renderAvatar`, `Store`, `HistoryView`, `BoardView`, `TvDisplay`, `app`.
  Classic scripts keep `?v=` cache-busting coordinated on GitHub Pages (ES modules would need
  a version on every import). A new script needs a tag, the dev-server allowlist and tests.
- Build markup with the `UI.html` tagged template: it escapes every interpolation unless the
  value is itself `html`/`UI.raw()` output. Never concatenate user text into markup.
- All Supabase access belongs in `js/store.js`. Authorization belongs in Postgres RLS + RPCs;
  UI gating is cosmetic. Never reintroduce GitHub-org gating (the org restricts OAuth apps).
- After changes: remove dead code and stale references, update this guide and README, run
  `npm test` and `npm run test:browser`, then check the page in a browser (screenshots, console).
- Commit/push only when asked; never directly to main. Use a branch and PR. For GitHub writes,
  prefix `gh` with `env -u GH_TOKEN` (the environment token is read-only; keyring token can write).

## Files
- `index.html`: tabs, native `<dialog>` markup, empty board containers (`data-board-group`),
  a Content-Security-Policy meta tag, the CDN pin and local asset version (`?v=3.1.0`). Bump
  every `?v=` together when deploying coordinated JS/CSS changes. No inline styles or scripts:
  the CSP forbids them (the fixture store uses a constructed stylesheet).
- `styles.css`: one rule set per component in page order, then responsive rules, then TV mode.
  Whiteboard theme, marker lettering, stick figures.
- `js/ui.js`: `UI.html`/`raw`/`escapeHtml`; `UI.dialogs` (showModal, backdrop close that ignores
  drag-selections, focus restore to the trigger or its re-rendered twin on the same board); `UI.keepFocus` for
  re-renders; toasts (live region per dialog, since modals sit in the top layer); dates.
- `js/lifts.js`: `EXERCISES` registry (main lifts are fixed columns, the rest live in the
  `lifts` JSONB map) and pure `Lifts` rules: parse/format/rank/value/improves. Numeric-string
  totals summed in tenths, competition ranks (1, 1, 3), zero means no entry. Times accept
  `m:ss`, `m.ss`/`m,ss` (phone keypads) or whole seconds; invalid input returns `NaN`.
- `js/avatar.js`: deterministic name-derived SVG figures; `{ decorative: true }` hides a
  figure from screen readers when its name is visible next to it.
- `js/store.js`: auth, reads (explicit columns), governed writes, admin writes and realtime.
  Errors propagate; admin writes select a row so RLS-denied no-ops cannot appear successful.
  Athlete edits compare the opening `updated_at` value to reject concurrent edits. Auth
  callbacks defer consumers with `setTimeout` to avoid re-entering Supabase's auth lock.
- `js/history.js`: pure `HistoryView`; approved PRs per exercise, plotted on elapsed time with
  better results always higher. A verified 0 (cleared entry) is noted, not plotted; admin
  corrections are called out when the board differs from the last verified value.
- `js/board.js`: pure `BoardView` for boards, podiums, medals, the Latest feed and the Hall of
  Fame. Markers: ⏳ pending change, 🔥 PR verified in the last 7 days, highlighter on your rows.
- `js/tv.js`: `TvDisplay` rotation, dwell, podium/Hall of Fame fitting and paging.
- `js/app.js`: controller: state, serialized/coalesced refreshes with a 20 s read timeout,
  identity generation checks, one delegated `data-action` dispatcher (`runAction` marks async
  controls busy and toasts errors), forms generated from the registries, dialogs, review,
  members and athletes. Reconciles every 60 s while visible and on online/focus. A refresh
  re-renders only when what it would draw differs from what is shown (`boardSnapshot()`,
  including relative-time labels), so unchanged refreshes preserve focused controls and open
  dialogs while "just now" still ages. `app.ready` resolves after init.
- `supabase/schema.sql`: destructive fresh-install schema + seed. Never run against production.
- `supabase/migrations/`: hand-applied live upgrades. 0001 superseded; 0002 governance;
  0003 extra lifts; 0004 public history; 0005 validation and decision hardening; 0006 member
  safeguards (withdraw, last admin, unit validation, reviewer FK, recent-PR index).
- `scripts/dev-server.mjs`: Node static allowlist server, no caching, localhost only. Does not
  serve `.env`, `.git`, SQL or arbitrary workspace files. `PORT` overrides 3000.
- `scripts/browser-check.mjs`: zero-dependency layout checks in local Chrome over the DevTools
  protocol (`CHROME=` overrides detection). Asserts no horizontal overflow, scores inside their
  boards, TV never scrolls and every ranked row renders on screen on some page, dialogs open
  cleanly, table text stays in its cells, the selected tab is visible, focus survives a
  re-render, and a quiet console. Assert containment, not pixels (fonts differ by machine).
- `tests/`: Node tests, LinkeDOM UI tests (with `<dialog>` and innerHTML shims in helpers),
  PGlite Postgres/RLS tests, isolated browser fixtures (`tests/browser-store.js`).
- `.github/workflows/deploy.yml`: tests PRs and main; deploys main only after `npm test` passes.
  A separate `browser` job runs the layout checks and does not gate deploys yet.
- `.github/workflows/backup.yml`: daily table dumps, 90-day workflow artifacts; each run
  re-enables the workflow so GitHub's 60-day inactivity rule cannot pause it.
- `.claude/launch.json`: local preview server named `leaderboard`.

## Run and verify
```
npm run dev                 # Node >=22, http://localhost:3000; no install needed
npm ci                      # development-only test dependencies
npm test                    # no credentials, external DB or browser needed
npm run test:browser        # needs Chrome; starts its own server on port 3100
```
Browser checks: desktop, 390px phone, TV at 1080p and 720p; tabs, progression, forms, errors,
keyboard focus/Escape, no console errors. Missing config/CDN leaves usable tabs and an
explanation instead of crashing. Refresh failures preserve the last board and expose Retry.

Local-only fixtures: `/?fixture=admin` (signed-in admin with a pending PR, a pending member
claim and a blocked member), `empty`, `error`, `large` (65 athletes), or `layout` (long
medalist names and maximum scores). TV fixture labels do not consume board height. The dev
server replaces Store with `tests/browser-store.js` and removes the Supabase CDN script.
Writes stay in memory. Use `?fixture=large&tv&rotate=120` for TV layout inspection.
Fixture controls/data are never included in the deployed artifact.

## Data and governance
- `athletes`: name; fixed bench/squat/deadlift kg columns; `lifts` JSONB extra-exercise map;
  achievements text array; reserved avatar JSONB; timestamps. (Production also carries an
  unused legacy `updated_by` column; the app selects explicit columns.)
- `profiles`: GitHub identity, is_admin, status (pending/active/blocked), unique athlete link.
- `proposals`: claim/new_athlete/rename/pr/achievement, admin/peer approval, payload, proposer,
  pending/approved/rejected status and decision timestamps. Approved PRs are public history
  and feed the Latest tab; remaining proposals and profiles are member-readable.
- Active linked members propose changes to their own athlete. Another linked member or an
  admin verifies PRs/achievements; admins can resolve their own requests. Claims, new athletes
  and renames need an admin. Blocked accounts have no write authority, even if is_admin is true.
- `propose()` validates payloads by exercise unit (`lift_allows_decimals()`: kg one decimal,
  reps and seconds whole), rejects unchanged values, and serializes per-user submissions to
  deduplicate retries. PR payloads include a server-owned `previous_value`. `decide()` locks
  the proposal, rechecks the proposer's eligibility and rejects stale PRs after a record changes.
- `withdraw()` lets an unblocked proposer retract their own pending request (recorded as a
  rejection they decided). A trigger keeps at least one working admin (serialized with an
  advisory lock); the UI also disables self-demotion and self-blocking.
- Names: trimmed, 1–80 characters. Scores: 0–99999. Zero clears an entry through the same
  verification process. A trigger also checks direct admin athlete writes, including JSONB.
- Deleting a reviewer keeps the requests they decided (`decided_by` is set null). Deleting an
  athlete still deletes their proposals, including verified history (see REVIEW.md).
- Bootstrap admin is GitHub login `587763`, only with GitHub provider metadata. Missing login
  metadata creates an ordinary pending profile.

## TV / display mode
Enable with `?tv` or the header toggle (hidden on phones). State is persisted defensively in
`localStorage['lb.tv']`. `?rotate=<seconds>` sets a 5–120 s target budget per tab, default 15.
`?tabs=lifts,total` limits the rotation (the display starts on a chosen tab and never pages
through others); empty tabs (e.g. Latest with no PRs) are skipped.
Multi-page tabs give page one double the dwell of later pages. Later pages get at least 5 s
(page one 10 s), extending the target for large rosters; a single page still respects 5 s.
Opening a dialog stops rotation and closing it starts a fresh dwell. Hiding the page pauses
it and showing it resumes the remaining dwell, so a screen that cycles between several pages
still advances. A PR verified while the board is open gets a celebration banner.
- Every board has a podium in normal mode. Equal scores share a medal position; groups of
  more than six medalists use the full ranked table. TV below 760px high also uses tables.
  Above that cutoff, `fit()` measures podiums and switches to complete tables if there is
  insufficient room for up to two ranked rows. The Hall of Fame shows badge cards unless they
  overflow, then paged tables three names per row. Reconsider after refits.
- `fit()` measures each row, including wrapped names; `partitionRows` packs rows into pages;
  `applyPage` toggles `hidden` and page dots. Smaller boards pin to their final page.
  `TvDisplay.PAGE_PAD` reserves 48px for the dots.
- Refits after render, tab switches, fonts loading and resize; changing page counts restarts
  the rotation clock so late data does not leave a stale countdown.
- Connection warnings and Retry remain visible in the TV footer reserve.

## Extending
- Achievement: add to `ACHIEVEMENTS`; forms, badges and Hall of Fame follow automatically.
- Extra exercise: add to `EXERCISES` with id/label/emoji/unit (`kg`, `reps`, `time`) and group
  `other` or `cardio`. `lowerIsBetter: true` ranks smaller positive values first. Boards, forms,
  history and the Latest feed follow. No schema change for reps/time; a `kg` extra exercise
  must also be listed in SQL `lift_allows_decimals()` via a migration (a test enforces this).
- Main lift: requires a fixed column, a migration, and the registry entry with group `main`.
- Preserve unknown extra-lift keys and unregistered achievements on admin edits; My PRs
  must not remove achievements absent from the form.
- New board tab: a tab button + panel with `data-board-group` in `index.html`, a group in
  `BoardView.group()`, and `hasContent()` in app.js if it can be empty.

## Database upgrades and deployment
Apply migrations in order through the Supabase SQL Editor before deploying the frontend that
needs them. 0006 is transactional and idempotent, rewrites no rows, and stops with a named
athlete if any stored value breaks its unit. The frontend works without 0006 except Withdraw,
which reports that it is unavailable. Tests execute migrations in local Postgres (PGlite).

For a live upgrade: paste the numbered migration into Supabase SQL Editor, or use a SQL
client that supports multi-statement transactions. Never use `supabase db push`: the
hand-numbered files are not in the CLI migration ledger and it would replay superseded 0001.
The installed `supabase db query -f` sends one prepared statement and cannot execute these
multi-statement migrations as-is; use the SQL Editor instead of splitting a transaction.

Production DB URL is in the gitignored `.env`, with spaces around `=`. Do not source it or
print credentials. Config in `js/config.js` is a safe publishable key; never commit a
service-role/secret key. Supabase project ref: `hqrqmkherwdkfvhjypuk`.
Auth redirects allow localhost:3000 and the Pages URL. A new serving origin needs an Auth
URL Configuration entry and must satisfy the CSP (`connect-src` allows `*.supabase.co`).
Use port 3000 for real sign-in; fixtures work on any local port.

CDN upgrade: bump the pinned supabase-js version and recompute SHA-384 on the exact UMD
file. Never use the floating `@2` URL (CDN minification can invalidate SRI).

## Backups and icons
Daily backup uses `SUPABASE_DB_URL` Actions secret and fails clearly if missing. GitHub pauses
scheduled workflows after 60 days without commits (it did on 2026-08-30); the keepalive step
prevents that, but a paused workflow must be re-enabled by hand (Actions tab or
`env -u GH_TOKEN gh workflow enable backup.yml`). Check `gh run list --workflow backup.yml`
before risky database work. Dumps cover
public athletes/profiles/proposals only; they are not complete Supabase/Auth backups. Restoring
requires compatible functions, roles and matching auth.users IDs. Never commit dumps.

`favicon.svg` is the mark; theme-color is `--whiteboard` (#fbfbf8). The 180px iOS icon is a
full-bleed variant of it. Regenerate via macOS `qlmanage -t -s 1024` on a full-bleed SVG, then
`sips -z 180 180` on the PNG; no ImageMagick required.
